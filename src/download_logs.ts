import { execSync } from 'node:child_process';
import type { ExecSyncOptions } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { appendFile, readFile, rm, stat } from 'node:fs/promises';

import { log } from 'apify';

const HOUR_SECS = 60 * 60;
const MAX_RETRIES = 3;

export type ENV = {
    organization_id: string,
    project_id: string,
    private_key: string,
    public_key: string,
};

type ParseStats = { parsed: number; failed: number };

function parseLine(line: string, stats: ParseStats): Record<string, unknown> | null {
    try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        stats.parsed++;
        return obj;
    } catch {
        stats.failed++;
        return null;
    }
}

async function execWithRetry(command: string, options: ExecSyncOptions) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return execSync(command, options);
        } catch (err) {
            const isLast = attempt === MAX_RETRIES;
            if (isLast) {
                log.warning(`atlas CLI failed (attempt ${attempt}/${MAX_RETRIES}), giving up`, { error: (err as Error).message });
                throw err;
            }
            const backoffMs = 2 ** attempt * 1000;
            log.warning(`atlas CLI failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${backoffMs}ms`, { error: (err as Error).message });
            await sleep(backoffMs);
        }
    }
    // Unreachable — loop either returns or throws.
    throw new Error('execWithRetry: exhausted retries');
}

function fmtBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export async function downloadLogFiles(node: string, hours: number, env: ENV, filterFunction: (parsedLine: Record<string, unknown>) => Record<string, unknown>) {
    await rm('./mongo.log', { force: true });

    const now = Math.floor(Date.now() / 1000);
    const totalChunks = hours;
    log.info(`Downloading logs for node ${node}: ${totalChunks} hourly chunk(s) covering ${hours}h`);

    let start = now - (hours * HOUR_SECS);
    let end = start + HOUR_SECS;

    const execOptions = {
        env: {
            ...process.env,
            DO_NOT_TRACK: '',

            MONGODB_ATLAS_PRIVATE_API_KEY: env.private_key,
            MONGODB_ATLAS_PUBLIC_API_KEY: env.public_key,
            MONGODB_ATLAS_ORG_ID: env.organization_id,
            MONGODB_ATLAS_PROJECT_ID: env.project_id,
        },
    };

    const nodeStartedAt = Date.now();
    let chunkIndex = 0;
    let totalParsed = 0;
    let totalFailed = 0;
    let totalKept = 0;
    let totalBytes = 0;

    while (start < now) {
        chunkIndex++;
        const chunkStartedAt = Date.now();
        const startIso = new Date(start * 1000).toISOString();
        const endIso = new Date(end * 1000).toISOString();

        const command = `/usr/bin/atlas logs download ${node} mongodb.gz --start ${start} --end ${end} -d --out mongo.log --force`;
        log.debug('Running command', { command });
        await execWithRetry(command, execOptions);

        const fileBytes = (await stat('mongo.log').catch(() => ({ size: 0 }))).size;
        totalBytes += fileBytes;

        const fileContent = await readFile('mongo.log', 'utf-8');
        const stats: ParseStats = { parsed: 0, failed: 0 };
        const lines = fileContent.split('\n').filter((line) => {
            if (!line) return false;
            const parsedLine = parseLine(line, stats);
            if (!parsedLine) return false;
            return Boolean(filterFunction(parsedLine));
        });
        await appendFile('./lines.jsonl', lines.join('\n') + '\n');

        totalParsed += stats.parsed;
        totalFailed += stats.failed;
        totalKept += lines.length;

        const chunkMs = Date.now() - chunkStartedAt;
        log.info(
            `[${node}] chunk ${chunkIndex}/${totalChunks} ${startIso} → ${endIso}: `
            + `${fmtBytes(fileBytes)} downloaded, ${stats.parsed} lines parsed`
            + (stats.failed ? `, ${stats.failed} unparseable` : '')
            + `, ${lines.length} kept after filter, took ${chunkMs}ms`,
        );

        start = end;
        end = start + HOUR_SECS;
    }

    const nodeMs = Date.now() - nodeStartedAt;
    log.info(
        `[${node}] download complete: ${fmtBytes(totalBytes)} across ${chunkIndex} chunk(s), `
        + `${totalParsed} lines parsed`
        + (totalFailed ? `, ${totalFailed} unparseable` : '')
        + `, ${totalKept} kept after filter, took ${(nodeMs / 1000).toFixed(1)}s`,
    );
}
