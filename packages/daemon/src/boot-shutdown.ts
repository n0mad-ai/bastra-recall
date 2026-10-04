/**
 * Start-up phase 8 (#1039): the graceful shutdown and its SIGINT/SIGTERM
 * registration. The returned `shutdown` is the same function the idle
 * watchdog and the staged restart in daemon-jobs.ts call.
 *
 * Moved verbatim out of `main()` in `index.ts`.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Vault, SearchIndex, EmbeddingIndex } from "@bastra-recall/core";
import type { Telemetry } from "./telemetry.js";
import type { LatencyProfile } from "./latency-profile.js";

export function registerShutdown(opts: {
  vault: Vault;
  search: SearchIndex;
  embIdxForHealth: EmbeddingIndex | null;
  latencyProfile: LatencyProfile;
  telemetry: Telemetry;
  httpHandle: { close: () => Promise<void> };
  server: Server;
}): { shutdown: () => Promise<void> } {
  const { vault, search, embIdxForHealth, latencyProfile, telemetry, httpHandle, server } = opts;

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.error("[bastra-recall] shutting down");
    search.stop();
    await vault.stop();
    // #240/B3: drain the background writers before exiting. The embedding
    // index holds a debounced persist that a plain exit discarded — under a
    // running backfill that is the whole batch, not just the last second —
    // and the telemetry join-store buffers events the same way.
    await embIdxForHealth?.stop().catch(() => {});
    // #491: dasselbe Argument wie beim Embedding-Index eine Zeile darüber —
    // das Profil schreibt entprellt, und ein glatter Exit hätte die
    // Stichproben der letzten Sekunden verworfen.
    await latencyProfile.flush().catch(() => {});
    await telemetry.flushNow().catch(() => {});
    await httpHandle.close();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  return { shutdown };
}
