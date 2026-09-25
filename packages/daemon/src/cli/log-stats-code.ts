/**
 * The `code search ROI` section of `bastra stats` (#579).
 *
 * WHY THIS EXISTS AS A SECTION OF ITS OWN. The pre-registration asks for the
 * cost and the reach of code awareness to be visible next to real session
 * data, not derived after the fact from a benchmark. Until this landed, a
 * hook call that spent 300 tokens on a dependents block and one that spent
 * them on memory hints looked identical in the telemetry — `hint_tokens_est`
 * counts the whole injected document.
 *
 * WHAT IT DOES NOT CLAIM. It reports what the feature COST and what it
 * OFFERED: tokens spent, dependants named, how often the graph was behind.
 * It cannot report what it SAVED, because the daemon cannot see the searches
 * an agent did not run. The comparison against a no-graph control arm lives
 * in `packages/eval/code-roi/`; as of 2026-09-18 it holds no verdict for the
 * current code (#588). Treat this section as the cost ledger, not as the
 * verdict.
 *
 * The one USE signal it can see is `followed`: a block named a file, and a
 * later write in the same session targeted that file — the registered
 * secondary `dependents_block_followed_by_edit`. A follow-up edit is evidence
 * the list mattered, not proof the block caused it; the agent may have gone
 * there anyway.
 *
 * Split out of log-stats.ts, which is already at the file-size ceiling.
 */

/**
 * WHAT #579 ADDED. The block above is the PASSIVE half — what the Write/Edit
 * lane injected without being asked. The two tools an agent calls ON PURPOSE
 * (`find_code`, `find_affected_files`) wrote nothing at all until #579, so
 * "nobody calls code awareness" and "code awareness answers nothing" were the
 * same empty log, and the `unavailable` cases — off, not indexed, still
 * loading, refused — were indistinguishable from each other and from silence.
 * `code_tool_call` and `code_graph_refresh` are the active half.
 */

import type { CodeAwarenessStats, Counted } from "../code-awareness-stats.js";

/** One hook_call row, reduced to the fields this section reads. */
export interface CodeRoiRow {
  ts?: unknown;
  session_id?: unknown;
  code_listed?: unknown;
  code_targets?: unknown;
  code_block_tokens_est?: unknown;
  code_dependents?: unknown;
  code_stale?: unknown;
  applies_to_tokens_est?: unknown;
  applies_to_count?: unknown;
  hint_tokens_est?: unknown;
}

export interface CodeRoiStats {
  /** hook_call events seen at all — the denominator. */
  calls: number;
  /** …of which carried a dependents block. */
  withCodeBlock: number;
  /** …of which carried an affects_files block. */
  withAppliesTo: number;
  codeTokensTotal: number;
  codeTokensMedian: number;
  dependentsTotal: number;
  dependentsMedian: number;
  staleBlocks: number;
  appliesToTokensTotal: number;
  appliesToCount: number;
  /** Tokens of everything injected, so the code share is readable. */
  hintTokensTotal: number;
  /** Blocks that logged the files they named (rows from before #588 did not). */
  blocksWithListed: number;
  /** …of which a later write in the same session targeted a named file. */
  blocksFollowed: number;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)] ?? 0;
}

/**
 * Aggregate the code-awareness fields out of the hook_call rows.
 *
 * Rows from before the fields existed simply do not carry them, and are
 * counted in `calls` but nowhere else — so an upgrade does not make the
 * history look like the feature was switched off.
 */
export function aggregateCodeRoi(rows: readonly CodeRoiRow[]): CodeRoiStats {
  const codeTokens: number[] = [];
  const dependents: number[] = [];
  let withCodeBlock = 0;
  let withAppliesTo = 0;
  let staleBlocks = 0;
  let appliesToTokensTotal = 0;
  let appliesToCount = 0;
  let hintTokensTotal = 0;

  for (const r of rows) {
    const ht = num(r.hint_tokens_est);
    if (ht !== null) hintTokensTotal += ht;

    const ct = num(r.code_block_tokens_est);
    if (ct !== null) {
      withCodeBlock++;
      codeTokens.push(ct);
      const d = num(r.code_dependents);
      if (d !== null) dependents.push(d);
      if (r.code_stale === true) staleBlocks++;
    }
    const at = num(r.applies_to_tokens_est);
    if (at !== null) {
      withAppliesTo++;
      appliesToTokensTotal += at;
      appliesToCount += num(r.applies_to_count) ?? 0;
    }
  }

  const follow = followedByEdit(rows);

  return {
    ...follow,
    calls: rows.length,
    withCodeBlock,
    withAppliesTo,
    codeTokensTotal: codeTokens.reduce((a, b) => a + b, 0),
    codeTokensMedian: median(codeTokens),
    dependentsTotal: dependents.reduce((a, b) => a + b, 0),
    dependentsMedian: median(dependents),
    staleBlocks,
    appliesToTokensTotal,
    appliesToCount,
    hintTokensTotal,
  };
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * `dependents_block_followed_by_edit` (#588): per session, in time order, did
 * a later write target a file an earlier block named? Each block counts once,
 * however many of its files were edited afterwards.
 */
function followedByEdit(rows: readonly CodeRoiRow[]): { blocksWithListed: number; blocksFollowed: number } {
  const ordered = rows
    .filter((r) => typeof r.session_id === "string" && typeof r.ts === "string")
    .sort((a, b) => (a.ts as string).localeCompare(b.ts as string));
  const open = new Map<string, Array<{ listed: Set<string>; followed: boolean }>>();
  let blocksWithListed = 0;
  let blocksFollowed = 0;
  for (const r of ordered) {
    const blocks = open.get(r.session_id as string) ?? [];
    for (const target of strings(r.code_targets)) {
      for (const b of blocks) {
        if (!b.followed && b.listed.has(target)) {
          b.followed = true;
          blocksFollowed++;
        }
      }
    }
    const listed = strings(r.code_listed);
    if (listed.length > 0) {
      blocksWithListed++;
      blocks.push({ listed: new Set(listed), followed: false });
      open.set(r.session_id as string, blocks);
    }
  }
  return { blocksWithListed, blocksFollowed };
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(0)}%` : "—";
}

/**
 * Render the section, or nothing at all.
 *
 * Silence is the honest output when the feature never fired: a section of
 * zeroes reads like a measurement, and there is nothing measured here.
 */
export function renderCodeRoi(s: CodeRoiStats): string[] {
  if (s.withCodeBlock === 0 && s.withAppliesTo === 0) return [];

  const lines = ["", "code search ROI"];
  lines.push(
    `  dependents block: ${s.withCodeBlock} of ${s.calls} write/edit calls (${pct(s.withCodeBlock, s.calls)})`,
  );
  if (s.withCodeBlock > 0) {
    lines.push(
      `    cost: ${s.codeTokensTotal} tokens total, ${s.codeTokensMedian} median` +
        (s.hintTokensTotal > 0
          ? ` — ${pct(s.codeTokensTotal, s.hintTokensTotal)} of everything injected`
          : ""),
    );
    lines.push(
      `    reach: ${s.dependentsTotal} dependants named, ${s.dependentsMedian} median per block`,
    );
    if (s.blocksWithListed > 0) {
      lines.push(
        `    followed: ${s.blocksFollowed} of ${s.blocksWithListed} blocks (${pct(s.blocksFollowed, s.blocksWithListed)}) ` +
          "were followed by an edit to a file they named, same session",
      );
    }
    if (s.staleBlocks > 0) {
      lines.push(
        `    ${s.staleBlocks} of them (${pct(s.staleBlocks, s.withCodeBlock)}) were marked possibly out of date`,
      );
    }
  }
  if (s.withAppliesTo > 0) {
    lines.push(
      `  affects_files block: ${s.withAppliesTo} calls, ${s.appliesToTokensTotal} tokens, ` +
        `${s.appliesToCount} memories attached`,
    );
  }
  // Said every time the section renders, because the number above is the cost
  // and reads like a benefit if nothing says otherwise.
  lines.push(
    "    (cost and reach — what it SAVED needs the control arm in packages/eval/code-roi)",
  );
  return lines;
}

/**
 * The ACTIVE half (#579): the two tools an agent calls, and the refreshes that
 * keep their answers current.
 *
 * Silent when the window holds no code-awareness event, for the same reason
 * `renderCodeRoi` is: a table of zeroes reads like a measurement.
 */
export function renderCodeAwareness(s: CodeAwarenessStats): string[] {
  if (s.events === 0) return [];
  const lines = ["", "code awareness (experimental) — tool calls"];
  for (const t of s.tools) {
    lines.push(
      `  ${t.tool}: ${t.calls} call(s) — ${t.ok} answered (${pct(t.ok, t.calls)}), ` +
        `${t.noAnswer} nothing found, ${t.unavailable} unavailable`,
    );
    if (t.byKind.length > 0) {
      lines.push(`    by ${t.tool === "find_code" ? "lane" : "basis"}: ${list(t.byKind)}`);
    }
    if (t.byUnavailableReason.length > 0) {
      lines.push(`    unavailable because: ${list(t.byUnavailableReason)}`);
    }
    lines.push(`    latency: p50 ${t.p50.toFixed(1)}ms, p90 ${t.p90.toFixed(1)}ms · ${t.filesNamed} file(s) named`);
  }
  // #606: the delivered half. Its own lines, not a row in the tool table — a
  // block Recall injected is not evidence that anyone calls the tool.
  const d = s.delivered;
  if (d.blocks > 0 || d.dedupeHits > 0) {
    lines.push(
      `  delivered blocks: ${d.blocks} injected, ${d.dedupeHits} suppressed as already delivered this session`,
    );
    if (d.byLane.length > 0) lines.push(`    by lane: ${list(d.byLane)}`);
    if (d.byBasis.length > 0) lines.push(`    by basis: ${list(d.byBasis)}`);
    lines.push(
      `    cost: ${d.tokensTotal} tokens total, ${d.tokensMedian} median · ${d.filesNamed} file(s) named`,
    );
    lines.push(`    latency: p50 ${d.p50.toFixed(1)}ms, p90 ${d.p90.toFixed(1)}ms`);
  }
  if (s.refresh.started > 0 || s.refresh.ok > 0) {
    lines.push(
      `  graph refresh: ${s.refresh.started} run(s) — ${s.refresh.ok} ok, ${s.refresh.failed} failed, ` +
        `${s.refresh.locked} locked, ${s.refresh.skipped} skipped, ${s.refresh.givenUp} given up`,
    );
    lines.push(`    duration: p50 ${Math.round(s.refresh.p50)}ms, p90 ${Math.round(s.refresh.p90)}ms`);
    if (s.refresh.byReason.length > 0) lines.push(`    triggered by: ${list(s.refresh.byReason)}`);
    if (s.refresh.failures.length > 0) lines.push(`    failures: ${list(s.refresh.failures)}`);
  }
  if (s.repos.length > 0) {
    lines.push(`  repositories active: ${s.repos.length}`);
    for (const r of s.repos.slice(0, 6)) {
      const ext =
        r.externalTotal !== null
          ? ` · ${r.externalTotal} external nodes, ${r.externalResolved ?? 0} resolved`
          : "";
      lines.push(`    ${r.repo}: ${r.toolCalls} tool call(s), ${r.refreshes} refresh(es)${ext}`);
    }
  }
  return lines;
}

/** `a×3, b×1` — the same one-line shape the save and suppression lines use. */
function list(rows: readonly Counted[]): string {
  return rows.map((r) => `${r.key}×${r.count}`).join(", ");
}
