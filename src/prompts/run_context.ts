import dayjs from 'dayjs';

export function runWindow(timePeriodHours: number): { from: string; to: string } {
    const to = dayjs().format();
    const from = dayjs().subtract(timePeriodHours, 'hours').format();
    return { from, to };
}

export const INDEX_PROVENANCE_NOTE = `For each finding, explicitly state whether the recommended index already exists
in indexes.json, partially exists (noting what is missing), or is new.`;

export const EXCLUDED_EVENTS_NOTE = `Do not include mongot entries, _shardsvrMoveRange entries, or
_migrateClone entries — these are known infrastructure events.`;
