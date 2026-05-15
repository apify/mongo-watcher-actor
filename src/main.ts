// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { rm } from 'node:fs/promises';

import { Actor, log } from 'apify';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import OpenAI from 'openai';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { analyzeFile } from './analyze.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { downloadLogFiles } from './download_logs.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { evalFunctionOrThrow } from './filter_function.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { fetchNotionEntries, renderFindingsPage, type NotionEntry, type NotionSnapshot } from './fetch_notion_entries.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { runMcpAgent } from './mcp_agent.js';
import { createMcpClient } from './mcp_client.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { analysisSystemPrompt, analysisUserPrompt, integrationSystemPrompt, integrationUserPrompt } from './prompts/index.js';

await Actor.init();

// ============================================================================
// TEMPORARY: GitHub MCP tool-surface probe.
// This block replaces the normal run. Restore the commented-out logic below
// once the tool list has been captured.
// ============================================================================
{
    const { APIFY_TOKEN, APIFY_MCP_PROXY_URL } = process.env;
    if (!APIFY_TOKEN) throw new Error('Missing APIFY_TOKEN env variable');
    if (!APIFY_MCP_PROXY_URL) throw new Error('Missing APIFY_MCP_PROXY_URL env variable');

    const probeInput = await Actor.getInput() as { githubMcpConnector: string };
    log.info(`Probing GitHub MCP connector: ${probeInput.githubMcpConnector}`);

    const githubMcp = await createMcpClient(APIFY_MCP_PROXY_URL, probeInput.githubMcpConnector, APIFY_TOKEN);
    try {
        const { tools } = await githubMcp.listTools();
        log.info(`GitHub MCP exposes ${tools.length} tools:`);
        for (const t of tools) {
            const firstDescLine = (t.description ?? '').split('\n')[0].trim();
            log.info(`  • ${t.name}${firstDescLine ? ` — ${firstDescLine}` : ''}`);
        }
        await Actor.setValue(
            'github_mcp_tools.json',
            JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description })), null, 2),
            { contentType: 'application/json' },
        );
    } finally {
        await githubMcp.close();
    }

    await Actor.exit();
}

/* eslint-disable */
/*

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
    log.info(`▶ ${label}`);
    const startedAt = Date.now();
    try {
        const result = await fn();
        log.info(`✓ ${label} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
        return result;
    } catch (err) {
        log.error(`✗ ${label} failed after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
        throw err;
    }
}

function parseFindingsFromIntegrationResponse(response: string, pageId: string): NotionSnapshot {
    const match = response.match(/<file\s+name="findings\.json">([\s\S]*?)<\/file>/);
    if (!match) {
        throw new Error('Integration agent did not emit a <file name="findings.json"> block.');
    }
    let raw: unknown;
    try {
        raw = JSON.parse(match[1].trim());
    } catch (e) {
        throw new Error(`Integration agent emitted invalid JSON in findings.json: ${(e as Error).message}`);
    }
    if (!raw || typeof raw !== 'object') throw new Error('findings.json is not an object');
    const obj = raw as Record<string, unknown>;
    const rawEntries = Array.isArray(obj.entries) ? obj.entries : [];
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const entries: NotionEntry[] = rawEntries.map((row, i) => {
        if (!row || typeof row !== 'object') throw new Error(`findings.json: entry #${i} is not an object`);
        const r = row as Record<string, unknown>;
        const hashes = Array.isArray(r.query_hashes)
            ? r.query_hashes.filter((h): h is string => typeof h === 'string')
            : [];
        return {
            id: str(r.id),
            title: str(r.title),
            collection: str(r.collection),
            query_hashes: hashes,
            status: str(r.status) as NotionEntry['status'],
            priority: str(r.priority) as NotionEntry['priority'],
            action_type: str(r.action_type),
            first_seen: str(r.first_seen),
            last_seen: str(r.last_seen),
            github_issue: str(r.github_issue),
            body: str(r.body),
        };
    });
    return { page_id: pageId, entries };
}

const { APIFY_TOKEN, APIFY_MCP_PROXY_URL } = process.env;
if (!APIFY_TOKEN) throw new Error('Missing APIFY_TOKEN env variable');
if (!APIFY_MCP_PROXY_URL) throw new Error('Missing APIFY_MCP_PROXY_URL env variable');

const openai = new OpenAI({
    baseURL: 'https://openrouter.apify.actor/api/v1',
    apiKey: 'no-key-required-but-must-not-be-empty',
    defaultHeaders: { Authorization: `Bearer ${APIFY_TOKEN}` },
});

type InputType = {
    organization_id: string,
    project_id: string,
    public_key: string,
    private_key: string,
    nodes: string[],
    filter_function: string,
    time_period: number,
    indexes: Record<string, unknown>[],
    notionMcpConnector: string,
    notionPageId: string,
    githubMcpConnector: string,
    githubRepository: string,
};

const input = await Actor.getInput() as InputType;
const { nodes, time_period, filter_function, indexes, ...env } = input;

log.info('Input received', {
    nodes,
    time_period,
    notionPageId: input.notionPageId,
    githubRepository: input.githubRepository,
    indexCount: indexes.length,
});

const evaluatedFilterFunction = evalFunctionOrThrow(filter_function);

await rm('./lines.jsonl', { force: true });
await time(`Phase 1/5: download logs from ${nodes.length} node(s)`, async () => {
    for (const node of nodes) {
        await downloadLogFiles(node, time_period, env, evaluatedFilterFunction);
    }
});

const analysis = await time('Phase 2/5: analyze downloaded logs', async () => analyzeFile('./lines.jsonl'));
await Actor.setValue('analysis.txt', analysis, { contentType: 'text/plain' });

const indexesJson = JSON.stringify(indexes);

const notionMcp = await createMcpClient(APIFY_MCP_PROXY_URL, input.notionMcpConnector, APIFY_TOKEN);
const githubMcpPromise = createMcpClient(APIFY_MCP_PROXY_URL, input.githubMcpConnector, APIFY_TOKEN);
// Prevent an unhandled-rejection crash if the github open fails before we await it during the long analysis phase.
githubMcpPromise.catch(() => {});

try {
    const notionSnapshot = await time('Phase 3/5: Notion bootstrap (existing findings)', async () => fetchNotionEntries({
        notionMcp,
        pageId: input.notionPageId,
    }));
    const notionSnapshotJson = JSON.stringify(notionSnapshot, null, 2);
    await Actor.setValue('existing_findings.json', notionSnapshotJson, { contentType: 'application/json' });

    const analysisFindingsJson = JSON.stringify({
        entries: notionSnapshot.entries.map(({ id, title, collection, query_hashes, last_seen }) => (
            { id, title, collection, query_hashes, last_seen }
        )),
    });

    const { text: analysisResponse } = await time('Phase 4/5: Claude analysis agent', async () => runMcpAgent({
        openai,
        model: 'anthropic/claude-opus-4.7',
        reasoning: { enabled: true, effort: 'xhigh' },
        system: analysisSystemPrompt(),
        prompt: analysisUserPrompt(time_period),
        attachments: [
            { name: 'analysis.txt', text: analysis },
            { name: 'indexes.json', text: indexesJson },
            { name: 'existing_findings.json', text: analysisFindingsJson },
        ],
    }));

    await Actor.setValue('analysis_response.txt', analysisResponse, { contentType: 'text/plain' });

    // Contract with the analysis prompt: each output file is wrapped in <file name="...">…</file>.
    const fileBlockRegex = /<file\s+name="([^"]+)">([\s\S]*?)<\/file>/g;
    const analysisFiles: { name: string; text: string }[] = [];
    for (const match of analysisResponse.matchAll(fileBlockRegex)) {
        analysisFiles.push({ name: match[1], text: match[2].trim() });
    }
    if (analysisFiles.length === 0) {
        log.warning('No <file name="..."></file> blocks found in the analysis response — passing the raw response on instead.');
        analysisFiles.push({ name: 'analysis_response.txt', text: analysisResponse });
    }

    for (const file of analysisFiles) {
        const contentType = file.name.endsWith('.md') ? 'text/markdown' : 'text/plain';
        await Actor.setValue(file.name, file.text, { contentType });
    }

    // Only the hash-rooted slow-query findings flow into the Notion findings
    // page. The non-query report is a human-readable companion and is
    // intentionally dropped here so operational issues don't pollute the state.
    const integrationAttachments = analysisFiles.filter((f) => f.name === 'slow_query_analysis.md');
    if (integrationAttachments.length === 0) {
        log.warning('No slow_query_analysis.md found in analysis output — falling back to raw analysis response.');
        integrationAttachments.push(...analysisFiles);
    }

    const githubMcp = await githubMcpPromise;

    const { text: integrationResponse } = await time('Phase 5/5: Claude integration agent (state update + GitHub)', async () => runMcpAgent({
        openai,
        model: 'anthropic/claude-sonnet-4.6',
        system: integrationSystemPrompt(input.githubRepository),
        prompt: integrationUserPrompt(time_period),
        attachments: [
            ...integrationAttachments,
            { name: 'indexes.json', text: indexesJson },
            { name: 'existing_findings.json', text: notionSnapshotJson },
        ],
        clients: { github: githubMcp },
        allowedTools: {
            github: [
                'issue_write',
            ],
        },
    }));

    await Actor.setValue('integration_response.txt', integrationResponse, { contentType: 'text/plain' });
    log.info(`Integration response saved to KV (${integrationResponse.length} chars)`);

    const nextSnapshot = parseFindingsFromIntegrationResponse(integrationResponse, input.notionPageId);
    await Actor.setValue('findings.json', JSON.stringify(nextSnapshot, null, 2), { contentType: 'application/json' });

    await time('Phase 5/5: rewrite Notion findings page', async () => {
        const pageMarkdown = renderFindingsPage({ snapshot: nextSnapshot, runId: process.env.APIFY_ACTOR_RUN_ID });
        await notionMcp.callTool(
            {
                name: 'notion-update-page',
                arguments: {
                    page_id: input.notionPageId,
                    command: 'replace_content',
                    new_str: pageMarkdown,
                    properties: {},
                    content_updates: [],
                },
            },
            undefined,
            { timeout: 2 * 60 * 1000 },
        );
        log.info(`Notion page rewritten with ${nextSnapshot.entries.length} entries.`);
    });
} finally {
    await Promise.allSettled([
        notionMcp.close(),
        githubMcpPromise.then((c) => c.close(), () => undefined),
    ]);
}

await Actor.exit();
*/
/* eslint-enable */
