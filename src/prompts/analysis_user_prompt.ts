import dayjs from 'dayjs'

export function analysisUserPrompt(timePeriodHours: number): string {
    const to = dayjs().format();
    const from = dayjs().subtract(timePeriodHours, 'hours').format();
    return `Please analyse the attached MongoDB slow query log analysis and produce the two
reports described in your instructions.

Context for this specific run:
- Window: ${from} → ${to}
- Analysis file: see attached analysis.txt
- Indexes file: see attached indexes.json

Output both files in full, using the formats specified in your instructions.
Start with slow_query_analysis.md, then non_query_issues.md.
Wrap each file in <file name="..."></file> tags using its filename in the
\`name\` attribute, e.g. <file name="slow_query_analysis.md">...</file>, so
that the output can be parsed programmatically. Emit nothing outside the
<file></file> blocks.

For each finding, explicitly state whether the recommended index already exists
in indexes.json, partially exists (noting what is missing), or is new.

Do not include mongot entries, _shardsvrMoveRange entries, or
_migrateClone entries in the analysis — these are known infrastructure events.`;
}
