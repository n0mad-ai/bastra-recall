/**
 * The health payload — one shape, two doors.
 *
 * `GET /health` is loopback-only and token-free; `GET /api/v1/health` is the
 * same answer for a browser (token + CORS). Browsers cannot read /health at
 * all: CORS headers are only sent for /api/v1/*, by design — everything
 * token-free stays same-machine.
 *
 * Why the second door exists: bastra.io's admin bridge used to probe
 * reachability with a real `recall("health", k=1)` every 60 seconds. That is a
 * full embedding + vector search (~1.2s) for two booleans, and since #221 every
 * recall above the floor also emits a "read" notice — so the map kept flashing
 * activity on whichever memory happened to match the word "health". 21,972 of
 * those probes sat in the telemetry log before anyone noticed.
 *
 * Extracted from http.ts because that file is past the size where a small
 * change means reading a large file (file-size convention).
 */

import type { EmbeddingRuntimeHealth } from "@bastra-recall/core";
import type { EmbeddingStatus } from "./embedding-status.js";
import type { EmbeddingBreakerSnapshot } from "./embedding-breaker.js";
import type { UpdateState } from "./update-check.js";
import type { CodeStale } from "./code-staleness.js";

export interface HealthDeps {
  vaultSize: () => number;
  version: string;
  embedding: EmbeddingStatus;
  embeddingHealth?: () => EmbeddingRuntimeHealth | null;
  embeddingBreaker?: () => EmbeddingBreakerSnapshot | null;
  updateState: () => UpdateState | null;
  /** Epoch ms when this process started serving. Injected rather than read
   *  from `process.uptime()` so the value is testable and so a restart is
   *  visible as a reset rather than as a silently continuing clock. */
  startedAtMs?: number;
  /** Whether the code on disk has moved on without this process (#329).
   *  `version` above is what this process runs; without this field nothing
   *  distinguishes that from what a caller would get if it restarted. */
  codeStale?: () => CodeStale | null;
  /** Full commit sha this process's build was produced from (#528), from the
   *  build stamp next to its own modules. A version number is shared by every
   *  build of a release; this names the sources. Static for the life of the
   *  process — a running daemon cannot change the build it was started from.
   *  Null when running from source via tsx, or from a build with no stamp. */
  buildRevision?: string | null;
}

export function buildHealthPayload(deps: HealthDeps): Record<string, unknown> {
  const updateState = deps.updateState();
  // Runtime-degradation (#92): boot config said ON, but the last provider call
  // failed (model deleted / Ollama died) → report "degraded" instead of
  // advertising semantic recall that silently runs BM25-only.
  const rt = deps.embeddingHealth?.() ?? null;
  const degraded = deps.embedding.on && rt !== null && !rt.ok;
  // Breaker state (#165): cheap snapshot, makes it visible whether recall is
  // deliberately serving BM25-only (open) rather than merely "degraded".
  const breaker = deps.embeddingBreaker?.() ?? null;
  // Liveness detail (#22): how long this process has been up. A supervisor or
  // a user chasing "did it just restart?" gets the answer without reading
  // logs — and a flapping daemon is visible as an uptime that keeps resetting.
  const uptime =
    deps.startedAtMs === undefined
      ? {}
      : {
          uptime_seconds: Math.max(0, Math.round((Date.now() - deps.startedAtMs) / 1000)),
          started_at: new Date(deps.startedAtMs).toISOString(),
        };
  return {
    ok: true,
    vault_size: deps.vaultSize(),
    version: deps.version,
    // #329 — null means "the version above is current". Anything else means
    // this process is answering for code that has been replaced, and every
    // consumer of `version` (update check, panel, doctor, MCP handshake) is
    // reading a number that no longer describes the disk.
    code_stale: deps.codeStale?.() ?? null,
    // #528 — the only answer to "which revision is actually live?" that does
    // not have to be inferred from a disk this process may no longer be
    // running. `bastra update` asks for it after the restart instead of
    // announcing a revision it merely hopes was activated.
    build_revision: deps.buildRevision ?? null,
    ...uptime,
    // Embedding mode — lets `bastra status` show whether semantic recall is
    // live without relying on the daemon's discarded stderr (#79).
    semantic_recall: deps.embedding.on ? (degraded ? "degraded" : "on") : "off",
    embedding_mode: deps.embedding.providerId ?? "disabled",
    embedding_source: deps.embedding.source,
    ...(degraded ? { embedding_error: rt.lastError } : {}),
    ...(breaker ? { embedding_breaker: breaker } : {}),
    update_available:
      updateState && updateState.hasUpdate
        ? {
            current: updateState.current,
            latest: updateState.latest,
            html_url: updateState.html_url,
            published_at: updateState.published_at,
          }
        : null,
  };
}
