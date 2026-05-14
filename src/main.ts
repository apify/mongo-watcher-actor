import { Actor, log} from 'apify';
import OpenAI from 'openai';

import { analyzeFile } from './analyze.js';
import { downloadLogFiles } from './download_logs.js';
import { evalFunctionOrThrow } from './filter_function.js';
import { runMcpAgent } from './mcp_agent.js';
import { createMcpClient } from './mcp_client.js';
import { analysisSystemPrompt, analysisUserPrompt, integrationSystemPrompt, integrationUserPrompt } from './prompts/index.js';

await Actor.init();

const API_TOKEN = process.env.APIFY_TOKEN as string;
if (!API_TOKEN) throw new Error('Missing APIFY_TOKEN env variable');

const MCP_PROXY_URL = process.env.APIFY_MCP_PROXY_URL;
if (!MCP_PROXY_URL) throw new Error('Missing APIFY_MCP_PROXY_URL env variable');

const openai = new OpenAI({
    baseURL: 'https://openrouter.apify.actor/api/v1',
    apiKey: 'no-key-required-but-must-not-be-empty',
    defaultHeaders: { Authorization: `Bearer ${API_TOKEN}` },
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
    notionDatabaseId: string,
    githubMcpConnector: string,
    githubRepository: string,
};

const input = await Actor.getInput() as InputType;

console.log(JSON.stringify(input, null, 4));

const { nodes, time_period, filter_function, indexes, ...env } = input;

const evaluatedFilterFunction = evalFunctionOrThrow(filter_function);

for (const node of nodes) {
    await downloadLogFiles(node, time_period, env, evaluatedFilterFunction);
}

console.log('Analyzing downloaded logs');
const analysis = await analyzeFile('./lines.jsonl');
await Actor.setValue('analysis.txt', analysis, { contentType: 'text/plain'});
console.log('Done');

const { text: analysisResponse } = await runMcpAgent({
    openai,
    model: 'anthropic/claude-opus-4.7',
    reasoning: { enabled: true, effort: "xhigh" },
    system: analysisSystemPrompt(),
    prompt: analysisUserPrompt(time_period),
    attachments: [
        { name: 'analysis.txt', text: analysis },
        { name: 'indexes.json', text: JSON.stringify(indexes, null, 2) },
    ],
});

await Actor.setValue('analysis_response.txt', analysisResponse, { contentType: 'text/plain' });

// Extract <file name="..."></file> blocks from the analysis response. The
// analysis prompt instructs the model to wrap each output file in such tags,
// so this is the contract.
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

const notionMcp = await createMcpClient(MCP_PROXY_URL, input.notionMcpConnector, API_TOKEN);
const githubMcp = await createMcpClient(MCP_PROXY_URL, input.githubMcpConnector, API_TOKEN);

const { text: integrationResponse } = await runMcpAgent({
    openai,
    model: 'anthropic/claude-sonnet-4.6',
    system: integrationSystemPrompt(input.notionDatabaseId, input.githubRepository),
    prompt: integrationUserPrompt(time_period),
    attachments: [
        ...analysisFiles,
        { name: 'indexes.json', text: JSON.stringify(indexes, null, 2) },
    ],
    clients: { notion: notionMcp, github: githubMcp },
    allowedTools: {
        notion: [
            'notion-fetch',         // read database + read pages
            'notion-create-pages',  // write into database (pass database_id as parent)
            'notion-update-page',   // update existing pages
        ],
        github: [
            'issue_write',         // create issue in github
        ],
    },
});

await Actor.setValue('integration_response.txt', integrationResponse, { contentType: 'text/plain' });

log.info(integrationResponse);

await notionMcp.close();
await githubMcp.close();

await Actor.exit();
