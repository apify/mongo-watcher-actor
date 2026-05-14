import { EXCLUDED_EVENTS_NOTE, INDEX_PROVENANCE_NOTE, runWindow } from './run_context.js';

export function analysisUserPrompt(timePeriodHours: number): string {
    const { from, to } = runWindow(timePeriodHours);
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

${INDEX_PROVENANCE_NOTE}

${EXCLUDED_EVENTS_NOTE}`;
}
