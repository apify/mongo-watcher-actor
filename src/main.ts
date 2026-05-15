import { rm } from 'node:fs/promises';

import { Actor, log } from 'apify';
import OpenAI from 'openai';

import { analyzeFile } from './analyze.js';
import { downloadLogFiles } from './download_logs.js';
import { evalFunctionOrThrow } from './filter_function.js';
import { fetchGithubIssues } from './fetch_github_issues.js';
import { runMcpAgent } from './mcp_agent.js';
import { createMcpClient } from './mcp_client.js';
import { analysisSystemPrompt, analysisUserPrompt, integrationSystemPrompt, integrationUserPrompt } from './prompts/index.js';

await Actor.init();

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
    githubMcpConnector: string,
    githubRepository: string,
};

const input = await Actor.getInput() as InputType;
const { nodes, time_period, filter_function, indexes, ...env } = input;

log.info('Input received', {
    nodes,
    time_period,
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

const githubMcp = await createMcpClient(APIFY_MCP_PROXY_URL, input.githubMcpConnector, APIFY_TOKEN);

try {
    const snapshot = await time('Phase 3/5: GitHub bootstrap (existing slow-query issues)', async () => fetchGithubIssues({
        githubMcp,
        githubRepository: input.githubRepository,
    }));
    const snapshotJson = JSON.stringify(snapshot, null, 2);
    await Actor.setValue('existing_findings.json', snapshotJson, { contentType: 'application/json' });

    const analysisFindingsJson = JSON.stringify({
        owner: snapshot.owner,
        repo: snapshot.repo,
        findings: snapshot.findings.map(({ id, title, query_hashes, updated_at }) => (
            { id, title, query_hashes, updated_at }
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

    // Only the hash-rooted slow-query findings flow into GitHub issues. The
    // non-query report is a human-readable companion and is intentionally
    // dropped here so operational issues don't pollute the tracker.
    const integrationAttachments = analysisFiles.filter((f) => f.name === 'slow_query_analysis.md');
    if (integrationAttachments.length === 0) {
        log.warning('No slow_query_analysis.md found in analysis output — falling back to raw analysis response.');
        integrationAttachments.push(...analysisFiles);
    }

    const { text: integrationResponse } = await time('Phase 5/5: Claude integration agent (GitHub issues)', async () => runMcpAgent({
        openai,
        model: 'anthropic/claude-sonnet-4.6',
        system: integrationSystemPrompt(input.githubRepository),
        prompt: integrationUserPrompt(time_period),
        attachments: [
            ...integrationAttachments,
            { name: 'indexes.json', text: indexesJson },
            { name: 'existing_findings.json', text: snapshotJson },
        ],
        clients: { github: githubMcp },
        allowedTools: {
            github: [
                'issue_write',
                'add_issue_comment',
                'issue_read',
            ],
        },
    }));

    await Actor.setValue('integration_response.txt', integrationResponse, { contentType: 'text/plain' });
    log.info(`Integration response saved to KV (${integrationResponse.length} chars)`);
} finally {
    await githubMcp.close();
}

await Actor.exit();
