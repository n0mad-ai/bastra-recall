/**
 * Embedding circuit breaker (#165) — degrade hybrid recall to BM25-only
 * after consecutive provider failures instead of paying a timeout per query
 * against a wedged/cold Ollama. Recall latency is sacred; the lexical leg
 * works without embeddings.
 *
 * State machine (pure, nowMs injected — hermetic tests):
 *   CLOSED    — attempts allowed. K consecutive failures → OPEN.
 *   OPEN      — attempts denied for a cooldown window (no provider call,
 *               no timeout cost). Cooldown elapsed → HALF-OPEN.
 *   HALF-OPEN — exactly ONE probe call attempts the provider; success
 *               re-closes, failure re-opens with a fresh cooldown.
 * A success anywhere (query or backfill batch) resets the failure counter —
 * the breaker sits at the provider boundary, so both paths feed it.
 *
 * Wiring: BreakerGuardedProvider wraps the resolved EmbeddingProvider in
 * index.ts. EmbeddingIndex.search() already catches embed errors and falls
 * back to an empty vector leg, so a BreakerOpenError degrades recallHybrid
 * to BM25-only without touching any search code.
 */
import type { EmbeddingProvider, EmbedWithMeta } from "@bastra-recall/core";

/** K — consecutive failures before the breaker opens. */
export const BREAKER_FAILURE_THRESHOLD = 3;
/** Cooldown while OPEN before the single HALF-OPEN probe is allowed. */
export const BREAKER_COOLDOWN_MS = 60_000;

export type BreakerState = "closed" | "open" | "half-open";

/** JSON-friendly snapshot for /health (snake_case like the rest of the payload). */
export interface EmbeddingBreakerSnapshot {
  state: BreakerState;
  consecutive_failures: number;
  opened_at_ms: number | null;
  /** ms until the next probe is allowed; 0 in half-open, null when closed. */
  cooldown_remaining_ms: number | null;
}

export class EmbeddingBreaker {
  private failures = 0;
  private openedAtMs: number | null = null;
  /** Set while the single half-open probe is in flight. */
  private probeStartedAtMs: number | null = null;
  /** Root-cause message of the last recorded failure — surfaced by
   *  BreakerOpenError so /health keeps showing WHY the breaker opened. */
  private lastFailureMsg: string | null = null;

  constructor(
    private readonly failureThreshold: number = BREAKER_FAILURE_THRESHOLD,
    private readonly cooldownMs: number = BREAKER_COOLDOWN_MS,
  ) {}

  /** May this call hit the provider? Claims the half-open probe slot as a
   *  side effect — callers MUST follow up with recordSuccess/recordFailure. */
  shouldAttempt(nowMs: number): boolean {
    if (this.openedAtMs === null) return true;
    if (this.probeStartedAtMs !== null) {
      // Probe in flight: deny — unless the probe holder never reported back
      // (crashed caller). After a full cooldown the claim expires.
      if (nowMs - this.probeStartedAtMs < this.cooldownMs) return false;
      this.probeStartedAtMs = nowMs;
      return true;
    }
    if (nowMs - this.openedAtMs < this.cooldownMs) return false;
    this.probeStartedAtMs = nowMs; // half-open: claim the single probe
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAtMs = null;
    this.probeStartedAtMs = null;
    this.lastFailureMsg = null;
  }

  recordFailure(nowMs: number, message?: string): void {
    this.failures++;
    if (message) this.lastFailureMsg = message;
    if (this.probeStartedAtMs !== null) {
      // Half-open probe failed → re-open with a fresh cooldown window.
      this.openedAtMs = nowMs;
      this.probeStartedAtMs = null;
      return;
    }
    if (this.openedAtMs === null && this.failures >= this.failureThreshold) {
      this.openedAtMs = nowMs;
    }
    // Already open (straggler that started before opening): keep the window.
  }

  /** Hard reset to CLOSED, counter 0 (#165 autostart window): early boot-time
   *  embed failures against a still-down Ollama must not pin the session's
   *  first recalls to BM25 for a full cooldown once the daemon's autostart
   *  has brought the server up seconds later. */
  reset(): void {
    this.recordSuccess();
  }

  /** Root-cause message of the last recorded failure, null when healthy. */
  lastFailureMessage(): string | null {
    return this.lastFailureMsg;
  }

  /** Side-effect-free peek — does NOT claim the probe slot. */
  state(nowMs: number): BreakerState {
    if (this.openedAtMs === null) return "closed";
    if (this.probeStartedAtMs !== null) return "half-open";
    return nowMs - this.openedAtMs < this.cooldownMs ? "open" : "half-open";
  }

  snapshot(nowMs: number): EmbeddingBreakerSnapshot {
    const state = this.state(nowMs);
    return {
      state,
      consecutive_failures: this.failures,
      opened_at_ms: this.openedAtMs,
      cooldown_remaining_ms:
        state === "open"
          ? Math.max(0, (this.openedAtMs as number) + this.cooldownMs - nowMs)
          : state === "half-open"
            ? 0
            : null,
    };
  }
}

/** Thrown instead of calling the provider while the breaker is open.
 *  EmbeddingIndex treats it like any provider error: query path returns an
 *  empty vector leg (BM25-only), batch path requeues without a retry storm.
 *  Carries the last recorded root cause — EmbeddingIndex stores err.message
 *  as its runtime lastError, so without it /health would only show the
 *  generic "circuit open" text instead of WHY the breaker opened. */
export class BreakerOpenError extends Error {
  constructor(lastError?: string | null) {
    super(
      "embedding breaker open — provider call skipped, recall degraded to BM25-only until the cooldown probe succeeds" +
        (lastError ? ` (last error: ${lastError})` : ""),
    );
    this.name = "BreakerOpenError";
  }
}

/** Data-shaped batch failure: core/embeddings.ts throws
 *  "Ollama embed: expected N embeddings, got M" when the response row count
 *  does not match the input batch. Pure decision function (testable). */
export function isBatchShapeMismatch(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /expected \d+ embeddings, got (\d+|none)/.test(msg);
}

/** Provider-boundary wrapper. Mirrors id/dim of the inner provider — the
 *  persisted vector index keys on provider.id, so wrapping must never look
 *  like a provider change (which would invalidate all vectors). */
export class BreakerGuardedProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;

  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly breaker: EmbeddingBreaker,
    private readonly now: () => number = Date.now,
  ) {
    this.id = inner.id;
    this.dim = inner.dim;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return (await this.embedWithMeta(texts)).vectors;
  }

  /**
   * #493: derselbe Schutz für den Weg, der die Providerangaben mitbringt
   * (Ollama meldet `load_duration`). Ohne diese Weiterleitung hätte der
   * Breaker die Grundwahrheit über die Residenz weggekapselt — der Index sieht
   * nur den gewrappten Provider, und `embedWithMeta` wäre dort schlicht nicht
   * vorhanden gewesen. Ein innerer Provider ohne die Fähigkeit bekommt hier
   * dieselbe Antwort wie überall: `loadMs: null`, keine Angabe.
   */
  async embedWithMeta(texts: string[]): Promise<EmbedWithMeta> {
    // Empty input returns [] without a provider roundtrip — no evidence of
    // health either way, so it must neither trip nor close the breaker.
    if (texts.length === 0) return { vectors: await this.inner.embed(texts), loadMs: null };
    if (!this.breaker.shouldAttempt(this.now())) {
      throw new BreakerOpenError(this.breaker.lastFailureMessage());
    }
    try {
      const out = this.inner.embedWithMeta
        ? await this.inner.embedWithMeta(texts)
        : { vectors: await this.inner.embed(texts), loadMs: null };
      this.breaker.recordSuccess();
      return out;
    } catch (err) {
      // Constraint: the "expected N embeddings, got M" mismatch is data-shaped
      // (deterministic per batch content — e.g. one poisoned document), not an
      // availability signal. It must NOT count toward the breaker, otherwise a
      // single poisoned backfill batch retries itself into an open breaker and
      // degrades ALL recalls to BM25 while the provider is perfectly healthy.
      if (!isBatchShapeMismatch(err)) {
        this.breaker.recordFailure(this.now(), err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
  }
}
