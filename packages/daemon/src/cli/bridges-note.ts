/**
 * The bridge-learning note in `bastra doctor` (#672).
 *
 * WHY. zzallirog's vault minted 3,435 bridge candidates in a month and wrote
 * none, and his reranker harvest was dead for weeks — `bastra doctor` said
 * nothing about either. Learned bridges are an opt-in background feature: when
 * they stop learning, recall keeps working and nobody notices. This note says
 * it out loud.
 *
 * WHAT IT READS. The `bridges_mint` telemetry events of the last
 * {@link BRIDGE_STALL_WINDOW_DAYS} days (one per mint run, daemon or CLI), and
 * `last-mint.json` as a fallback for a machine with telemetry off. Each run
 * recounts the whole log, so per-run numbers are NOT summed — only "did any run
 * write a bridge" and the latest run's numbers are reported.
 *
 * Like every other global note: silent when shared recall is off (a feature
 * that is switched off is the features note's business), never a failure,
 * never throws.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LastMintRecord } from "../learned-recall/mint-job.js";

/** The window the note looks back over — the unconfirmed-bridge TTL and the
 *  curator window, so "stalled" means "nothing learned in one full cycle". */
export const BRIDGE_STALL_WINDOW_DAYS = 30;

export interface MintRun {
  ts: string;
  minted: number;
  reaches: number;
  written: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The note's lines, pure. Empty when shared recall is off. One line otherwise:
 * a warning with a hint when learning is stalled, an ok line when it is not.
 */
export function bridgeLearningLines(input: { enabled: boolean; runs: MintRun[]; now: Date }): string[] {
  if (!input.enabled) return [];
  const cutoff = input.now.getTime() - BRIDGE_STALL_WINDOW_DAYS * DAY_MS;
  const runs = input.runs
    .filter((r) => Number.isFinite(Date.parse(r.ts)) && Date.parse(r.ts) >= cutoff)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const days = BRIDGE_STALL_WINDOW_DAYS;
  if (runs.length === 0) {
    return [
      `⚠ no bridge mint ran in the last ${days} days — the daemon mints after boot and then daily; start it or run 'bastra bridges mint'`,
    ];
  }
  const last = runs[runs.length - 1];
  const anyWritten = runs.some((r) => r.written > 0);
  if (anyWritten) {
    return [`✓ ok: bridges learned in the last ${days} days (${runs.length} mint run(s), last: ${last.written} written)`];
  }
  if (runs.some((r) => r.minted > 0)) {
    return [
      `⚠ bridge learning stalled: ${runs.length} mint run(s) in ${days} days minted candidates but wrote none (last: ${last.minted} minted, 0 written) — ` +
        "builds before #672 held back single-reach bridges; update and run 'bastra bridges mint'",
    ];
  }
  if (runs.every((r) => r.reaches === 0)) {
    return [
      `⚠ no bridge learned in ${days} days: ${runs.length} mint run(s) found no acted-on recalls in the telemetry log — ` +
        "bridges learn from it, so check that BASTRA_TELEMETRY is not 'off'",
    ];
  }
  // Reaches, but none far enough to mint from: recall already found every
  // memory with the words used. Nothing to learn is not a fault.
  return [`✓ ok: ${runs.length} mint run(s) in ${days} days, no recall needed a bridge (last: ${last.reaches} acted-on reach(es))`];
}

/**
 * The mint runs of the last `days` days: `bridges_mint` events from the
 * telemetry log, plus `last-mint.json` when the log does not already carry that
 * run (telemetry off). Only files whose date is inside the window are read, and
 * only lines naming the event are parsed.
 */
export async function readMintRuns(
  logDir: string,
  lastMint: LastMintRecord | null,
  now: Date,
  days: number = BRIDGE_STALL_WINDOW_DAYS,
): Promise<MintRun[]> {
  const runs: MintRun[] = [];
  const firstDay = new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10);
  let files: string[] = [];
  try {
    files = (await readdir(logDir)).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(7, 17) >= firstDay);
  } catch {
    /* no log dir → only last-mint.json can speak */
  }
  for (const f of files) {
    let raw: string;
    try {
      raw = await readFile(join(logDir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.includes('"bridges_mint"')) continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        const run = toRun(e);
        if (e.kind === "bridges_mint" && run) runs.push(run);
      } catch {
        /* malformed line */
      }
    }
  }
  const fallback = lastMint ? toRun(lastMint as unknown as Record<string, unknown>) : null;
  if (fallback && !runs.some((r) => r.ts === fallback.ts)) runs.push(fallback);
  return runs;
}

function toRun(e: Record<string, unknown>): MintRun | null {
  if (typeof e.ts !== "string") return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { ts: e.ts, minted: num(e.minted), reaches: num(e.reaches), written: num(e.written) };
}
