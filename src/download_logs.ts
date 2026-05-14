import { execSync, ExecSyncOptions } from 'child_process';
import { appendFile, readFile, rm } from 'fs/promises';

const HOUR_SECS = 60 * 60;

export type ENV = {
    organization_id: string,
    project_id: string,
    private_key: string,
    public_key: string,
};

function parseLine(line: string) {
    try {
        return JSON.parse(line);
    } catch (err) {
        console.log(line);
        console.error(err);
        return;
    }
}

function execWithRetry(command: string, options: ExecSyncOptions) {
    let retries = 0;
    while (retries < 3) {
        try {
            return execSync(command, options);
        } catch (err) {
            retries++;
        }
    }
    process.exit(1);
}

export async function downloadLogFiles(node: string, hours: number, env: ENV, filterFunction: (parsedLine: Record<string, unknown>) => Record<string, unknown>) {
    // Cleanup any old files
    try {
        await rm('./mongo.log');
    } catch (error) {
        // swallow error if file does not exist
    }

    console.log('Downloading log files for node: ', node);
    let now = Math.floor(Date.now() / 1000);
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
        console.log('Running command:', command);
        execWithRetry(command, execOptions);

        const fileContent = await readFile('mongo.log', 'utf-8');
        const lines = fileContent.split('\n').filter((line) => {
            if (!line) return false;
            const parsedLine = parseLine(line);
            if (!parsedLine) return;

            const filteredQuery = filterFunction(parsedLine);
            if (!filteredQuery) return false;

            return true;
        });
        await appendFile(`./lines.jsonl`, lines.join('\n') + '\n');

        start = end;
        end = start + HOUR_SECS;
    }
    console.log('Finished downloading log files for node:', node);
}