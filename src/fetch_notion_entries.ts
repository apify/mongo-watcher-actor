import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { log } from 'apify';

export type NotionEntry = {
    id: string;
    title: string;
    collection: string;
    query_hashes: string[];
    status: 'New' | 'Ongoing' | 'Solved' | '';
    priority: 'P0' | 'P1' | 'P2' | 'P3' | '';
    action_type: string;
    first_seen: string;
    last_seen: string;
    github_issue: string;
    body: string;
};

export type NotionSnapshot = {
    page_id: string;
    entries: NotionEntry[];
};

export const FINDINGS_STATE_VERSION = 1;

const FETCH_TIMEOUT_MS = 60 * 1000;

// Matches the first ```json fenced block on the page. The actor maintains this
// block as the source of truth and rewrites the whole page on every run, so
// "first json block" is unambiguous.
const STATE_BLOCK_RE = /```json\s*\n([\s\S]*?)\n```/;

function mcpResultToText(result: Awaited<ReturnType<Client['callTool']>>): string {
    const content = result.content as { type: string; text?: string }[] | undefined;
    if (!content) return '';
    return content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
}

export async function fetchNotionEntries(opts: {
    notionMcp: Client;
    pageId: string;
}): Promise<NotionSnapshot> {
    const { notionMcp, pageId } = opts;

    const result = await notionMcp.callTool(
        { name: 'notion-fetch', arguments: { id: pageId } },
        undefined,
        { timeout: FETCH_TIMEOUT_MS },
    );
    const text = mcpResultToText(result);

    const match = text.match(STATE_BLOCK_RE);
    if (!match) {
        log.info('Notion bootstrap: no findings JSON block on page — starting from empty state');
        return { page_id: pageId, entries: [] };
    }

    let raw: unknown;
    try {
        raw = JSON.parse(match[1]);
    } catch (e) {
        throw new Error(`Notion bootstrap: findings JSON block is not valid JSON — ${(e as Error).message}`);
    }

    if (!raw || typeof raw !== 'object') {
        throw new Error('Notion bootstrap: findings JSON top-level is not an object');
    }
    const obj = raw as Record<string, unknown>;
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

    log.info(`Notion bootstrap: parsed ${entries.length} entries from page ${pageId}`);
    return { page_id: pageId, entries };
}

/** Render the canonical Notion page that holds the findings state.
 *  The first ```json block is the source of truth; everything else is a
 *  human-readable summary regenerated from it. */
export function renderFindingsPage(opts: {
    snapshot: NotionSnapshot;
    runId?: string;
}): string {
    const { snapshot, runId } = opts;
    const stamp = new Date().toISOString();

    const stateJson = JSON.stringify(
        { version: FINDINGS_STATE_VERSION, entries: snapshot.entries },
        null,
        2,
    );

    const priorityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, '': 4 };
    const sorted = [...snapshot.entries].sort((a, b) => {
        const pa = priorityOrder[a.priority] ?? 4;
        const pb = priorityOrder[b.priority] ?? 4;
        if (pa !== pb) return pa - pb;
        return a.title.localeCompare(b.title);
    });

    const renderedFindings = sorted
        .map((e) => {
            const priority = e.priority || '—';
            const status = e.status || '—';
            const issueLink = e.github_issue ? ` · [GitHub issue](${e.github_issue})` : '';
            const seen = (e.first_seen || e.last_seen)
                ? `_First seen ${e.first_seen || '?'}, last seen ${e.last_seen || '?'}._${issueLink}\n\n`
                : '';
            return `### ${priority} · ${e.title} · ${status}\n\n${seen}${e.body}\n`;
        })
        .join('\n---\n\n');

    const runLine = runId ? ` (Apify run \`${runId}\`)` : '';

    return `# Slow Query Findings

_Last updated: ${stamp}${runLine}_

## State

The fenced \`json\` block below is the machine-readable source of truth. **Do not edit by hand** — the actor rewrites this page on every run.

\`\`\`json
${stateJson}
\`\`\`

## Findings

${renderedFindings || '_No findings yet._'}
`;
}
