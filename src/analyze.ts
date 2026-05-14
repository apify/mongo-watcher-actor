import * as fs from 'node:fs';
import * as readline from 'node:readline';

const COMMAND_KEYS = ['find', 'update', 'insert', 'delete', 'aggregate', 'getMore',
                      'findAndModify', 'count', 'distinct', 'bulkWrite'] as const;

const SKIP_META = new Set([
  '$db', '$clusterTime', '$configTime', '$topologyTime', '$audit', '$client',
  'lsid', 'mayBypassWriteBlocking', 'readConcern', 'writeConcern', 'runtimeConstants',
  'shardVersion', 'databaseVersion', 'stmtIds', 'bypassDocumentValidation',
  'ordered', 'clientOperationKey',
]);

type JsonObject = Record<string, unknown>;

interface MongoUpdateEntry {
  q?: JsonObject;
  multi?: boolean;
  upsert?: boolean;
}

interface MongoDeleteEntry {
  q?: JsonObject;
}

interface MongoCommand extends JsonObject {
  filter?: JsonObject;
  sort?: JsonObject;
  limit?: number;
  projection?: JsonObject;
  pipeline?: JsonObject[];
  updates?: MongoUpdateEntry[];
  update?: string;
  deletes?: MongoDeleteEntry[];
  query?: JsonObject;
  collection?: string;
  appName?: string;
  $client?: { application?: { name?: string } };
}

interface MongoLogAttr {
  command?: MongoCommand;
  ns?: string;
  appName?: string;
  durationMillis?: number;
  keysExamined?: number;
  docsExamined?: number;
  nreturned?: number;
  planSummary?: string;
  cpuNanos?: number;
  hasSortStage?: boolean;
  replanned?: boolean;
  replanReason?: string;
  queryHash?: string;
  planCacheShapeHash?: string;
  storage?: { data?: { bytesRead?: number } };
  originatingCommand?: MongoCommand;
}

interface MongoLogLine {
  t?: { $date?: string };
  attr?: MongoLogAttr;
}

type FilterShape = Record<string, unknown>;

interface Group {
  count: number;
  total_duration_ms: number;
  max_duration_ms: number;
  durations: number[];
  total_docs_examined: number;
  total_keys_examined: number;
  total_bytes_read: number;
  total_cpu_nanos: number;
  total_nreturned: number;
  plan_summaries: Map<string, number>;
  has_sort_stage_count: number;
  replanned_count: number;
  replan_reasons: Map<string, number>;
  filter_shape: FilterShape | null;
  app_names: Map<string, number>;
  critical_count: number;
  collscan_count: number;
  originating_cmd_type: string | null;
  _hash: string;
  _ns: string;
  _cmd_type: string;
}

interface RankedGroup {
  hash: string;
  ns: string;
  cmd_type: string;
  count: number;
  total_duration_ms: number;
  avg_duration_ms: number;
  median_duration_ms: number;
  p95_duration_ms: number;
  max_duration_ms: number;
  total_docs_examined: number;
  total_keys_examined: number;
  total_nreturned: number;
  scan_ratio: number;
  total_bytes_read_mb: number;
  total_cpu_nanos: number;
  dominant_plan: string;
  all_plans: Record<string, number>;
  has_sort_stage_count: number;
  replanned_count: number;
  replan_reasons: Record<string, number>;
  critical_count: number;
  collscan_count: number;
  filter_shape: FilterShape | null;
  app_names: Record<string, number>;
  originating_cmd_type: string | null;
}

export interface AnalyzeOptions {
  top?: number;
  minTotalS?: number;
}

const DEFAULT_TOP = 500;

function getCommandType(cmd: MongoCommand | undefined): string {
  if (!cmd || typeof cmd !== 'object') return 'unknown';
  for (const key of COMMAND_KEYS) {
    if (key in cmd) return key;
  }
  for (const key of Object.keys(cmd)) {
    if (!SKIP_META.has(key)) return key;
  }
  return 'unknown';
}

function getAppName(attr: MongoLogAttr): string | null {
  return attr.appName
    ?? attr.command?.$client?.application?.name
    ?? attr.command?.appName
    ?? null;
}

function sortedKeys(o: unknown): string[] | string {
  if (o && typeof o === 'object' && !Array.isArray(o)) return Object.keys(o as object).sort();
  return String(o);
}

function getFilterShape(cmd: MongoCommand | undefined, cmdType: string): FilterShape {
  if (!cmd) return {};
  if (cmdType === 'find') {
    const filt = cmd.filter || {};
    const sort = cmd.sort || {};
    const limit = cmd.limit;
    const proj = cmd.projection || {};
    return {
      filter_keys: sortedKeys(filt),
      sort,
      limit: limit === undefined ? null : limit,
      projection_keys: (proj && typeof proj === 'object' && !Array.isArray(proj))
        ? Object.keys(proj).sort() : [],
    };
  }
  if (cmdType === 'aggregate') {
    const pipeline = cmd.pipeline || [];
    const stages = pipeline.map((s) => {
      if (s && typeof s === 'object') {
        const ks = Object.keys(s);
        return ks.length ? ks[0] : '?';
      }
      return '?';
    });
    return { pipeline_stages: stages };
  }
  if (cmdType === 'update') {
    const updates = cmd.updates || [{}];
    if (Array.isArray(updates) && updates[0] && typeof updates[0] === 'object') {
      const u = updates[0];
      const filt = u.q || {};
      return {
        filter_keys: sortedKeys(filt),
        multi: !!u.multi,
        upsert: !!u.upsert,
      };
    }
    return { collection: cmd.update || '?', note: 'bulk/sharded update' };
  }
  if (cmdType === 'delete') {
    const deletes = cmd.deletes || [{}];
    if (deletes && deletes.length) {
      const d = deletes[0] || {};
      const filt = d.q || {};
      return { filter_keys: sortedKeys(filt) };
    }
  }
  if (cmdType === 'findAndModify') {
    const filt = cmd.query || cmd.filter || {};
    return { filter_keys: sortedKeys(filt) };
  }
  if (cmdType === 'getMore') {
    return { collection: cmd.collection || '?' };
  }
  return {};
}

function getOriginatingCommandInfo(attr: MongoLogAttr): [FilterShape, string | null] {
  const orig = attr.originatingCommand;
  if (orig) {
    const cmdType = getCommandType(orig);
    return [getFilterShape(orig, cmdType), cmdType];
  }
  return [{}, null];
}

function newGroup(hash: string, ns: string, cmdType: string): Group {
  return {
    count: 0,
    total_duration_ms: 0,
    max_duration_ms: 0,
    durations: [],
    total_docs_examined: 0,
    total_keys_examined: 0,
    total_bytes_read: 0,
    total_cpu_nanos: 0,
    total_nreturned: 0,
    plan_summaries: new Map(),
    has_sort_stage_count: 0,
    replanned_count: 0,
    replan_reasons: new Map(),
    filter_shape: null,
    app_names: new Map(),
    critical_count: 0,
    collscan_count: 0,
    originating_cmd_type: null,
    _hash: hash,
    _ns: ns,
    _cmd_type: cmdType,
  };
}

function bumpMap<K>(m: Map<K, number>, key: K): void {
  m.set(key, (m.get(key) || 0) + 1);
}

// ---- Stats helpers ---------------------------------------------------------

function median(sorted: number[]): number {
  const n = sorted.length;
  if (!n) return 0;
  if (n % 2 === 1) return sorted[(n - 1) >> 1];
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function p95(sorted: number[]): number {
  if (!sorted.length) return 0;
  return sorted[Math.trunc(sorted.length * 0.95)];
}

function dominantKey(m: Map<string, number>): string {
  if (!m.size) return '';
  let bestK = '', bestV = -Infinity;
  for (const [k, v] of m) {
    if (v > bestV) { bestV = v; bestK = k; }
  }
  return bestK;
}

// ---- Formatting helpers ---------------------------------------------------

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function roundTo(n: number, d: number): number {
  const k = 10 ** d;
  return Math.round(n * k) / k;
}

function toJsonRecord(r: RankedGroup, rank: number): Record<string, unknown> {
  const parts = r.ns.split('.');
  const collection = parts.length > 1 ? parts[parts.length - 1] : r.ns;
  const topApps = Object.entries(r.app_names).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const rec: Record<string, unknown> = {
    rank,
    cmd: r.cmd_type,
    ns: r.ns,
    collection,
    hash: r.hash,
    count: r.count,
    total_ms: Math.trunc(r.total_duration_ms),
    total_s: roundTo(r.total_duration_ms / 1000, 1),
    avg_ms: roundTo(r.avg_duration_ms, 1),
    median_ms: roundTo(r.median_duration_ms, 1),
    p95_ms: Math.trunc(r.p95_duration_ms),
    max_ms: Math.trunc(r.max_duration_ms),
    critical: r.critical_count,
    docs_examined: r.total_docs_examined,
    docs_returned: r.total_nreturned,
    scan_ratio: Number.isFinite(r.scan_ratio) ? roundTo(r.scan_ratio, 1) : null,
    bytes_read_mb: roundTo(r.total_bytes_read_mb, 1),
    cpu_s: roundTo(r.total_cpu_nanos / 1e9, 1),
    plan: r.dominant_plan,
    collscans: r.collscan_count,
    sort_stage: r.has_sort_stage_count,
    replanned: r.replanned_count,
    filter: r.filter_shape,
    apps: topApps.map(([n, c]) => `${n}:${c}`),
  };
  const replanCounts = Object.values(r.replan_reasons);
  if (replanCounts.length) rec.replan_reason_counts = replanCounts;
  return rec;
}

function padL(s: string | number, w: number): string { return String(s).padStart(w); }
function padR(s: string | number, w: number): string { return String(s).padEnd(w); }

function jsonDumps(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val === Infinity) return 'Infinity';
    if (val === -Infinity) return '-Infinity';
    if (Number.isNaN(val)) return 'NaN';
    return val;
  });
}

// ---- Main ------------------------------------------------------------------

export async function analyzeFile(filepath: string, opts: AnalyzeOptions = {}): Promise<string> {
  const top = opts.top ?? DEFAULT_TOP;
  const minTotalS = opts.minTotalS ?? 0;

  const groups = new Map<string, Group>();
  let totalParsed = 0;

  const stream = fs.createReadStream(filepath, { encoding: 'utf8', highWaterMark: 1 << 20 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: MongoLogLine;
    try { obj = JSON.parse(line) as MongoLogLine; } catch (_) { continue; }

    totalParsed++;
    const attr: MongoLogAttr = obj.attr || {};
    const cmd: MongoCommand = attr.command || {};

    const appName = getAppName(attr);

    const ns = attr.ns || '';
    const cmdType = getCommandType(cmd);
    const durationMs = attr.durationMillis || 0;
    const keysExamined = attr.keysExamined || 0;
    const docsExamined = attr.docsExamined || 0;
    const nreturned = attr.nreturned || 0;
    const planSummary = attr.planSummary || '';
    const cpuNanos = attr.cpuNanos || 0;
    const hasSortStage = !!attr.hasSortStage;
    const replanned = !!attr.replanned;
    const replanReason = attr.replanReason || '';
    const queryHash = attr.queryHash || '';
    const planCacheShapeHash = attr.planCacheShapeHash || queryHash;
    const bytesRead = attr.storage?.data?.bytesRead ?? 0;

    const hashKey = planCacheShapeHash || `NO_HASH_${ns}_${cmdType}`;
    const groupKey = `${hashKey}${ns}${cmdType}`;

    let g = groups.get(groupKey);
    if (!g) {
      g = newGroup(hashKey, ns, cmdType);
      groups.set(groupKey, g);
    }

    g.count++;
    g.total_duration_ms += durationMs;
    if (durationMs > g.max_duration_ms) g.max_duration_ms = durationMs;
    g.durations.push(durationMs);
    g.total_docs_examined += docsExamined;
    g.total_keys_examined += keysExamined;
    g.total_bytes_read += bytesRead;
    g.total_cpu_nanos += cpuNanos;
    g.total_nreturned += nreturned;
    bumpMap(g.plan_summaries, planSummary);
    if (hasSortStage) g.has_sort_stage_count++;
    if (replanned) g.replanned_count++;
    if (replanReason) bumpMap(g.replan_reasons, replanReason);
    if (appName) bumpMap(g.app_names, appName);

    if (durationMs > 5000) g.critical_count++;
    if (planSummary.includes('COLLSCAN')) g.collscan_count++;

    if (g.filter_shape === null) {
      if (cmdType === 'getMore') {
        const [fshape, origCmdType] = getOriginatingCommandInfo(attr);
        g.filter_shape = fshape;
        g.originating_cmd_type = origCmdType;
      } else {
        g.filter_shape = getFilterShape(cmd, cmdType);
      }
    }

  }

  const ranked: RankedGroup[] = [];
  for (const g of groups.values()) {
    const sortedDurations = g.durations.slice().sort((x, y) => x - y);
    const nret = g.total_nreturned;

    ranked.push({
      hash: g._hash,
      ns: g._ns,
      cmd_type: g._cmd_type,
      count: g.count,
      total_duration_ms: g.total_duration_ms,
      avg_duration_ms: g.count ? g.total_duration_ms / g.count : 0,
      median_duration_ms: median(sortedDurations),
      p95_duration_ms: p95(sortedDurations),
      max_duration_ms: g.max_duration_ms,
      total_docs_examined: g.total_docs_examined,
      total_keys_examined: g.total_keys_examined,
      total_nreturned: g.total_nreturned,
      scan_ratio: nret > 0 ? g.total_docs_examined / nret : Infinity,
      total_bytes_read_mb: g.total_bytes_read / (1024 * 1024),
      total_cpu_nanos: g.total_cpu_nanos,
      dominant_plan: dominantKey(g.plan_summaries),
      all_plans: Object.fromEntries(g.plan_summaries),
      has_sort_stage_count: g.has_sort_stage_count,
      replanned_count: g.replanned_count,
      replan_reasons: Object.fromEntries(g.replan_reasons),
      critical_count: g.critical_count,
      collscan_count: g.collscan_count,
      filter_shape: g.filter_shape,
      app_names: Object.fromEntries(g.app_names),
      originating_cmd_type: g.originating_cmd_type,
    });
  }

  ranked.sort((a, b) => b.total_duration_ms - a.total_duration_ms);

  const criticalTotal = ranked.reduce((a, r) => a + r.critical_count, 0);
  const filteredRanked = minTotalS > 0
    ? ranked.filter((r) => r.total_duration_ms / 1000 >= minTotalS)
    : ranked;
  const topRanked = filteredRanked.slice(0, top);

  const out: string[] = [];
  const eq = '='.repeat(100);

  out.push(eq);
  out.push('MONGODB SLOW QUERY LOG ANALYSIS');
  out.push(eq);
  out.push(`File:                   ${filepath}`);
  out.push(`Total log lines parsed: ${totalParsed}`);
  out.push(`Unique query groups:    ${ranked.length}`);
  out.push(`Total critical (>5s):   ${criticalTotal}`);
  out.push(`(Condensed: showing top ${topRanked.length} of ${ranked.length} groups)`);
  out.push('');

  out.push(eq);
  out.push(`RANKED QUERY GROUPS — top ${topRanked.length} by total duration (one JSON per line)`);
  out.push(eq);
  topRanked.forEach((r, idx) => {
    out.push(JSON.stringify(toJsonRecord(r, idx + 1)));
  });

  // ---- Scan inefficiency ranking ----
  out.push('');
  out.push(eq);
  out.push('TOP 20 GROUPS BY SCAN INEFFICIENCY (docsExamined/nreturned ratio, min 10 occurrences)');
  out.push(eq);
  const inefficient = ranked.filter((r) => r.count >= 10 && r.total_nreturned > 0);
  inefficient.sort((a, b) => b.scan_ratio - a.scan_ratio);
  out.push(`${padR('#', 3)}  ${padL('Ratio', 8)}  ${padL('Count', 6)}  ${padL('TotalDurMs', 12)}  ${padL('DocsExam', 10)}  ${padL('Returned', 8)}  ${padR('Plan', 40)}  ns.cmd`);
  inefficient.slice(0, 20).forEach((r, idx) => {
    const i = idx + 1;
    const sr = r.scan_ratio;
    const srStr = sr < 1e6 ? Math.round(sr).toString() : 'INF';
    out.push(`${padL(i, 3)}  ${padL(srStr, 8)}  ${padL(fmtInt(r.count), 6)}  ${padL(fmtInt(r.total_duration_ms), 12)}  ${padL(fmtInt(r.total_docs_examined), 10)}  ${padL(fmtInt(r.total_nreturned), 8)}  ${padR((r.dominant_plan || '').slice(0, 40), 40)}  ${r.ns}.${r.cmd_type}`);
  });

  // ---- COLLSCAN groups ----
  out.push('');
  out.push(eq);
  out.push('ALL COLLSCAN GROUPS');
  out.push(eq);
  const collscans = ranked.filter((r) => r.collscan_count > 0);
  out.push(`${padR('#', 3)}  ${padL('Count', 6)}  ${padL('COLLSCAN%', 9)}  ${padL('TotalDurMs', 12)}  ${padL('DocsExam', 10)}  ${padL('Returned', 8)}  ns.cmd  [hash]`);
  collscans.forEach((r, idx) => {
    const i = idx + 1;
    const collscanPct = (100 * r.collscan_count) / r.count;
    out.push(`${padL(i, 3)}  ${padL(fmtInt(r.count), 6)}  ${padL(`${Math.round(collscanPct)}%`, 9)}  ${padL(fmtInt(r.total_duration_ms), 12)}  ${padL(fmtInt(r.total_docs_examined), 10)}  ${padL(fmtInt(r.total_nreturned), 8)}  ${r.ns}.${r.cmd_type}  [${r.hash}]`);
    out.push(`     Plan: ${r.dominant_plan}`);
    const appKeys = Object.keys(r.app_names).slice(0, 3);
    out.push(`     Apps: [${appKeys.map((k) => `'${k}'`).join(', ')}]`);
  });

  // ---- HasSortStage groups ----
  out.push('');
  out.push(eq);
  out.push('GROUPS WITH IN-MEMORY SORT (hasSortStage)');
  out.push(eq);
  const sortGroups = ranked.filter((r) => r.has_sort_stage_count > 0);
  out.push(`${padR('#', 3)}  ${padL('SortCnt', 7)}  ${padL('Count', 6)}  ${padL('TotalDurMs', 12)}  ${padL('AvgMs', 7)}  ${padR('Plan', 40)}  ns.cmd`);
  sortGroups.forEach((r, idx) => {
    const i = idx + 1;
    out.push(`${padL(i, 3)}  ${padL(fmtInt(r.has_sort_stage_count), 7)}  ${padL(fmtInt(r.count), 6)}  ${padL(fmtInt(r.total_duration_ms), 12)}  ${padL(Math.round(r.avg_duration_ms).toString(), 7)}  ${padR((r.dominant_plan || '').slice(0, 40), 40)}  ${r.ns}.${r.cmd_type}`);
    out.push(`     Filter: ${jsonDumps(r.filter_shape).slice(0, 100)}`);
  });

  // ---- Replanned groups ----
  out.push('');
  out.push(eq);
  out.push('GROUPS WITH REPLANNING (replanned: true)');
  out.push(eq);
  const replanGroups = ranked.filter((r) => r.replanned_count > 0);
  replanGroups.sort((a, b) => b.replanned_count - a.replanned_count);
  if (replanGroups.length) {
    replanGroups.forEach((r, idx) => {
      const i = idx + 1;
      const reasonTotal = Object.values(r.replan_reasons).reduce((a, b) => a + b, 0);
      out.push(`${padL(i, 3)}  replanned=${r.replanned_count}/${r.count}  ${r.ns}.${r.cmd_type}  [${r.hash}]`);
      out.push(`     Reasons: 10x-threshold (all same root cause), total=${reasonTotal}`);
      out.push(`     Plan: ${r.dominant_plan}`);
    });
  } else {
    out.push('  None found.');
  }

  // ---- Slow write operations ----
  out.push('');
  out.push(eq);
  out.push('SLOW WRITE OPERATIONS SUMMARY');
  out.push(eq);
  const writeTypes = new Set(['update', 'insert', 'delete', 'findAndModify', 'bulkWrite']);
  const writeGroups = ranked.filter((r) => writeTypes.has(r.cmd_type));
  out.push(`${padR('#', 3)}  ${padR('Type', 15)}  ${padL('Count', 6)}  ${padL('TotalDurMs', 12)}  ${padL('AvgMs', 7)}  ${padL('MaxMs', 7)}  ${padR('Plan', 40)}  ns`);
  writeGroups.forEach((r, idx) => {
    const i = idx + 1;
    out.push(`${padL(i, 3)}  ${padR(r.cmd_type, 15)}  ${padL(fmtInt(r.count), 6)}  ${padL(fmtInt(r.total_duration_ms), 12)}  ${padL(Math.round(r.avg_duration_ms).toString(), 7)}  ${padL(fmtInt(r.max_duration_ms), 7)}  ${padR((r.dominant_plan || '').slice(0, 40), 40)}  ${r.ns}`);
    out.push(`     Hash: ${r.hash}`);
    out.push(`     Filter: ${jsonDumps(r.filter_shape).slice(0, 120)}`);
    const appKeys = Object.keys(r.app_names).slice(0, 3);
    out.push(`     Apps: [${appKeys.map((k) => `'${k}'`).join(', ')}]`);
  });

  out.push('');
  out.push(eq);
  out.push('ANALYSIS COMPLETE');
  out.push(eq);

  return out.join('\n') + '\n';
}