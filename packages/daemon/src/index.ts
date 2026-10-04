#!/usr/bin/env node
/**
 * bastra-recall daemon — MCP server over a markdown memory vault.
 *
 * Tools exposed:
 *   recall(query, k?, scope?, type?)  → top-k matches
 *   load_memory(id)                   → full memory content (frontmatter + body)
 *
 * Configuration (env):
 *   BASTRA_VAULT_PATH — required. Absolute path to the vault directory
 *                       (e.g. /Users/n0mad/Daniel/memorys).
 *                       Legacy alias `NEXUS_VAULT_PATH` wird noch gelesen.
 */
import { mayExitOnBusyPort, probeDaemonPort } from "./http.js";
import { startBackgroundJobs } from "./daemon-jobs.js";
import { envFirst, envOff, isOnValue } from "./env.js";
import { startBackgroundCheck } from "./update-check.js";
import { DAEMON_VERSION } from "./version.js";
import { logDirFor } from "./telemetry.js";
import { fstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolveDaemonEndpoint } from "./daemon-endpoint.js";
import { openStorage } from "./boot-storage.js";
import { resolveRecallOptions } from "./boot-recall-options.js";
import { startTelemetry } from "./boot-telemetry.js";
import { startEmbeddings } from "./boot-embeddings.js";
import { buildToolDeps } from "./boot-tool-deps.js";
import { startHttp } from "./boot-http.js";
import { startStdioServer } from "./boot-stdio.js";
import { registerShutdown } from "./boot-shutdown.js";

// Triage Issue #24: Write-Tools sind Pro-Feature. Aktuelles Gate ist ein
// env-Flag — wenn ein Pro-License-Service kommt, ersetzt der das hier.
const DOCUMENT_WRITE_ENABLED = isOnValue(envFirst("BASTRA_DOCUMENT_WRITE", "NEXUS_DOCUMENT_WRITE"));

// One truth for the port, read twice: once by the #483 bind probe at the very
// top of main(), once by the real listen() further down — and since #531 the
// SAME resolver the CLI probes with, so the daemon cannot bind one port while
// every diagnostic describes another.
const HTTP_DISABLED = envOff("BASTRA_HTTP", "NEXUS_HTTP");
const HTTP_PORT = resolveDaemonEndpoint().port;

/** #483 review find (Vera): fd 0 says whether a stdio MCP client is attached —
 *  see `mayExitOnBusyPort`. A pipe or socket means it is, /dev/null means this
 *  is the shared daemon and the port is the whole point of it. */
function stdinState(): { isTTY?: boolean; isPipe: boolean } {
  try {
    const st = fstatSync(0);
    return { isTTY: process.stdin.isTTY === true, isPipe: st.isFIFO() || st.isSocket() };
  } catch {
    // No fd 0 at all — nobody is attached.
    return { isPipe: false };
  }
}
const MAY_EXIT_ON_BUSY_PORT = mayExitOnBusyPort(stdinState());

// ── CLI delegation guard ─────────────────────────────────────────────────────
// This module is the DAEMON entry — the forwarder starts it as `node index.js`
// with no CLI command. But package-manager bin resolution (npx / npm exec) can
// route a `bastra-recall <cmd>` invocation here instead of the CLI. When called
// with a CLI command (install, doctor, …), hand off to the CLI — which owns
// `install` → the guided wizard — instead of dying on the missing vault path
// below. The daemon path runs only when NO CLI command is present.
const CLI_COMMANDS = new Set([
  "install", "uninstall", "doctor", "update", "status",
  "config", "embeddings", "models", "token", "commons", "bridges",
  "map", "ui", "import", "onboard", "feedback", "help", "version",
]);
const firstArg = process.argv[2];
if (firstArg && (CLI_COMMANDS.has(firstArg) || /^(--help|-h|--version|-v)$/.test(firstArg))) {
  // cli.js runs its own main() on import and calls process.exit(); park so the
  // daemon setup below is never reached.
  await import("./cli.js");
  await new Promise<never>(() => {});
}

const VAULT_PATH = envFirst("BASTRA_VAULT_PATH", "NEXUS_VAULT_PATH");
if (!VAULT_PATH) {
  console.error(
    "[bastra-recall] FATAL: BASTRA_VAULT_PATH is not set. " +
      "Point it at the directory holding your memory .md files.",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  // #483: losing the port means "I am not the daemon" — not "carry on as a
  // headless worker". Asked here, before the vault watcher, the embedding
  // index and the Ollama prewarm start, because the loser used to run all
  // three a second time against the same vault. `BASTRA_HTTP=off` is a
  // deliberate no-server mode and must never be probed away.
  if (!HTTP_DISABLED && MAY_EXIT_ON_BUSY_PORT && (await probeDaemonPort(HTTP_PORT)) === "in-use") {
    console.error(
      `[bastra-recall] port ${HTTP_PORT} is already in use — exiting; if another bastra-recall daemon owns it, the forwarder will use that one.`,
    );
    process.exit(0);
  }

  // The start-up phases (#1039), in their original order. Each module holds
  // its phase verbatim; the values that cross phases are passed explicitly.
  const { vault, search, commonsSearch, commonsVerifications } = await openStorage({ vaultPath: VAULT_PATH! });
  const { evidenceGateOn, learnedBridges, sharedRecallLang } = await resolveRecallOptions();
  const { telemetry } = await startTelemetry({ vaultPath: VAULT_PATH!, vault, search });
  const {
    latencyProfile,
    rawProvider,
    embeddingStatus,
    ollama,
    startEmbeddingIndex,
    triggerExpandModel,
    embeddingBreaker,
    power,
    warmupEmbedding,
  } = await startEmbeddings({ vaultPath: VAULT_PATH!, vault, search, telemetry });
  // No `await` between this and the update check below: the index start and
  // the boot warm-up are fire-and-forget, and their first steps must keep
  // landing after the update check, as they did inside the old main().
  const embIdxForHealth = startEmbeddingIndex();

  // Update-check (fire-and-forget, opt-out via BASTRA_UPDATE_CHECK=off).
  // Caches result on disk for 24h → no GitHub-API hit on every daemon restart.
  // #81: in mode=auto staged der Daemon das Update selbst (Desktop hat keine
  // Hook-Fläche); das Flag triggert unten den Idle-Restart im LaunchAgent-Mode.
  let stagedRestartPending = false;
  startBackgroundCheck(DAEMON_VERSION, {
    onAutoStaged: () => {
      stagedRestartPending = true;
    },
  });

  if (telemetry.isEnabled()) {
    console.error(`[bastra-recall] telemetry: enabled (log path: ${logDirFor()})`);
  } else {
    console.error(`[bastra-recall] telemetry: disabled`);
  }

  const { toolDeps } = await buildToolDeps({
    vaultPath: VAULT_PATH!,
    vault,
    search,
    telemetry,
    commonsSearch,
    commonsVerifications,
    learnedBridges,
    sharedRecallLang,
    evidenceGateOn,
    rawProvider,
    ollama,
    embeddingBreaker,
    warmupEmbedding,
    latencyProfile,
  });

  // Idle self-shutdown: the shared daemon is spawned on demand by the
  // mcp-forwarder, so it can safely self-terminate after a stretch of no
  // activity — the next recall respawns it (watchdog in daemon-jobs.ts).
  let lastActivityMs = Date.now();
  const markActivity = (): void => {
    lastActivityMs = Date.now();
  };

  const { httpHandle } = await startHttp({
    httpDisabled: HTTP_DISABLED,
    httpPort: HTTP_PORT,
    vaultPath: VAULT_PATH!,
    vault,
    search,
    telemetry,
    toolDeps,
    documentWriteEnabled: DOCUMENT_WRITE_ENABLED,
    markActivity,
    embeddingStatus,
    embIdxForHealth,
    embeddingBreaker,
    triggerExpandModel,
    power,
    ollama,
  });

  // #483: the probe at the top of main() closes its socket before the real
  // listen() runs, so a second process can still slip in during that window.
  // It loses here instead — and stops, rather than staying up as a second
  // watcher on the same vault.
  if (httpHandle.addressInUse && MAY_EXIT_ON_BUSY_PORT) {
    console.error(
      `[bastra-recall] lost port ${HTTP_PORT} while starting up — exiting; if another bastra-recall daemon owns it, the forwarder will use that one.`,
    );
    process.exit(0);
  }

  const { server } = await startStdioServer({
    vault,
    search,
    toolDeps,
    documentWriteEnabled: DOCUMENT_WRITE_ENABLED,
    markActivity,
  });

  const { shutdown } = registerShutdown({
    vault,
    search,
    embIdxForHealth,
    latencyProfile,
    telemetry,
    httpHandle,
    server,
  });

  // All periodic work — reconcile, forwarder sweep, mint schedule, idle
  // watchdog, staged restart, ollama unload, curator tick, log retention —
  // lives in daemon-jobs.ts; this is the single wiring point.
  startBackgroundJobs({
    vault,
    vaultRoot: VAULT_PATH!,
    search,
    telemetry,
    toolDeps,
    bridgesEnabled: learnedBridges !== null,
    launchAgentOwned: launchAgentOwnsDaemon(),
    getLastActivity: () => lastActivityMs,
    shutdown,
    isStagedRestartPending: () => stagedRestartPending,
    clearStagedRestartPending: () => {
      stagedRestartPending = false;
    },
    ollama: ollama ? { baseURL: ollama.baseURL, model: ollama.model } : null,
    embIdx: () => embIdxForHealth,
    // #493: Der Idle-Unload ist die einzige Stelle, an der wir das Modell
    // selbst aus dem Speicher werfen — also die einzige, die Grundwahrheit
    // darüber hat. Sie geht in denselben Lifecycle-Zustand wie Warmups.
    onModelUnloaded: () => warmupEmbedding.noteUnloaded(),
    power,
  });
}

const LAUNCH_AGENT_LABEL = "ai.n0mad.bastra-recall";

/** true wenn der bastra-LaunchAgent in der gui-Domain registriert ist (#78). */
function launchAgentOwnsDaemon(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const uid = process.getuid?.() ?? 0;
    const r = spawnSync("/bin/launchctl", ["print", `gui/${uid}/${LAUNCH_AGENT_LABEL}`], {
      stdio: "ignore",
      timeout: 5_000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error("[bastra-recall] FATAL:", err);
  process.exit(1);
});
