import { EXCLUDED_EVENTS_NOTE, INDEX_PROVENANCE_NOTE, runWindow } from './run_context.js';

export function integrationUserPrompt(timePeriodHours: number): string {
    const { from, to } = runWindow(timePeriodHours);
    return `Execute the GitHub issue integration described in your instructions.

Context for this specific run:
- Window: ${from} → ${to}
- Attached files:
  • slow_query_analysis.md — the analysis agent's hash-rooted findings, each
    heading already tagged \`[NEW]\` or \`[REPEAT id=...]\` where the id is a
    GitHub issue number. Trust the tags.
  • existing_findings.json — every issue in the target repo carrying the
    \`slow-query\` label, captured at the start of this run. Use it for
    existing-issue state when diffing on Update. Do NOT call \`list_issues\`
    again; this snapshot is the source of truth for the run.
  • indexes.json — ground truth referenced by the report.

${INDEX_PROVENANCE_NOTE}

${EXCLUDED_EVENTS_NOTE}`;
}
