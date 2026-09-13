/**
 * Background jobs of the daemon process — every periodic setInterval/
 * setTimeout that index.ts used to inline lives here. index.ts wires the
 * dependencies once via startBackgroundJobs(); this module owns cadence,
 * gating and logging. All timers unref() so none of them ever keeps the
 * process alive on its own.
 */
import type { EmbeddingIndex, SearchIndex, Vault } from "@bastra-recall/core";
import { envInt } from "./env.js";
import type { Telemetry } from "./telemetry.js";
import type { ToolDeps } from "./tool-deps.js";
import { reapStaleForwarderProcesses } from "./reap-forwarders.js";
import { runInBandMint } from "./learned-recall/mint-job.js";
import { BridgePool } from "./learned-recall/bridges.js";
import { bridgesPath } from "./cli/bridges.js";
import { unloadOllamaModel } from "./ollama-lifecycle.js";
import { runCuratorPass } from "./curator-run.js";
import { pruneEventLogs } from "./log-retention.js";

export interface BackgroundJobDeps {
  vault: Vault;
  vaultRoot: string;
  search: SearchIndex;
  telemetry: Telemetry;
  toolDeps: ToolDeps;
  /** learnedBridges loaded at boot — the opt-in gate for the mint schedule. */
  bridgesEnabled: boolean;
  launchAgentOwned: boolean;
  getLastActivity: () => number;
  shutdown: () => Promise<void>;
  isStagedRestartPending: () => boolean;
  clearStagedRestartPending: () => void;
  ollama: { baseURL: string; model: string } | null;
  embIdx: () => EmbeddingIndex | null;
  /**
   * #493: Das Modell hat den Speicher verlassen — an den Warmup-Koordinator,
   * der den gemeinsamen Lifecycle-Zustand hält.
   *
   * Ohne diese Meldung schätzte die Residenz aus einem fest verdrahteten
   * 8-Minuten-Fenster (`embedding-warmup.ts`), während die Frist HIER
   * konfigurierbar ist (`BASTRA_OLLAMA_IDLE_UNLOAD_MS`, Default 10 min) — ein
   * gerade entladenes Modell konnte minutenlang `warm` lesen. Tor 3 aus #492
   * zählt „echte Kaltstarts" und stand damit auf einer Schätzung, die ihrem
   * eigenen Auslöser widersprechen konnte.
   */
  onModelUnloaded?: () => void;
}

export function startBackgroundJobs(deps: BackgroundJobDeps): void {
  startVaultReconcile(deps.vault);
  startForwarderSweep();
  startMintSchedule(deps);
  startIdleWatchdog(deps);
  startStagedRestart(deps);
  startOllamaUnload(deps);
  startCuratorTick(deps);
  startLogRetention();
}

// Periodic disk reconcile: the fs watcher misses external writes/deletes on
// cloud-storage mounts (GoogleDrive/iCloud), so size() — and the shared
// count — would otherwise drift whenever the Mac app or another process
// touches the vault directly. reconcile() walks the disk itself (watcher-
// independent) and emits add/remove events, which flow through the vault
// listeners into the shared file. Set BASTRA_VAULT_RECONCILE_MS=0 to disable.
function startVaultReconcile(vault: Vault): void {
  const reconcileMs = envInt("BASTRA_VAULT_RECONCILE_MS", 60_000);
  if (reconcileMs <= 0) return;
  setInterval(() => {
    void vault.reconcile().catch(() => {});
  }, reconcileMs).unref();
}

// Stale-Forwarder-Sweep (#80): Desktop-Zombies (toter Client, lebender
// disclaimer-Wrapper) beim Boot wegräumen. Verzögert + unref'd, damit der
// health-kritische Boot-Pfad (#78) keinen ps-Roundtrip zahlt.
// #345: and keep sweeping. Boot-only reaping was measured leaking on a
// long-lived daemon — #305 found 6 orphaned forwarders next to a daemon
// with 3.5 days of uptime, because the sweep had run once, days before the
// orphans existed. One ps table every 15min is noise; a supervisor that
// only supervises at boot is not one.
function startForwarderSweep(): void {
  setTimeout(() => reapStaleForwarderProcesses(), 5_000).unref();
  setInterval(() => reapStaleForwarderProcesses(), 15 * 60_000).unref();
}

// #353: Teacher 1 (in-band mint) runs on its own trigger — it needs no
// model and must never depend on the reranker. Once shortly after boot
// (reaches accumulated while the daemon was down), then daily. After a
// write the pool reloads in place, so new bridges serve without a restart.
// Same opt-in gate as the pool itself: no shared recall, no background mint.
function startMintSchedule(deps: BackgroundJobDeps): void {
  if (!deps.bridgesEnabled) return;
  const runScheduledMint = async (trigger: "daemon-boot" | "daemon-interval"): Promise<void> => {
    try {
      const outcome = await runInBandMint({ vault: deps.vault, bridgesRoot: bridgesPath(), trigger });
      if (outcome.written > 0) {
        deps.toolDeps.learnedBridges = BridgePool.load(bridgesPath());
        console.error(
          `[bastra-recall] in-band mint (${trigger}): ${outcome.minted} bridge(s) from ${outcome.reaches} acted-on reach(es) — pool reloaded (${deps.toolDeps.learnedBridges.size()} bridges)`,
        );
      }
    } catch (err) {
      console.error(`[bastra-recall] in-band mint failed (non-fatal): ${err}`);
    }
  };
  setTimeout(() => void runScheduledMint("daemon-boot"), 2 * 60_000).unref();
  setInterval(() => void runScheduledMint("daemon-interval"), 24 * 60 * 60_000).unref();
}

// Idle watchdog — terminate after BASTRA_DAEMON_IDLE_SHUTDOWN_MS without
// activity (default 30 min, 0 disables).
//
// #78 Hebel C: Besitzt ein LaunchAgent (KeepAlive=true) den Daemon, ist
// Self-Terminate kontraproduktiv — launchd respawnt sofort, und jeder
// Zyklus reißt ein Cold-Start-Fenster auf (Desktop: "no access to MCP",
// weil der Forwarder-Health-Timeout während des Boots abläuft). Explizit
// gesetztes BASTRA_DAEMON_IDLE_SHUTDOWN_MS bleibt ein User-Override.
function startIdleWatchdog(deps: BackgroundJobDeps): void {
  const idleShutdownMs = envInt("BASTRA_DAEMON_IDLE_SHUTDOWN_MS", 30 * 60 * 1000);
  const idleEnvSet = (process.env.BASTRA_DAEMON_IDLE_SHUTDOWN_MS ?? "") !== "";
  if (idleShutdownMs > 0 && !idleEnvSet && deps.launchAgentOwned) {
    console.error(
      "[bastra-recall] LaunchAgent registered — idle self-shutdown disabled (launchd owns the lifecycle, #78)",
    );
    return;
  }
  if (idleShutdownMs <= 0) return;
  const tick = Math.min(idleShutdownMs, 60_000);
  const idleLabel =
    idleShutdownMs >= 60_000
      ? `${Math.round(idleShutdownMs / 60000)}min`
      : `${Math.round(idleShutdownMs / 1000)}s`;
  setInterval(() => {
    if (Date.now() - deps.getLastActivity() >= idleShutdownMs) {
      console.error(
        `[bastra-recall] idle for ${idleLabel} — self-terminating (respawns on next recall)`,
      );
      void deps.shutdown();
    }
  }, tick).unref();
}

// #81: Ein warmer LaunchAgent-Daemon restartet nie von selbst — ein
// auto-staged Update würde nie live gehen. Nach dem Stage: bei ≥15 min
// Inaktivität sauber beenden; launchd (KeepAlive) respawnt sofort mit dem
// neuen Code. Im Forwarder-Mode erledigt das der Idle-Self-Shutdown.
function startStagedRestart(deps: BackgroundJobDeps): void {
  if (!deps.launchAgentOwned) return;
  setInterval(() => {
    if (deps.isStagedRestartPending() && Date.now() - deps.getLastActivity() >= 15 * 60 * 1000) {
      deps.clearStagedRestartPending();
      console.error(
        "[bastra-recall] staged update applied — idle restart to load the new code (#81); launchd respawns",
      );
      void deps.shutdown();
    }
  }, 60_000).unref();
}

// Energie (#78): Embedding-Modell nach Embed-Idle aus dem Ollama-RAM
// entladen — der "Idle-Befehl". Greift in BEIDEN Daemon-Modi (LaunchAgent
// warm / forwarder-spawned): der Daemon bleibt reaktionsschnell, nur das
// ~600-MB-Modell verlässt den RAM; der nächste Embed (oder der SessionStart-
// Hook-Recall) lädt es in 1–2 s zurück. 0 disables. Default 10 min.
function startOllamaUnload(deps: BackgroundJobDeps): void {
  const ollama = deps.ollama;
  const ollamaUnloadMs = envInt("BASTRA_OLLAMA_IDLE_UNLOAD_MS", 10 * 60 * 1000);
  if (!ollama || ollamaUnloadMs <= 0) return;
  const bootAt = Date.now();
  let lastUnloadAt = 0;
  setInterval(() => {
    // Letzter erfolgreicher Provider-Call (search ODER Backfill-Batch);
    // vor dem ersten Embed zählt der Boot (deckt das Prewarm-Load ab).
    const lastUse = deps.embIdx()?.runtimeHealth().lastOkAt ?? bootAt;
    if (lastUse > lastUnloadAt && Date.now() - lastUse >= ollamaUnloadMs) {
      lastUnloadAt = Date.now();
      void unloadOllamaModel(ollama.baseURL, ollama.model).then((ok) => {
        // #493: Grundwahrheit vor Schätzung — nur ein geglückter Unload sagt,
        // dass das Modell wirklich draußen ist.
        if (ok) deps.onModelUnloaded?.();
        return deps.telemetry.logOllamaLifecycle({
          action: "unload",
          model: ollama.model,
          ok,
          // #495: Beim Unload gibt es nur zwei Ausgänge — er lief oder er
          // scheiterte. Das Feld steht trotzdem, damit ein Leser nicht je
          // nach `action` die Semantik wechseln muss.
          outcome: ok ? "fired" : "failed",
          last_embed_age_ms: Date.now() - lastUse,
          embed_calls_since_boot: deps.embIdx()?.providerCallCount() ?? null,
        });
      });
    }
  }, 60_000).unref();
}

// Curator phase A (#155): 15-min-Tick, das echte Gate (7d-Intervall +
// Min-Idle) sitzt in shouldRunCurator — der Tick ist nur der billige Poll.
// Kein separater launchd-Job: LaunchAgent-Daemons laufen dauerhaft,
// forwarder-gespawnte leben lange genug für mindestens einen Tick, sofern
// eine Session sie wach hält. Acting path (dryRun:false) — der manuelle
// POST /curator/run bleibt default-dry.
function startCuratorTick(deps: BackgroundJobDeps): void {
  setInterval(() => {
    void runCuratorPass(
      { vaultRoot: deps.vaultRoot, vault: deps.vault, setDemotions: (ids) => deps.search.setDemotions(ids) },
      { lastActivityMs: deps.getLastActivity(), dryRun: false },
    ).then((r) => {
      if (r.error) {
        console.error(`[bastra-recall] curator pass failed (non-fatal): ${r.error}`);
      } else if (r.ran) {
        console.error(
          `[bastra-recall] curator pass (${r.mode}): ${r.demoted.length} demoted, ${r.reactivated.length} reactivated, ${r.pendingObservation.length} watching, ${r.staleTotal} stale total`,
        );
      }
    }).catch((err) => {
      // Belt + suspenders: runCuratorPass is never-throw by contract, but a
      // background tick must never be able to kill the daemon regardless.
      console.error(`[bastra-recall] curator tick error (non-fatal): ${(err as Error)?.message ?? err}`);
    });
  }, 15 * 60_000).unref();
}

// Log retention (#23): the event logs are the only thing here that grows
// without bound. Once at startup (a forwarder-spawned daemon may not live
// long enough for a timer to fire), then daily for long-lived ones.
function startLogRetention(): void {
  const prune = (): void => {
    void pruneEventLogs()
      .then((r) => {
        if (r.removed.length > 0) {
          const mb = (r.freedBytes / 1024 / 1024).toFixed(1);
          console.error(
            `[bastra-recall] log retention: removed ${r.removed.length} event log(s) older than ${r.keptDays}d (${mb} MB)`,
          );
        }
      })
      .catch((err) => {
        console.error(`[bastra-recall] log retention failed (non-fatal): ${(err as Error)?.message ?? err}`);
      });
  };
  prune();
  setInterval(prune, 24 * 60 * 60_000).unref();
}
