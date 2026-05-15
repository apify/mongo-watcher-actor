import type OpenAI from 'openai';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { log } from 'apify';

type ResponseTool = OpenAI.Responses.Tool;
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;

export type McpClients = Record<string, Client>; // namespace -> client

const NS_SEP = '__';

export type ToolAllowlist = Record<string, string[]>; // namespace -> allowed MCP tool names

/** Pull tools from every MCP client and build the OpenAI tool list + a dispatch map. */
async function buildToolRegistry(clients?: McpClients, allow?: ToolAllowlist) {
    const tools: ResponseTool[] = [];
    const dispatch = new Map<string, { client: Client; toolName: string }>();

    if (!clients || Object.keys(clients).length === 0) return { tools, dispatch };

    for (const [namespace, client] of Object.entries(clients)) {
        const allowed = allow?.[namespace];
        const { tools: mcpTools } = await client.listTools();

        const filtered = allowed
            ? mcpTools.filter((t) => allowed.includes(t.name))
            : mcpTools;

        // Surface misconfigured names early so you don't silently lose a capability
        if (allowed) {
            const got = new Set(filtered.map((t) => t.name));
            const missing = allowed.filter((n) => !got.has(n));
            if (missing.length) {
                throw new Error(`MCP server "${namespace}" is missing expected tools: ${missing.join(', ')}`);
            }
        }

        log.info(`MCP server '${namespace}': ${mcpTools.length} tools available, ${filtered.length} exposed to agent`);
        log.info(`MCP server '${namespace}' tool names: ${mcpTools.map((t) => t.name).join(', ')}`);

        for (const t of filtered) {
            const fqName = `${namespace}${NS_SEP}${t.name}`;
            const title = typeof t.annotations?.title === 'string' ? t.annotations.title : '';
            tools.push({
                type: 'function',
                name: fqName,
                description: t.description ?? title,
                parameters: (t.inputSchema as Record<string, unknown>) ?? {
                    type: 'object',
                    properties: {},
                },
                strict: false,
            });
            dispatch.set(fqName, { client, toolName: t.name });
        }
    }
    return { tools, dispatch };
}

type TokenUsage = {
    input: number;
    output: number;
    reasoning: number;
    total: number;
};

function extractUsage(response: OpenAI.Responses.Response): TokenUsage {
    const u = response.usage as
        | (OpenAI.Responses.ResponseUsage & { output_tokens_details?: { reasoning_tokens?: number } })
        | undefined;
    return {
        input: u?.input_tokens ?? 0,
        output: u?.output_tokens ?? 0,
        reasoning: u?.output_tokens_details?.reasoning_tokens ?? 0,
        total: u?.total_tokens ?? 0,
    };
}

/** Extract plain text from an MCP tool result. */
function mcpResultToText(result: Awaited<ReturnType<Client['callTool']>>): string {
    const content = result.content as { type: string; text?: string }[] | undefined;
    if (!content) return '';
    return content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
}

function makeLineLogger(prefix: string) {
    let buf = '';
    return {
        write(chunk: string) {
            if (!chunk) return;
            buf += chunk;
            let nl = buf.indexOf('\n');
            while (nl !== -1) {
                const line = buf.slice(0, nl).replace(/\s+$/, '');
                if (line) log.info(`${prefix} ${line}`);
                buf = buf.slice(nl + 1);
                nl = buf.indexOf('\n');
            }
        },
        close() {
            const tail = buf.replace(/\s+$/, '');
            if (tail) log.info(`${prefix} ${tail}`);
            buf = '';
        },
    };
}

export type AgentAttachment = { name: string; text: string };

export async function runMcpAgent(opts: {
    openai: OpenAI;
    model: string;
    // Passed through to the SDK; kept loose so OpenRouter-only fields (`enabled`, `xhigh`) survive type checking.
    reasoning?: Record<string, unknown>;
    prompt: string;
    attachments?: AgentAttachment[];
    clients?: McpClients;
    allowedTools?: ToolAllowlist;
    system?: string;
    maxSteps?: number;
    toolTimeoutMs?: number;
}) {
    const { openai, model, prompt, attachments, clients, allowedTools, system, reasoning, maxSteps = 30, toolTimeoutMs = 5 * 60 * 1000 } = opts;
    const { tools, dispatch } = await buildToolRegistry(clients, allowedTools);

    const clientCount = Object.keys(clients ?? {}).length;
    if (tools.length) {
        log.info(`Agent armed with ${tools.length} tools across ${clientCount} MCP server(s), model=${model}, maxSteps=${maxSteps}`);
    } else {
        log.info(`Agent will run without any tools, model=${model}, maxSteps=${maxSteps}`);
    }

    const userContent: OpenAI.Responses.ResponseInputContent[] = [{ type: 'input_text', text: prompt }];
    for (const att of attachments ?? []) {
        userContent.push({
            type: 'input_text',
            text: `<attachment name="${att.name}">\n${att.text}\n</attachment>`,
        });
    }
    const input: ResponseInputItem[] = [{ role: 'user', content: userContent }];

    const totals = { input: 0, output: 0, reasoning: 0, total: 0 };
    const agentStartedAt = Date.now();

    for (let step = 0; step < maxSteps; step++) {
        const stepStartedAt = Date.now();
        const stepLabel = `step ${step + 1}/${maxSteps}`;

        const reasoningLogger = makeLineLogger(`  💭 [${stepLabel} reasoning]`);
        const outputLogger = makeLineLogger(`  💬 [${stepLabel} output]`);
        // Some providers (e.g. OpenRouter) stream output_text deltas but leave
        // `response.output_text` empty after `finalResponse()`. Capture the
        // deltas ourselves so the caller always gets the assistant's text.
        const streamedChunks: string[] = [];

        const stream = openai.responses.stream({
            model,
            instructions: system,
            input,
            tools: tools.length ? tools : undefined,
            tool_choice: tools.length ? 'auto' : undefined,
            reasoning: reasoning as OpenAI.Responses.ResponseCreateParams['reasoning'],
        });

        try {
            for await (const event of stream) {
                switch (event.type) {
                    case 'response.created':
                        log.info(`▶ Agent ${stepLabel} streaming started`);
                        break;
                    case 'response.reasoning_summary_text.delta':
                    case 'response.reasoning_text.delta':
                        reasoningLogger.write(event.delta);
                        break;
                    case 'response.reasoning_summary_text.done':
                    case 'response.reasoning_text.done':
                        reasoningLogger.close();
                        break;
                    case 'response.output_text.delta':
                        outputLogger.write(event.delta);
                        streamedChunks.push(event.delta);
                        break;
                    case 'response.output_text.done':
                        outputLogger.close();
                        break;
                    case 'response.output_item.added':
                        if (event.item.type === 'function_call') {
                            log.info(`  🛠  [${stepLabel}] tool call starting: ${event.item.name}`);
                        }
                        break;
                    case 'response.failed':
                        log.warning(`Agent ${stepLabel} stream reported failure`, { error: event.response.error });
                        break;
                    default:
                        break;
                }
            }
        } finally {
            reasoningLogger.close();
            outputLogger.close();
        }

        const response = (await stream.finalResponse()) as unknown as OpenAI.Responses.Response;

        const usage = extractUsage(response);
        totals.input += usage.input;
        totals.output += usage.output;
        totals.reasoning += usage.reasoning;
        totals.total += usage.total;

        const functionCalls = response.output.filter(
            (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call',
        );

        const stepMs = Date.now() - stepStartedAt;
        log.info(
            `Agent ${stepLabel} done in ${stepMs}ms — tokens: `
            + `in=${usage.input}, out=${usage.output}`
            + (usage.reasoning ? `, reasoning=${usage.reasoning}` : '')
            + `, total=${usage.total}`
            + (functionCalls.length ? `, tool_calls=${functionCalls.length}` : ''),
        );

        for (const item of response.output) {
            input.push(item as ResponseInputItem);
        }

        if (functionCalls.length === 0) {
            const agentMs = Date.now() - agentStartedAt;
            log.info(
                `Agent finished after ${step + 1} step(s) in ${(agentMs / 1000).toFixed(1)}s — `
                + `cumulative tokens: in=${totals.input}, out=${totals.output}`
                + (totals.reasoning ? `, reasoning=${totals.reasoning}` : '')
                + `, total=${totals.total}`,
            );
            const finalText = response.output_text || streamedChunks.join('');
            return { text: finalText, input };
        }

        // Execute every tool call this turn (model may issue several in parallel)
        for (const call of functionCalls) {
            const entry = dispatch.get(call.name);

            if (!entry) {
                log.warning(`Tool call: ${call.name} — unknown tool, returning error to agent`);
                input.push({
                    type: 'function_call_output',
                    call_id: call.call_id,
                    output: `Error: unknown tool "${call.name}"`,
                });
                continue;
            }

            let args: Record<string, unknown> = {};
            try {
                args = call.arguments ? JSON.parse(call.arguments) : {};
            } catch (e) {
                log.warning(`Tool call: ${call.name} — failed to parse arguments`, { error: (e as Error).message });
                input.push({
                    type: 'function_call_output',
                    call_id: call.call_id,
                    output: `Error parsing arguments: ${(e as Error).message}`,
                });
                continue;
            }

            const argKeys = Object.keys(args);
            const toolStartedAt = Date.now();
            try {
                const result = await entry.client.callTool(
                    { name: entry.toolName, arguments: args },
                    undefined,
                    { timeout: toolTimeoutMs },
                );
                const text = mcpResultToText(result) || '(empty result)';
                const toolMs = Date.now() - toolStartedAt;
                log.info(
                    `Tool call: ${call.name}(${argKeys.join(', ')}) `
                    + `→ ${text.length} chars in ${toolMs}ms`,
                );
                input.push({
                    type: 'function_call_output',
                    call_id: call.call_id,
                    output: text.slice(0, 200_000), // guard against giant results
                });
            } catch (e) {
                const toolMs = Date.now() - toolStartedAt;
                log.warning(
                    `Tool call: ${call.name}(${argKeys.join(', ')}) failed after ${toolMs}ms`,
                    { error: (e as Error).message },
                );
                input.push({
                    type: 'function_call_output',
                    call_id: call.call_id,
                    output: `Tool error: ${(e as Error).message}`,
                });
            }
        }
    }

    const agentMs = Date.now() - agentStartedAt;
    log.warning(
        `Agent hit maxSteps=${maxSteps} without producing a final answer after ${(agentMs / 1000).toFixed(1)}s — `
        + `cumulative tokens: in=${totals.input}, out=${totals.output}`
        + (totals.reasoning ? `, reasoning=${totals.reasoning}` : '')
        + `, total=${totals.total}`,
    );
    return { text: 'Max steps reached without a final answer', input };
}
