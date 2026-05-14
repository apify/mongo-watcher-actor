import dayjs from 'dayjs'

export function integrationUserPrompt(timePeriodHours: number): string {
    const to = dayjs().format();
    const from = dayjs().subtract(timePeriodHours, 'hours').format();
    return `Please process the attached MongoDB slow query analysis reports and produce
the integration outputs described in your instructions (Notion entries + GitHub issues).

Context for this specific run:
- Window: ${from} → ${to}
- Attached files: the analysis agent's output (one or more .md reports) and the
  indexes dump (indexes.json) used as ground truth.

For each finding, explicitly state whether the recommended index already exists
in indexes.json, partially exists (noting what is missing), or is new.

Do not include mongot entries, _shardsvrMoveRange entries, or
_migrateClone entries — these are known infrastructure events.`;
}
