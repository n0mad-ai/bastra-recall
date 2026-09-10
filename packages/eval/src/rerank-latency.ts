/**
 * The cost half of #501, kept apart from the quality half on purpose.
 *
 * `rerank-replay.ts` answers "does the order get better?". This answers "what
 * does that cost?", and the two have almost nothing in common: one runs a
 * model over every case once and does statistics, the other runs it many times
 * over a few cases and does timing. Sharing a file would have meant one set of
 * loops serving two questions badly.
 *
 * Neither number means anything without the other, which is why #501 refuses
 * to be answered by either alone.
 */
import type { Memory } from "@bastra-recall/core";
import { passageFor, type PairScorer, type PassageMode } from "./rerank-model.js";
import type { CaseRow } from "./rerank-report.js";

export interface LatencyReport {
  model: string;
  passage: PassageMode;
  n: number;
  /** Model load in a fresh process, reported ALONE — see below. */
  load_ms: number;
  /**
   * The first scored batch at this N. Only a genuine COLD call for the first N
   * in a fresh process — after that the ONNX session is warm and this is just
   * the first sample. The report says which, rather than labelling all three
   * "cold" and inviting the reader to believe it.
   */
  first_call_ms: number;
  first_call_is_cold: boolean;
  warm_p50_ms: number;
  warm_p95_ms: number;
  samples: number;
}

/**
 * The added latency, measured — not estimated, and not contaminated by Ollama.
 *
 * Three deliberate choices, all of them from §4 of the measurement plan:
 *
 * 1. **The rerank is timed on its own span, inside the call.** The alternative
 *    — diffing two end-to-end runs — would charge the reranker for whatever
 *    the dense arm happened to be doing, and on this machine Ollama and the
 *    cross-encoder share the hardware. Whatever a case cost in `recallHybrid`
 *    sits outside this span entirely.
 * 2. **Real N-sized batches.** Everywhere else one deep scoring pass covers
 *    every N; here it cannot, because the batch size is the question.
 * 3. **Model load is reported beside the score times, never folded into a
 *    "cold p95".** It is a process-start cost that would live in the prewarm
 *    lane (#361) in production, not in a recall. Adding the two would invent a
 *    number no user ever waits for.
 *
 * The caller is responsible for the fourth: no other model work on the machine
 * while this runs. A contended run is discarded, not interpreted.
 */
export async function measureLatency(
  scorer: PairScorer,
  mode: PassageMode,
  rows: readonly CaseRow[],
  memoryOf: (id: string) => Memory | undefined,
  model: string,
  ns: readonly number[],
  /**
   * True while the scorer has not scored anything yet in this process. The
   * caller owns it because only the caller knows whether an earlier arm
   * already warmed the session — a per-N "cold" would otherwise be three cold
   * numbers of which two are warm.
   */
  state: { scoredAnything: boolean },
): Promise<LatencyReport[]> {
  const out: LatencyReport[] = [];
  for (const n of ns) {
    const samples: number[] = [];
    let firstCall: number | null = null;
    let firstWasCold = false;
    for (const row of rows) {
      const window = row.baseline.slice(0, n);
      // A pool shallower than N would time a smaller batch and report it under
      // this N. Skipping is the honest choice; `samples` says how many remain.
      if (window.length < n) continue;
      const passages = window.map((h) => {
        const m = memoryOf(h.id);
        if (!m) throw new Error(`pooled id ${h.id} is not in the vault`);
        return passageFor(m, mode);
      });
      const t = process.hrtime.bigint();
      await scorer.score(row.query, passages);
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      if (firstCall === null) {
        firstCall = ms;
        firstWasCold = !state.scoredAnything;
        state.scoredAnything = true;
      } else {
        samples.push(ms);
      }
    }
    samples.sort((a, b) => a - b);
    out.push({
      model,
      passage: mode,
      n,
      load_ms: scorer.loadMs,
      first_call_ms: firstCall ?? 0,
      first_call_is_cold: firstWasCold,
      warm_p50_ms: samples.length ? samples[Math.floor(0.5 * samples.length)] : 0,
      warm_p95_ms: samples.length ? samples[Math.min(samples.length - 1, Math.floor(0.95 * samples.length))] : 0,
      samples: samples.length,
    });
  }
  return out;
}

