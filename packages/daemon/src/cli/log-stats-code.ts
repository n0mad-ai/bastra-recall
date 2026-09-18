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
 * an agent did not run. The measured comparison against a no-graph control
 * arm lives in `packages/eval/code-roi/` and says, as of 2026-09-18, that a
 * targeted grep is cheaper per lookup — while also finding only 23 of 40
 * symbols. Treat this section as the cost ledger, not as the verdict.
 *
 * Split out of log-stats.ts, which is already at the file-size ceiling.
 */

/** One hook_call row, reduced to the fields this section reads. */
export interface CodeRoiRow {
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

  return {
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
