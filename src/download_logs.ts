import { execSync } from 'node:child_process';
import type { ExecSyncOptions } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { appendFile, readFile, rm } from 'node:fs/promises';

import { log } from 'apify';

const HOUR_SECS = 60 * 60;
const MAX_RETRIES = 3;

export type ENV = {
    organization_id: string,
    project_id: string,
    private_key: string,
    public_key: string,
};

function parseLine(line: string): Record<string, unknown> | null {
    try {
        return JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
        log.warning('Failed to parse JSON line', { line, error: (err as Error).message });
        return null;
    }
}

async function execWithRetry(command: string, options: ExecSyncOptions) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return execSync(command, options);
        } catch (err) {
            const isLast = attempt === MAX_RETRIES;
            log.warning(`atlas CLI failed (attempt ${attempt}/${MAX_RETRIES})`, { error: (err as Error).message });
            if (isLast) throw err;
            await sleep(2 ** attempt * 1000);
        }
    }
    // Unreachable — loop either returns or throws.
    throw new Error('execWithRetry: exhausted retries');
}

export async function downloadLogFiles(node: string, hours: number, env: ENV, filterFunction: (parsedLine: Record<string, unknown>) => Record<string, unknown>) {
    await rm('./mongo.log', { force: true });

    log.info('Downloading log files for node', { node });
    const now = Math.floor(Date.now() / 1000);
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

    while (start < now) {
        const command = `/usr/bin/atlas logs download ${node} mongodb.gz --start ${start} --end ${end} -d --out mongo.log --force`;
        log.debug('Running command', { command });
        await execWithRetry(command, execOptions);

        const fileContent = await readFile('mongo.log', 'utf-8');
        const lines = fileContent.split('\n').filter((line) => {
            if (!line) return false;
            const parsedLine = parseLine(line);
            if (!parsedLine) return false;
            return Boolean(filterFunction(parsedLine));
        });
        await appendFile('./lines.jsonl', lines.join('\n') + '\n');

        start = end;
        end = start + HOUR_SECS;
    }
    log.info('Finished downloading log files for node', { node });
}
