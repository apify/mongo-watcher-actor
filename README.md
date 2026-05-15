# MongoDB Atlas Watcher

An Apify Actor that turns your MongoDB Atlas slow-query logs into a daily, deduplicated backlog of database optimizations. It pulls logs from Atlas, runs them through an LLM that knows what to look for, and maintains a set of GitHub issues — one per distinct finding — opening new ones, updating recurring ones, auto-closing stale ones, and reopening them if the problem comes back.

Run it on a schedule and your team stops triaging logs by hand.

## What you'll get out of it

For each run, the Actor will:

1. Download the slow-query logs from the Atlas nodes you specify for a configurable time window.
2. Filter them through a JavaScript function you provide, so noise (health checks, internal traffic, anything app-specific) never reaches the LLM.
3. Group the surviving queries by shape (`planCacheShapeHash` + namespace + command type) and compute the stats that matter: total/avg/p95/max duration, scan ratio, COLLSCAN counts, in-memory sort counts, replan counts, dominant plan, top apps issuing each shape.
4. Hand that aggregated report — plus a dump of your current indexes and a snapshot of the existing slow-query GitHub issues — to an analysis agent (Claude Opus) that produces two prioritized markdown reports:
   - `slow_query_analysis.md` — actionable findings, each tagged `[NEW]` or `[REPEAT id=<issue-number>]` against the existing issue tracker.
   - `non_query_issues.md` — operational and architectural concerns (write amplification, plan-cache thrashing, in-memory sort hotspots, etc.).
5. Hand the report to an integration agent (Claude Sonnet) that carries out the decisions in GitHub: opens new issues for `[NEW]` findings, updates the body and labels of recurring ones, posts a comment summarizing what changed, reopens previously closed issues that have recurred, and closes issues that haven't been seen for 7 days.

```text
Atlas logs ──► your JS filter ──► group + stats ──► analysis agent ──► markdown reports
                                                                              │
                                                                              ▼
                                                            integration agent ──► GitHub issues
                                                                                (label:slow-query, one per finding)
```

## What you'll need to provide

| Input | Required | What goes here |
|---|---|---|
| Organization ID | yes | Your Atlas organization ID. In Atlas, click your account → Organizations. |
| Project ID | yes | The Atlas project ID — shown once you select an organization. |
| Public key / Private key | yes | An Atlas API key pair with at least read access to logs. Create one under Organization Settings → Access Manager. Both are stored as secrets. |
| Nodes | yes | The Atlas node hostnames you want to pull logs from (e.g. `atlas-abc-shard-00-00.xyz.mongodb.net`). One entry per node. |
| Hours | no | How many hours of history to pull. Default 1. For a daily schedule, use 24. |
| Filter function | yes | A JavaScript function that receives each parsed log line. Return the line (or any truthy value) to keep it, return falsy to drop it. Use it to skip internal traffic before it hits the analyzer. |
| Indexes | yes | A dump of all current indexes on the cluster. Generate it in `mongosh` with: `db.getCollectionNames().map(c => ({ name: c, indexes: db[c].getIndexes() }))`. The analyzer cross-references every recommendation against this list. |
| GitHub MCP Connector | yes | A GitHub MCP connector with permission to read, create, update, and comment on issues in the target repository. Pick one from the dropdown in the Actor UI. |
| GitHub Repository | yes | The target repo in `owner/repo` form. All slow-query findings are tracked as labelled issues in this repo. |

### Example filter function

```js
async function filterFunction(line) {
    // skip health checks
    if (line?.attr?.appName === 'health-probe') return null;
    // skip your own internal jobs
    if (line?.attr?.appName?.startsWith('cron-')) return null;
    return line;
}
```

Known infrastructure noise (`mongot`, `_shardsvrMoveRange`, `_migrateClone`) is already ignored by the analyzer — you only need to filter out things specific to your app.

## What you'll see in the run output

Each run writes the following files to the run's Key-Value Store, in order of how interesting they are to a human reader:

- **`slow_query_analysis.md`** — the prioritized findings. Start here.
- **`non_query_issues.md`** — operational / architectural issues that aren't tied to a single query shape.
- **`integration_response.txt`** — what the integration agent did this run: which issues it opened, which it updated, which it closed, which it reopened.
- **`analysis_response.txt`** — the full analysis-agent response, before it was split into the two markdown files above.
- **`analysis.txt`** — the raw aggregated stats report. Useful if you want to drill into the numbers yourself or feed them to a different tool.
- **`existing_findings.json`** — the snapshot of slow-query issues read from GitHub at the start of the run. Useful for debugging "why did this get classified as NEW".

Beyond the run output, the activity lives in your repo:

- **GitHub issues** — every finding is one issue, labelled `slow-query`, with one or more `hash:<HEX>` labels and exactly one of `high priority` / `medium priority` / `low priority`. The body holds the collection, action type, query hashes, first-seen date, and the full analysis. Each run that touches an issue posts a one-line comment summarizing the change.

## GitHub repo setup

The actor manages issues entirely through labels — no schema to create up front. The first run will auto-create any labels it references (GitHub's REST API does this on issue creation). If you want them present from day one with nice colors, create these by hand:

| Label | Purpose | Suggested color |
|---|---|---|
| `slow-query` | Sentinel. Every actor-managed issue carries this. | `#5319e7` (purple) |
| `high priority` | Mapped from analysis priorities P0 and P1. | `#b60205` (red) |
| `medium priority` | Mapped from analysis priority P2. | `#fbca04` (yellow) |
| `low priority` | Mapped from analysis priority P3. | `#0e8a16` (green) |

Per-query-hash labels (`hash:F5BD645E`, …) appear automatically as findings come in; they don't need pre-creation. The actor never adds labels for collection name or action type — those values live in the issue body so the GitHub label sidebar stays uncluttered.

### How an issue evolves

- **Created** on the first run that sees a finding the existing issues don't already cover. Body contains priority, collection, action type, query hashes, first-seen date, then the full analysis.
- **Updated** on subsequent runs that hit the same hash(es): body is rewritten with the latest analysis, the priority label and `hash:*` labels are reconciled, and a comment is posted summarizing what changed.
- **Auto-closed** after 7 days with no recurrence. The actor adds a comment when it closes.
- **Auto-reopened** if the same hashes recur. Another comment is posted noting the reappearance.
- **Closed by you manually** (e.g. when the fix ships) — the actor respects that; only a recurrence reopens it.

## Tips for getting good results

- **Run it daily.** The actor compares today's findings against the existing issue set, so a daily cadence is what gives you a stable backlog with meaningful auto-close behavior. Pair that with `Hours = 24` for a non-overlapping window.
- **Refresh the index dump each run.** If `indexes` goes stale, the analyzer may keep recommending indexes you have already shipped. The simplest setup is a small upstream job that dumps the current indexes right before this Actor runs.
- **Keep the filter function lean.** It runs on every log line, so heavy work there directly extends the run.
- **Pick the right nodes.** You only need to pull logs from one node per shard (typically the primary). Pulling from every replica multiplies cost without adding insight.
- **Don't hand-edit `slow-query` or `hash:*` labels.** The actor uses them as the matching key — removing them will cause the next run to lose track of an issue and possibly file a duplicate. Adding your own non-managed labels (e.g. `assigned`, `team-foo`) is fine; the actor preserves them.

## Authentication

The Actor uses your Apify token to call the bundled LLM gateway, so you don't need an OpenAI, Anthropic, or OpenRouter key. The only external credentials you have to supply are your Atlas API key pair and the GitHub MCP connector, all configured through the input form.
