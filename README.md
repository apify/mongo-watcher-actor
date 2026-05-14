# MongoDB Atlas Watcher

An Apify Actor that turns your MongoDB Atlas slow-query logs into a daily, deduplicated backlog of database optimizations. It pulls logs from Atlas, runs them through an LLM that knows what to look for, updates a Notion database of every issue it has ever seen, and opens a GitHub issue the first time each new problem appears.

Run it on a schedule and your team stops triaging logs by hand.

## What you'll get out of it

For each run, the Actor will:

1. Download the slow-query logs from the Atlas nodes you specify for a configurable time window.
2. Filter them through a JavaScript function you provide, so noise (health checks, internal traffic, anything app-specific) never reaches the LLM.
3. Group the surviving queries by shape (`planCacheShapeHash` + namespace + command type) and compute the stats that matter: total/avg/p95/max duration, scan ratio, COLLSCAN counts, in-memory sort counts, replan counts, dominant plan, top apps issuing each shape.
4. Hand that aggregated report — plus a dump of your current indexes — to an analysis agent (Claude Opus) that produces two prioritized markdown reports:
   - `slow_query_analysis.md` — actionable findings, each one labeled with whether the recommended index already exists, partially exists, or is new.
   - `non_query_issues.md` — operational and architectural concerns (write amplification, plan-cache thrashing, in-memory sort hotspots, etc.).
5. Hand those reports to an integration agent (Claude Sonnet) that reconciles them with your Notion database — updating what already exists, creating new entries with priority + collection + query hash + suggested action, opening a GitHub issue for each genuinely new finding, and marking stale entries as solved.

```text
Atlas logs ──► your JS filter ──► group + stats ──► analysis agent ──► markdown reports
                                                                              │
                                                       ┌──────────────────────┴──────────────────────┐
                                                       ▼                                             ▼
                                              Notion database                                 GitHub issues
                                       (one entry per finding, updated daily)         (created once per new finding)
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
| Notion MCP Connector | yes | A Notion MCP connector with write access to your target database. Pick one from the dropdown in the Actor UI. |
| Notion Database ID | yes | The ID of the Notion database where findings will live. The database must already exist with the schema described below. |
| GitHub MCP Connector | yes | A GitHub MCP connector with permission to create issues. |
| GitHub Repository | yes | The target repo in `owner/repo` form. Issues are created here. |

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
- **`integration_response.txt`** — what the integration agent did this run: which Notion entries it updated, which it created, which GitHub issues it opened, which it auto-solved.
- **`analysis_response.txt`** — the full analysis-agent response, before it was split into the two markdown files above.
- **`analysis.txt`** — the raw aggregated stats report. Useful if you want to drill into the numbers yourself or feed them to a different tool.

Beyond the run output:

- **Notion** — your configured database gains or updates one entry per finding. Entries are matched primarily by query hash, then by `(collection, short title)`, so the same problem doesn't get a duplicate row tomorrow.
- **GitHub** — the first time a finding shows up, a single issue is created in your target repo and its URL is written back to the matching Notion entry. The URL is never overwritten.

## Notion database setup

Before the first run, create a Notion database with these exact properties. The integration agent will not invent new properties or new select options — if a property is missing or named differently, the run will fail at that step.

| Property | Type | Options / notes |
|---|---|---|
| Issue Name | Title | Format: `<collection> — Short title` |
| Priority | Select | `P0`, `P1`, `P2`, `P3` |
| Status | Select | `New`, `Ongoing`, `Solved` |
| GitHub Issue | URL | Set once when the issue is opened; never overwritten. |
| Query Hashes | Multi-select | MongoDB shape hashes (e.g. `F5BD645E`). An entry can carry several. |
| Collection | Select | MongoDB collection name |
| Action Type | Select | `New index`, `Pipeline change`, `Code change`, `Pre-aggregate`, `Bug fix`, `Investigate` |
| First Seen | Date | Written at creation, never updated. |
| Last Seen | Date | Updated to the current run date on every match. |

The `Collection` and `Query Hashes` selects don't need pre-seeded options — the agent will add new values to those two fields. All other selects must already have the listed options.

## Tips for getting good results

- **Run it daily.** The Notion database accumulates state across runs and the matching logic compares today's findings to what's already there, so a daily cadence is what gives you a stable backlog. Pair that with `Hours = 24` for a non-overlapping window.
- **Refresh the index dump each run.** If `indexes` goes stale, the analyzer may keep recommending indexes you have already shipped. The simplest setup is a small upstream job that dumps the current indexes right before this Actor runs.
- **Keep the filter function lean.** It runs on every log line, so heavy work there directly extends the run.
- **Pick the right nodes.** You only need to pull logs from one node per shard (typically the primary). Pulling from every replica multiplies cost without adding insight.

## Authentication

The Actor uses your Apify token to call the bundled LLM gateway, so you don't need an OpenAI, Anthropic, or OpenRouter key. The only external credentials you have to supply are your Atlas API key pair and the two MCP connectors (Notion + GitHub), all configured through the input form.
