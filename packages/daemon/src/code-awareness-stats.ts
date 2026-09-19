/**
 * The code-awareness readout, computed ONCE for both surfaces (#589).
 *
 * WHY ONE MODULE. Daniel's standing rule is that every figure in
 * `bastra logs --stats` has to appear in the UI telemetry in the same change.
 * The two readouts drifted before because each grew its own fold over the same
 * JSONL, so a field added to one was simply missing from the other with nothing
 * failing. This module is the fold; `cli/log-stats-code.ts` renders it as text
 * and `telemetry-report-code.ts` hands the same object to the Telemetry tab.
 *
 * WHAT IT COVERS. The ACTIVE half of code awareness — the two tools an agent
 * calls on purpose and the graph refreshes that keep their answers current. The
 * PASSIVE half (the dependents block the Write/Edit lane injects, its token cost
 * and its `followed` signal) is #579's `CodeRoiStats` and stays where it is:
 * that one is folded out of `hook_call` rows, this one out of its own events.
 *
 * WHAT IT DOES NOT CLAIM. Same caveat as #579: these are calls and answers, not
 * value. A `find_code` that answered says the graph had something to say, not
 * that the agent needed it.
 */

/** Minimal row shape — the readers parse raw JSONL, so every field is unknown. */
export interface CodeEventRow {
  kind?: unknown;
  ts?: unknown;
  tool?: unknown;
  status?: unknown;
  mode?: unknown;
  lane?: unknown;
  basis?: unknown;
  unavailable_reason?: unknown;
  hits?: unknown;
  files?: unknown;
  took_ms?: unknown;
  repo?: unknown;
  surface?: unknown;
  reason?: unknown;
  outcome?: unknown;
  duration_ms?: unknown;
  detail?: unknown;
  external_total?: unknown;
  external_resolved?: unknown;
  /** #606 — `delivered` rows only. */
  delivered_lane?: unknown;
  tokens_est?: unknown;
  dedupe_hit?: unknown;
}

export interface Counted {
  key: string;
  count: number;
}

export interface ToolStats {
  tool: string;
  calls: number;
  /** Answered with at least one hit. */
  ok: number;
  /** The graph was there and knew nothing — an honest empty answer. */
  noAnswer: number;
  /** The graph could not be asked at all. */
  unavailable: number;
  /** Why, when it could not: off_env, not_enabled, degraded, not_indexed, loading, cold. */
  byUnavailableReason: Counted[];
  /** find_code: which lane answered. find_affected_files: which basis. */
  byKind: Counted[];
  /** Files named across all answers — the reach of the answers that came back. */
  filesNamed: number;
  /** Wall clock inside the tool, milliseconds. */
  p50: number;
  p90: number;
}

export interface RefreshStats {
  /** Runs that started. */
  started: number;
  ok: number;
  failed: number;
  locked: number;
  skipped: number;
  givenUp: number;
  byReason: Counted[];
  /** Milliseconds a repository was behind, start → terminal outcome. */
  p50: number;
  p90: number;
  /** Short failure details, biggest first — never a path or a command line. */
  failures: Counted[];
}

export interface RepoRow {
  repo: string;
  toolCalls: number;
  refreshes: number;
  /** The newest `external nodes / resolved` this repository reported (#582). */
  externalTotal: number | null;
  externalResolved: number | null;
}

/**
 * The blocks Recall DELIVERED without being asked (#606) — the same
 * `find_affected_files` answer, arriving through a hook lane instead of a tool
 * call.
 *
 * Counted apart from `tools` on purpose. The question the tool row answers is
 * "does anyone call this?", and folding deliveries into it would answer that
 * question with Recall's own injections — the one number that cannot be
 * evidence for it.
 */
export interface DeliveredStats {
  /** Blocks that actually reached a transcript. */
  blocks: number;
  /** Answers suppressed because the same one had already gone out this session. */
  dedupeHits: number;
  /** prompt | write. */
  byLane: Counted[];
  /** symbols | diff | whole_file — how sharp the delivered answers were. */
  byBasis: Counted[];
  /** Candidate files named across all delivered blocks. */
  filesNamed: number;
  /** Estimated tokens spent on them — the cost side. */
  tokensTotal: number;
  tokensMedian: number;
  /** Wall clock inside the block builder, milliseconds. */
  p50: number;
  p90: number;
}

export interface CodeAwarenessStats {
  /** Rows seen at all — 0 means the window has no code-awareness events. */
  events: number;
  tools: ToolStats[];
  /** #606: the delivered half, never mixed into `tools`. */
  delivered: DeliveredStats;
  refresh: RefreshStats;
  repos: RepoRow[];
}

/**
 * A throwaway tree from the measurement harness (packages/eval/code-roi) is
 * built under the OS temp directory, but by the time its `repo` field lands
 * in an event, `shortRepo` (code-graph/unavailable-note.ts) has already
 * collapsed the full path to its last one or two segments — whether it once
 * lived under a temp root is otherwise lost by here. What survives the
 * collapse is still unambiguous: a plain `/tmp` root shortens to "tmp", and
 * macOS's $TMPDIR convention (.../T/<random>) shortens to "T/…". No real
 * project is ever named "tmp" or nested directly under a bare "T" directory,
 * so folding both into one row is safe, and reads better than leaving a
 * throwaway sandbox sitting in the repository list next to real projects.
 */
export const TEMPORARY_TREE_LABEL = "(temporary tree)";

function isTemporaryTreeLabel(repo: string): boolean {
  const first = repo.split("/")[0] ?? repo;
  return first.toLowerCase() === "tmp" || first === "T";
}

/** Merge every temp-tree repo into one row; real repos pass through untouched. */
function foldTemporaryTrees(rows: readonly RepoRow[]): RepoRow[] {
  const real: RepoRow[] = [];
  let sawTemp = false;
  let toolCalls = 0;
  let refreshes = 0;
  for (const r of rows) {
    if (!isTemporaryTreeLabel(r.repo)) {
      real.push(r);
      continue;
    }
    sawTemp = true;
    toolCalls += r.toolCalls;
    refreshes += r.refreshes;
  }
  // No external total/resolved on the merged row — those describe one
  // repository's current state, and summing them across unrelated throwaway
  // trees would not mean anything.
  if (sawTemp) real.push({ repo: TEMPORARY_TREE_LABEL, toolCalls, refreshes, externalTotal: null, externalResolved: null });
  return real;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0;
}

const bump = (m: Map<string, number>, key: string): void => {
  m.set(key, (m.get(key) ?? 0) + 1);
};
const counted = (m: Map<string, number>): Counted[] =>
  [...m].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);

interface MutableTool {
  calls: number;
  ok: number;
  noAnswer: number;
  unavailable: number;
  reasons: Map<string, number>;
  kinds: Map<string, number>;
  filesNamed: number;
  took: number[];
}

const emptyTool = (): MutableTool => ({
  calls: 0,
  ok: 0,
  noAnswer: 0,
  unavailable: 0,
  reasons: new Map(),
  kinds: new Map(),
  filesNamed: 0,
  took: [],
});

/** The two tools always appear in this order, so the table does not reshuffle. */
export const CODE_TOOLS = ["find_code", "find_affected_files"] as const;

export function aggregateCodeAwareness(rows: readonly CodeEventRow[]): CodeAwarenessStats {
  const tools = new Map<string, MutableTool>();
  const repos = new Map<string, { toolCalls: number; refreshes: number; total: number | null; resolved: number | null }>();
  const refreshReasons = new Map<string, number>();
  const refreshFailures = new Map<string, number>();
  const durations: number[] = [];
  let events = 0;
  let started = 0;
  let ok = 0;
  let failed = 0;
  let locked = 0;
  let skipped = 0;
  let givenUp = 0;

  const repoOf = (v: unknown) => {
    const name = str(v) ?? "(unknown)";
    let r = repos.get(name);
    if (r === undefined) {
      r = { toolCalls: 0, refreshes: 0, total: null, resolved: null };
      repos.set(name, r);
    }
    return r;
  };

  const delivered = {
    blocks: 0,
    dedupeHits: 0,
    lanes: new Map<string, number>(),
    bases: new Map<string, number>(),
    filesNamed: 0,
    tokens: [] as number[],
    took: [] as number[],
  };

  for (const e of rows) {
    if (e.kind === "code_tool_call") {
      events++;
      // #606: a delivered block is the same answer, not a call. It gets its own
      // fold; letting it into `tools` would make "does anyone call this tool?"
      // answer itself with Recall's own injections.
      if (str(e.surface) === "delivered") {
        bump(delivered.lanes, str(e.delivered_lane) ?? "unknown");
        if (e.dedupe_hit === true) {
          delivered.dedupeHits++;
          continue;
        }
        delivered.blocks++;
        const basis = str(e.basis);
        if (basis !== null) bump(delivered.bases, basis);
        delivered.filesNamed += num(e.files) ?? 0;
        const tokens = num(e.tokens_est);
        if (tokens !== null) delivered.tokens.push(tokens);
        const deliveredTook = num(e.took_ms);
        if (deliveredTook !== null) delivered.took.push(deliveredTook);
        continue;
      }
      const name = str(e.tool) ?? "(unknown)";
      let t = tools.get(name);
      if (t === undefined) {
        t = emptyTool();
        tools.set(name, t);
      }
      t.calls++;
      const status = str(e.status) ?? "unknown";
      if (status === "ok") t.ok++;
      else if (status === "no_answer") t.noAnswer++;
      else if (status === "unavailable") {
        t.unavailable++;
        // A row without the field predates it; counted as unavailable, never
        // assigned a reason it never carried.
        bump(t.reasons, str(e.unavailable_reason) ?? "unknown");
      }
      const kind = str(e.lane) ?? str(e.basis);
      if (kind !== null) bump(t.kinds, kind);
      t.filesNamed += num(e.files) ?? 0;
      const took = num(e.took_ms);
      if (took !== null) t.took.push(took);
      repoOf(e.repo).toolCalls++;
      continue;
    }
    if (e.kind !== "code_graph_refresh") continue;
    events++;
    const outcome = str(e.outcome) ?? "unknown";
    const r = repoOf(e.repo);
    if (outcome === "started") {
      started++;
      bump(refreshReasons, str(e.reason) ?? "unknown");
      continue;
    }
    if (outcome === "ok") {
      ok++;
      r.refreshes++;
      const total = num(e.external_total);
      const resolved = num(e.external_resolved);
      if (total !== null) r.total = total;
      if (resolved !== null) r.resolved = resolved;
    } else if (outcome === "failed") {
      failed++;
      bump(refreshFailures, str(e.detail) ?? "unknown");
    } else if (outcome === "locked") locked++;
    else if (outcome === "skipped") skipped++;
    else if (outcome === "given-up") givenUp++;
    const d = num(e.duration_ms);
    if (d !== null) durations.push(d);
  }

  const order = [...CODE_TOOLS, ...[...tools.keys()].filter((k) => !CODE_TOOLS.includes(k as never))];
  return {
    events,
    tools: order
      .filter((name) => tools.has(name))
      .map((tool) => {
        const t = tools.get(tool)!;
        return {
          tool,
          calls: t.calls,
          ok: t.ok,
          noAnswer: t.noAnswer,
          unavailable: t.unavailable,
          byUnavailableReason: counted(t.reasons),
          byKind: counted(t.kinds),
          filesNamed: t.filesNamed,
          p50: quantile(t.took, 0.5),
          p90: quantile(t.took, 0.9),
        };
      }),
    delivered: {
      blocks: delivered.blocks,
      dedupeHits: delivered.dedupeHits,
      byLane: counted(delivered.lanes),
      byBasis: counted(delivered.bases),
      filesNamed: delivered.filesNamed,
      tokensTotal: delivered.tokens.reduce((a, b) => a + b, 0),
      tokensMedian: quantile(delivered.tokens, 0.5),
      p50: quantile(delivered.took, 0.5),
      p90: quantile(delivered.took, 0.9),
    },
    refresh: {
      started,
      ok,
      failed,
      locked,
      skipped,
      givenUp,
      byReason: counted(refreshReasons),
      p50: quantile(durations, 0.5),
      p90: quantile(durations, 0.9),
      failures: counted(refreshFailures).slice(0, 5),
    },
    repos: foldTemporaryTrees(
      [...repos].map(([repo, r]) => ({
        repo,
        toolCalls: r.toolCalls,
        refreshes: r.refreshes,
        externalTotal: r.total,
        externalResolved: r.resolved,
      })),
    ).sort((a, b) => b.toolCalls + b.refreshes - (a.toolCalls + a.refreshes)),
  };
}
