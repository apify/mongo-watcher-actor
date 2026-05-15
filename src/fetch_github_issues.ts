import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { log } from 'apify';

export type IssuePriority = 'high' | 'medium' | 'low' | '';

export type Finding = {
    /** GitHub issue number, as a string. Matches the `[REPEAT id=…]` tag emitted by the analysis prompt. */
    id: string;
    title: string;
    url: string;
    state: 'open' | 'closed';
    priority: IssuePriority;
    query_hashes: string[];
    /** ISO-8601 timestamp of issue creation. Used as "first seen". */
    created_at: string;
    /** ISO-8601 timestamp of the most recent update on the issue. Used as "last seen". */
    updated_at: string;
    /** Issue body — the full analysis content (collection, action type, metrics, query shape, fix). */
    body: string;
};

export type FindingsSnapshot = {
    owner: string;
    repo: string;
    findings: Finding[];
};

export const SLOW_QUERY_LABEL = 'slow-query';
export const PRIORITY_LABELS = ['high priority', 'medium priority', 'low priority'] as const;
const HASH_LABEL_RE = /^hash:([0-9A-Fa-f]+)$/;

const FETCH_TIMEOUT_MS = 60 * 1000;
const PER_PAGE = 50;
const MAX_PAGES = 40; // safety cap; 50 * 40 = 2000 issues

function mcpResultToText(result: Awaited<ReturnType<Client['callTool']>>): string {
    const content = result.content as { type: string; text?: string }[] | undefined;
    if (!content) return '';
    return content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
}

type RawIssue = {
    number?: number;
    title?: string;
    html_url?: string;
    url?: string;
    state?: string;
    body?: string;
    created_at?: string;
    updated_at?: string;
    labels?: (string | { name?: string })[];
};

type ListIssuesPayload = {
    issues?: RawIssue[];
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    // Some GitHub MCP shapes return the array at the top level.
};

function parsePayload(text: string): { issues: RawIssue[]; nextCursor: string | null } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        throw new Error(`list_issues did not return JSON: ${(e as Error).message}`);
    }
    // Tolerate both wrapped and bare-array shapes.
    if (Array.isArray(parsed)) {
        return { issues: parsed as RawIssue[], nextCursor: null };
    }
    const obj = (parsed ?? {}) as ListIssuesPayload & Record<string, unknown>;
    const issues = Array.isArray(obj.issues) ? obj.issues : [];
    const pageInfo = (obj.pageInfo ?? {}) as { hasNextPage?: boolean; endCursor?: string | null };
    const nextCursor = pageInfo.hasNextPage ? (pageInfo.endCursor ?? null) : null;
    return { issues, nextCursor };
}

function labelNames(issue: RawIssue): string[] {
    const labels = issue.labels ?? [];
    return labels
        .map((l) => (typeof l === 'string' ? l : (l?.name ?? '')))
        .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

function priorityFromLabels(labels: string[]): IssuePriority {
    if (labels.includes('high priority')) return 'high';
    if (labels.includes('medium priority')) return 'medium';
    if (labels.includes('low priority')) return 'low';
    return '';
}

function hashesFromLabels(labels: string[]): string[] {
    const hashes: string[] = [];
    for (const name of labels) {
        const m = name.match(HASH_LABEL_RE);
        if (m) hashes.push(m[1].toUpperCase());
    }
    return hashes;
}

function toFinding(issue: RawIssue): Finding | null {
    if (typeof issue.number !== 'number') return null;
    const labels = labelNames(issue);
    if (!labels.includes(SLOW_QUERY_LABEL)) return null; // not actor-managed
    return {
        id: String(issue.number),
        title: issue.title ?? '',
        url: issue.html_url ?? issue.url ?? '',
        state: issue.state === 'closed' ? 'closed' : 'open',
        priority: priorityFromLabels(labels),
        query_hashes: hashesFromLabels(labels),
        created_at: issue.created_at ?? '',
        updated_at: issue.updated_at ?? '',
        body: issue.body ?? '',
    };
}

export async function fetchGithubIssues(opts: {
    githubMcp: Client;
    githubRepository: string;
}): Promise<FindingsSnapshot> {
    const { githubMcp, githubRepository } = opts;
    const [owner, repo] = githubRepository.split('/');
    if (!owner || !repo) {
        throw new Error(`githubRepository must be "<owner>/<repo>", got "${githubRepository}"`);
    }

    const findings: Finding[] = [];
    let after: string | null = null;
    let pageCount = 0;

    for (;;) {
        if (pageCount >= MAX_PAGES) {
            log.warning(`fetchGithubIssues: hit MAX_PAGES (${MAX_PAGES}) cap; stopping pagination.`);
            break;
        }
        pageCount += 1;

        const args: Record<string, unknown> = {
            owner,
            repo,
            labels: [SLOW_QUERY_LABEL],
            state: 'all',
            perPage: PER_PAGE,
        };
        if (after) args.after = after;

        const result = await githubMcp.callTool(
            { name: 'list_issues', arguments: args },
            undefined,
            { timeout: FETCH_TIMEOUT_MS },
        );
        const text = mcpResultToText(result);
        const { issues, nextCursor } = parsePayload(text);

        for (const issue of issues) {
            const finding = toFinding(issue);
            if (finding) findings.push(finding);
        }

        if (!nextCursor) break;
        after = nextCursor;
    }

    log.info(`fetchGithubIssues: collected ${findings.length} findings (label:${SLOW_QUERY_LABEL}) from ${owner}/${repo}.`);
    return { owner, repo, findings };
}
