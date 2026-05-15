// Tiny helper to dump the tool surface of an MCP connector via the Apify proxy.
// Usage: tsx src/list_mcp_tools.ts <connector-id>

import { createMcpClient } from './mcp_client.js';

const { APIFY_TOKEN, APIFY_MCP_PROXY_URL } = process.env;
if (!APIFY_TOKEN) throw new Error('Missing APIFY_TOKEN env variable');
if (!APIFY_MCP_PROXY_URL) throw new Error('Missing APIFY_MCP_PROXY_URL env variable');

const connectorId = process.argv[2];
if (!connectorId) {
    console.error('Usage: tsx src/list_mcp_tools.ts <connector-id>');
    process.exit(1);
}

const client = await createMcpClient(APIFY_MCP_PROXY_URL, connectorId, APIFY_TOKEN);
try {
    const { tools } = await client.listTools();
    console.log(`\n=== ${tools.length} tools exposed by connector ${connectorId} ===\n`);
    for (const t of tools) {
        console.log(`• ${t.name}`);
        if (t.description) {
            const firstLine = t.description.split('\n')[0].trim();
            console.log(`    ${firstLine}`);
        }
    }
} finally {
    await client.close();
}
