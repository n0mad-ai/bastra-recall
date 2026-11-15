/**
 * Turn-start prewarm of the embedding model (#361, split out of #350).
 *
 * The assertion lane is the one that lands cold. #342 gave the dense arm a
 * 150ms deadline, which made a cold call CHEAP, not GOOD: past the deadline
 * the arm is dropped (`degraded: "vector-arm-timeout"`) and the hit list comes
 * back BM25-only — the lane arrives on time and says less. #305 measured the
 * cold model as that variance (cold ~860ms → 341ms warm).
 *
 * A turn has a known start: `UserPromptSubmit` fires before any tool call, and
 * since #343 the daemon serves that lane itself, so it sees every turn start
 * without a new client call. One small embed kicked off there — never awaited,
 * never in the lane's critical path — leaves the model resident by the time the
 * first assertion call fires seconds later.
 *
 * Deliberately NOT `keep_alive: -1`: that pins ~600MB of RAM across idle gaps
 * for as long as the daemon lives, which is exactly what #78 rejected. The
 * model here is only ever warm while a turn is actually running; the ordinary
 * keep_alive window (#78, default 10m per embed request) lets it fall out of
 * RAM once the work stops.
 */

/**
 * Debounce window — a turn starting inside it needs no warm-up.
 *
 * Sized against the keep_alive the daemon already sends per embed request
 * (#78: default "10m"), so one minute is a wide safety margin even for a user
 * who lowered it: within 60s of the last warm the model is resident under any
 * sane setting, and the call would be pure noise. It also caps the cost of a
 * burst of short turns at one embed per minute of active work.
 */
export const PREWARM_DEBOUNCE_MS = 60_000;

/** What the turn-start prewarm did — one field on `prompt_hook_call` (#361). */
export type PrewarmOutcome = "fired" | "skipped-debounce" | "skipped-no-provider" | "skipped-hosted";

/** Fires the warm call; returns what it decided. Never throws, never blocks. */
export type Prewarmer = () => PrewarmOutcome;

export interface PrewarmOptions {
  /**
   * Is the dense arm actually available right now? Same question the recall
   * path asks before flagging `embedding_degraded`: an attached embedding index
   * AND a circuit breaker (#165) that is not open. Half-open passes on purpose —
   * the warm call is a real embed and may serve as the breaker's single probe.
   */
  denseArmAvailable: () => boolean;
  /**
   * Is the active provider a HOSTED one? Then there is nothing to warm: the
   * cold model this feature exists for is a model whose residency we control
   * (Ollama, via the per-request keep_alive of #78 — a remote Ollama behind
   * BASTRA_ALLOW_REMOTE_OLLAMA counts, the criterion is the model, not the
   * network hop). Against a hosted embedding API the warm call buys nothing
   * and costs one egress request per minute of active work. Absent = treat
   * the provider as one worth warming.
   */
  hostedProvider?: () => boolean;
  /** The one small embed. Its promise is never awaited by the lane. */
  warm: () => Promise<unknown>;
  /** Injected clock — the debounce is tested hermetically, not with sleeps. */
  now?: () => number;
  /** Debug sink for a failed warm call. Absent = swallowed silently. */
  onError?: (err: unknown) => void;
}

/**
 * Build the daemon's single prewarmer. The debounce state is per process, not
 * per session: the model is a machine-wide resource, so two sessions starting
 * turns a second apart must not warm it twice.
 */
export function createEmbeddingPrewarmer(opts: PrewarmOptions): Prewarmer {
  const now = opts.now ?? Date.now;
  let lastFiredMs: number | null = null;

  return () => {
    // Hosted API: no cold model, so the warm call would be pure egress. Asked
    // BEFORE availability because it is the cheaper and more specific answer —
    // "there is nothing here to warm" is not the same event as "the arm is
    // down", and the two must stay apart in the telemetry.
    if (opts.hostedProvider?.() === true) return "skipped-hosted";

    // Off, or the breaker is open: no provider call at all. The breaker exists
    // precisely so a wedged Ollama is not paid for once per query — warming it
    // per turn would reintroduce that cost behind the breaker's back.
    if (!opts.denseArmAvailable()) return "skipped-no-provider";

    const t = now();
    if (lastFiredMs !== null && t - lastFiredMs < PREWARM_DEBOUNCE_MS) return "skipped-debounce";
    // Stamped BEFORE the call, not after it resolves: a cold warm takes ~860ms
    // (#305) and the next turn must debounce against the attempt, not wait for
    // its result.
    lastFiredMs = t;

    try {
      void Promise.resolve(opts.warm()).catch((err) => opts.onError?.(err));
    } catch (err) {
      // A `warm` that throws synchronously (misconfigured provider URL) must
      // not reach the lane either.
      opts.onError?.(err);
    }
    return "fired";
  };
}
