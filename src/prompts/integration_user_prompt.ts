import { EXCLUDED_EVENTS_NOTE, INDEX_PROVENANCE_NOTE, runWindow } from './run_context.js';

export function integrationUserPrompt(timePeriodHours: number): string {
    const { from, to } = runWindow(timePeriodHours);
    return `Execute the findings-state update + GitHub integration described in your instructions.

Context for this specific run:
- Window: ${from} → ${to}
- Attached files:
  • slow_query_analysis.md — the analysis agent's hash-rooted findings, each
    heading already tagged \`[NEW]\` or \`[REPEAT id=...]\`. Trust the tags.
  • existing_findings.json — the current findings state at the start of this
    run. Use it for existing-entry state when diffing on Update. Do NOT
    attempt to fetch Notion — the actor handles the page rewrite from your
    output.
  • indexes.json — ground truth referenced by the report.

${INDEX_PROVENANCE_NOTE}

${EXCLUDED_EVENTS_NOTE}`;
}
