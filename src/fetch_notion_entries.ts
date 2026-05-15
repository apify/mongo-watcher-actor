import type OpenAI from 'openai';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { log } from 'apify';

import { runMcpAgent } from './mcp_agent.js';

export type NotionEntry = {
    page_id: string;
    page_url: string;
    title: string;
    collection: string;
    query_hashes: string[];
    status: string;
    priority: string;
    action_type: string;
    last_seen: string;
    first_seen: string;
    github_issue: string;
};

export type NotionSnapshot = {
    data_source_id: string;
    entries: NotionEntry[];
};

const FETCH_TOOL_NAME = 'notion-fetch';
const SEARCH_TOOL_NAME = 'notion-search';
const ALLOWED_TOOLS = [FETCH_TOOL_NAME, SEARCH_TOOL_NAME];
const MAX_STEPS = 30;
const TOOL_TIMEOUT_MS = 2 * 60 * 1000;

function buildSystemPrompt(databaseId: string): string {
    return `You are a deterministic data-extraction step. Your only job is to enumerate
every row of a Notion database and emit it as JSON. You produce no analysis,
no commentary, no markdown.

Database to fetch: \`${databaseId}\`.

Tools you may call (and ONLY these tools):
  • ${FETCH_TOOL_NAME} — fetch a Notion URL or ID (database, data source, or page).
  • ${SEARCH_TOOL_NAME} — list/search entries inside a Notion data source. Use this
    to enumerate rows once you know the data source UUID. Supports pagination
    via a cursor in the response.

Procedure:
  1. Call ${FETCH_TOOL_NAME} with the database ID. The response contains a
     \`<data-source url="collection://<uuid>">\` tag near the top describing
     the data source backing this database.
  2. Capture the data source UUID from that tag (everything after
     \`collection://\`).
  3. Call ${SEARCH_TOOL_NAME} scoped to that data source UUID to list its
     entries. If the response includes a continuation cursor (e.g.
     \`next_cursor\`, \`has_more\`, or a "load more" reference), call
     ${SEARCH_TOOL_NAME} again with the cursor until every entry has been
     listed.
  4. For any entry whose property values are not fully visible in the search
     results, call ${FETCH_TOOL_NAME} on that page's ID/URL to read the
     missing fields.
  5. For each entry, extract: page id, page URL, title, Collection,
     Query Hashes (multi-select — emit ALL hashes), Status, Priority,
     Action Type, First Seen, Last Seen, GitHub Issue.
  6. When fully enumerated, output a SINGLE JSON object and nothing else.

Output schema (strict — emit exactly this shape, no extra keys, no prose):

{
  "data_source_id": "<uuid>",
  "entries": [
    {
      "page_id": "<notion page id>",
      "page_url": "<full https URL of the page>",
      "title": "<Issue Name>",
      "collection": "<Collection select value or empty string>",
      "query_hashes": ["<HEX>", "<HEX>", ...],
      "status": "<New|Ongoing|Solved or empty>",
      "priority": "<P0|P1|P2|P3 or empty>",
      "action_type": "<Action Type select value or empty>",
      "last_seen": "<ISO date or empty>",
      "first_seen": "<ISO date or empty>",
      "github_issue": "<URL or empty>"
    }
  ]
}

Rules:
  • If a property is missing or empty in Notion, use "" (empty string) — not
    null, not "N/A".
  • query_hashes is always an array; use [] when there are no hashes.
  • Do NOT fabricate entries. Only emit rows that exist in the database.
  • Do NOT call any tool other than ${FETCH_TOOL_NAME} and ${SEARCH_TOOL_NAME}.
  • Once you have enumerated every entry, your final assistant message must
    be exactly one JSON object that matches the schema above — no fences,
    no extra text before or after.`;
}

export async function fetchNotionEntries(opts: {
    openai: OpenAI;
    notionMcp: Client;
    databaseId: string;
    model?: string;
}): Promise<NotionSnapshot> {
    const { openai, notionMcp, databaseId, model = 'anthropic/claude-haiku-4.5' } = opts;

    const { text } = await runMcpAgent({
        openai,
        model,
        maxSteps: MAX_STEPS,
        toolTimeoutMs: TOOL_TIMEOUT_MS,
        clients: { notion: notionMcp },
        allowedTools: { notion: ALLOWED_TOOLS },
        system: buildSystemPrompt(databaseId),
        prompt: `Enumerate every row of database \`${databaseId}\` and emit the JSON object described in your instructions.`,
    });

    const parsed = parseSnapshot(text);
    log.info(`Notion bootstrap: parsed ${parsed.entries.length} entries, data_source_id=${parsed.data_source_id}`);
    return parsed;
}

function parseSnapshot(text: string): NotionSnapshot {
    // Defensive: the model sometimes wraps JSON in a ```json fence despite the prompt forbidding it.
    const trimmed = text.trim();
    const stripped = trimmed.startsWith('```')
        ? trimmed.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
        : trimmed;

    let raw: unknown;
    try {
        raw = JSON.parse(stripped);
    } catch (e) {
        throw new Error(`Notion bootstrap: final output was not valid JSON — ${(e as Error).message}\n--- output ---\n${stripped.slice(0, 1000)}`);
    }

    if (!raw || typeof raw !== 'object') throw new Error('Notion bootstrap: top-level JSON is not an object');
    const obj = raw as Record<string, unknown>;
    const dsId = typeof obj.data_source_id === 'string' ? obj.data_source_id : '';
    if (!dsId) throw new Error('Notion bootstrap: missing data_source_id');
    const rawEntries = Array.isArray(obj.entries) ? obj.entries : [];

    const entries: NotionEntry[] = rawEntries.map((row, i) => {
        if (!row || typeof row !== 'object') {
            throw new Error(`Notion bootstrap: entry #${i} is not an object`);
        }
        const r = row as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === 'string' ? v : '');
        const hashes = Array.isArray(r.query_hashes)
            ? r.query_hashes.filter((h): h is string => typeof h === 'string')
            : [];
        return {
            page_id: str(r.page_id),
            page_url: str(r.page_url),
            title: str(r.title),
            collection: str(r.collection),
            query_hashes: hashes,
            status: str(r.status),
            priority: str(r.priority),
            action_type: str(r.action_type),
            last_seen: str(r.last_seen),
            first_seen: str(r.first_seen),
            github_issue: str(r.github_issue),
        };
    });

    return { data_source_id: dsId, entries };
}
