import { EXCLUDED_EVENTS_NOTE, INDEX_PROVENANCE_NOTE, runWindow } from './run_context.js';

export function integrationUserPrompt(timePeriodHours: number): string {
    const { from, to } = runWindow(timePeriodHours);
    return `Please process the attached MongoDB slow query analysis reports and produce
the integration outputs described in your instructions (Notion entries + GitHub issues).

Context for this specific run:
- Window: ${from} → ${to}
- Attached files: the analysis agent's output (one or more .md reports) and the
  indexes dump (indexes.json) used as ground truth.

${INDEX_PROVENANCE_NOTE}

${EXCLUDED_EVENTS_NOTE}`;
}
