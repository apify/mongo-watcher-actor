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

/** Extract plain text from an MCP tool result. */
function mcpResultToText(result: Awaited<ReturnType<Client['callTool']>>): string {
    const content = result.content as { type: string; text?: string }[] | undefined;
    if (!content) return '';
    return content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
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
    const { openai, model, prompt, attachments, clients, allowedTools, system, reasoning, maxSteps = 12, toolTimeoutMs = 5 * 60 * 1000 } = opts;
    const { tools, dispatch } = await buildToolRegistry(clients, allowedTools);

    const clientCount = Object.keys(clients ?? {}).length;
    if (tools.length && clientCount) {
        log.info(`Agent armed with ${tools.length} tools across ${clientCount} MCP servers`);
    } else {
        log.info(`Agent will run without any tools`);
    }

    const userContent: OpenAI.Responses.ResponseInputContent[] = [{ type: 'input_text', text: prompt }];
    for (const att of attachments ?? []) {
        userContent.push({
            type: 'input_text',
            text: `<attachment name="${att.name}">\n${att.text}\n</attachment>`,
        });
    }
    const input: ResponseInputItem[] = [{ role: 'user', content: userContent }];

    for (let step = 0; step < maxSteps; step++) {
        const response = await openai.responses.create({
            model,
            instructions: system,
            input,
            tools: tools.length ? tools : undefined,
            tool_choice: tools.length ? 'auto' : undefined,
            reasoning: reasoning as OpenAI.Responses.ResponseCreateParams['reasoning'],
        });

        // Append every output item from this turn back into input so the
        // model sees its own previous output (and tool calls) on the next call.
        for (const item of response.output) {
            input.push(item as ResponseInputItem);
        }

        const functionCalls = response.output.filter(
            (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call',
        );

        if (functionCalls.length === 0) {
            // Model produced a final answer
            return { text: response.output_text ?? '', input };
        }

        // Execute every tool call this turn (model may issue several in parallel)
        for (const call of functionCalls) {
            const entry = dispatch.get(call.name);
            log.info(`Tool call: ${call.name}`);

            if (!entry) {
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
                input.push({
                    type: 'function_call_output',
                    call_id: call.call_id,
                    output: `Error parsing arguments: ${(e as Error).message}`,
                });
                continue;
            }

            try {
                const result = await entry.client.callTool(
                    { name: entry.toolName, arguments: args },
                    undefined,
                    { timeout: toolTimeoutMs },
                );
                const text = mcpResultToText(result) || '(empty result)';
                input.push({
                    type: 'function_call_output',
                    call_id: call.call_id,
                    output: text.slice(0, 200_000), // guard against giant results
                });
            } catch (e) {
                input.push({
                    type: 'function_call_output',
                    call_id: call.call_id,
                    output: `Tool error: ${(e as Error).message}`,
                });
            }
        }
    }

    return { text: 'Max steps reached without a final answer', input };
}
