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
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  Vault,
  SearchIndex,
  EmbeddingIndex,
  OpenAIEmbeddingProvider,
  OllamaEmbeddingProvider,
  RelatedEnricher,
  TriggerExpander,
  pickPhrase,
  banterModeFromEnv,
  progressIndexFor,
  RECALL_STAGE_ORDER,
  type EmbeddingProvider,
  type RecallStage,
  type StageListener,
} from "@bastra-recall/core";
import * as path from "node:path";
import { logDirFor } from "./telemetry.js";
import { createDaemonTelemetry } from "./telemetry-setup.js";
import { recoverCallArguments } from "./call-corruption.js";
import { TOOL_ARG_EXPECTATIONS } from "./tool-defs.js";
import { mayExitOnBusyPort, probeDaemonPort, startHttpServer } from "./http.js";
import { loadCuratorState } from "./curator.js";
import { wireBootObservers } from "./boot-observers.js";
import { startBackgroundJobs } from "./daemon-jobs.js";
import { embeddingStatusLine, type EmbeddingStatus, type EmbeddingSource } from "./embedding-status.js";
import { resolveEmbeddingChoice, getCommonsEnabled, getSharedRecallEnabled, getSharedRecallLanguage, getPrimaryLanguage, resolveGenerationModel, getEvidenceGateEnabled, getExperimentConfig } from "./settings.js";
import { commonsPath, loadVerificationCounts } from "./cli/commons.js";
import { bridgesPath } from "./cli/bridges.js";
import { BridgePool } from "./learned-recall/bridges.js";
import { isSupportedLanguage, type SupportedLanguage } from "./learned-recall/language.js";
import { ollamaChat } from "./learned-recall/reranker.js";
import { existsSync, fstatSync } from "node:fs";
import {
  recallHandler,
  loadMemoryHandler,
  saveMemoryHandler,
  archiveMemoryHandler,
  MEMORY_TOOL_DEFS,
  type ToolDeps,
} from "./tool-handlers.js";
import {
  documentTools,
  FindDocumentArgs,
  ReadDocumentArgs,
  OpenDocumentArgs,
  findDocument,
  readDocument,
  openDocument,
} from "./documents-handler.js";
import {
  documentWriteTools,
  SaveDocumentArgs,
  RecategorizeDocumentArgs,
  MoveDocumentArgs,
  saveDocument,
  recategorizeDocument,
  moveDocument,
} from "./documents-write-handler.js";
import { productDocTools, saveProductDocHandler } from "./product-doc-handler.js";
import { envFirst, envInt, envFloat, envBool } from "./env.js";
import { startBackgroundCheck } from "./update-check.js";
import { DAEMON_VERSION } from "./version.js";
import { writeSharedVaultSize } from "./statusline-session.js";
import { EmbeddingBreaker, BreakerGuardedProvider } from "./embedding-breaker.js";
import { createEmbeddingPrewarmer } from "./embedding-prewarm.js";
import { createEmbeddingWarmup } from "./embedding-warmup.js";
import { countingProvider, createLatencyProfile, type DeadlineShadow } from "./latency-profile.js";
// #493: die datensparsame Kennung dieses Hosts — Tor 5 aus #492.
import { hostProfileId } from "./host-profile.js";
import { ensureOllamaServerForDaemon } from "./cli/ollama.js";
import { spawnSync } from "node:child_process";

// Triage Issue #24: Write-Tools sind Pro-Feature. Aktuelles Gate ist ein
// env-Flag — wenn ein Pro-License-Service kommt, ersetzt der das hier.
const DOCUMENT_WRITE_ENABLED = envFirst("BASTRA_DOCUMENT_WRITE", "NEXUS_DOCUMENT_WRITE") === "1";

const DEFAULT_HTTP_PORT = 6723;
// One truth for the port, read twice: once by the #483 bind probe at the very
// top of main(), once by the real listen() further down.
const HTTP_DISABLED = envFirst("BASTRA_HTTP", "NEXUS_HTTP") === "off";
const HTTP_PORT = (() => {
  const p = envInt("BASTRA_HTTP_PORT", DEFAULT_HTTP_PORT, "NEXUS_HTTP_PORT");
  return Number.isFinite(p) ? p : DEFAULT_HTTP_PORT;
})();

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

  const vault = new Vault(VAULT_PATH!);
  const { loaded, skipped } = await vault.init();
  console.error(
    `[bastra-recall] vault loaded: ${loaded} memorys` +
      (skipped.length ? `, ${skipped.length} skipped` : ""),
  );
  for (const s of skipped) {
    console.error(`[bastra-recall]   skipped ${s.path}: ${s.err}`);
  }
  vault.startWatching();

  // Publish the live vault size to a shared file so every session's statusline
  // — including idle ones that make no tool calls — shows the current memory
  // count. The per-session forwarder feed only refreshes on that session's own
  // calls, so without this an idle session shows a stale count after another
  // session (or an external write the watcher caught) changes the vault.
  // Debounced so a burst of watcher events collapses into one write.
  const publishVaultSize = (() => {
    let last = -1;
    let timer: ReturnType<typeof setTimeout> | null = null;
    return () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const size = vault.size();
        if (size !== last) {
          last = size;
          writeSharedVaultSize(size);
        }
      }, 300);
      timer.unref?.();
    };
  })();
  writeSharedVaultSize(vault.size()); // initial, before any event
  vault.on(() => publishVaultSize());

  const search = new SearchIndex(vault);
  search.start();

  // Bastra Commons: read-only Community-Rezept-Index. Bewusst BM25-only —
  // kein Embedding-Backfill, kein RelatedEnricher: in das git-synchronisierte
  // Verzeichnis wird NIE geschrieben (#104-Lektion: ein Schreiber weniger).
  let commonsSearch: SearchIndex | null = null;
  let commonsVerifications: Map<string, { works: number; fails: number }> | null = null;
  if (await getCommonsEnabled()) {
    const recipesDir = path.join(commonsPath(), "recipes");
    if (existsSync(recipesDir)) {
      try {
        const commonsVault = new Vault(recipesDir);
        await commonsVault.init();
        commonsSearch = new SearchIndex(commonsVault);
        commonsSearch.start();
        // verify-Loop: Records einlesen — Evidenz fließt ins Fusion-Ranking.
        commonsVerifications = loadVerificationCounts(commonsPath());
        const verified = [...commonsVerifications.values()].reduce((s, v) => s + v.works + v.fails, 0);
        console.error(`[bastra-recall] commons: enabled (${commonsVault.size()} recipes, ${verified} verification records from ${recipesDir})`);
      } catch (err) {
        console.error(`[bastra-recall] commons: failed to load (${(err as Error).message}) — continuing without`);
        commonsSearch = null;
      }
    } else {
      console.error(`[bastra-recall] commons: enabled but not cloned — run 'bastra commons enable'`);
    }
  }

  // Shared learned-recall bridges (#120): read-only, language-partitioned pool
  // that widens recall queries. Same discipline as Commons — never written, only
  // loaded when opted in. Off = pool stays null and nothing is constructed or
  // contacted (local-first). The optional language override skips per-query detection.
  // #264: einmal gelesen, nicht je Recall — der Hook-Pfad ist der
  // frequentierteste und verträgt keinen Datei-Zugriff pro Aufruf. Ein
  // Umschalten wirkt nach einem Daemon-Neustart; der Rückfall bei einem DEFEKT
  // ist davon unabhängig und sofort (fail-open in runHookRecall).
  const evidenceGateOn = await getEvidenceGateEnabled();
  if (evidenceGateOn) {
    console.error(
      "[bastra-recall] evidence gate: ACTIVE — no_answer suppresses hits (#264/#422); BASTRA_EVIDENCE_GATE=0 is the instant off-switch",
    );
  } else {
    // #422: seit dem Default `true` ist AUS die Abweichung, die man sehen muss.
    console.error("[bastra-recall] evidence gate: OFF (settings or BASTRA_EVIDENCE_GATE) — legacy bands serve every hit");
  }

  let learnedBridges: BridgePool | null = null;
  let sharedRecallLang: SupportedLanguage | null = null;
  if (await getSharedRecallEnabled()) {
    try {
      learnedBridges = BridgePool.load(bridgesPath());
      const lang = await getSharedRecallLanguage();
      sharedRecallLang = isSupportedLanguage(lang) ? lang : null;
      console.error(
        `[bastra-recall] shared learned-recall: enabled (${learnedBridges.size()} bridges across ${learnedBridges.languages().join(", ") || "no"} languages, query-language ${sharedRecallLang ?? "auto-detect"})`,
      );
    } catch (err) {
      console.error(`[bastra-recall] shared learned-recall: failed to load (${(err as Error).message}) — continuing without`);
      learnedBridges = null;
    }
  }

  // Hybrid-Recall: provider precedence env → cli-settings.json → API-key → none.
  // embeddingStatusLine logs the resolved mode on EVERY path including success —
  // the silent-success path was the root of #79.
  // Vor dem Embedding-Block konstruiert, weil Prewarm/Unload (#109) ihre
  // Lifecycle-Events darüber loggen. Der onUsage-Sink speist den Per-Memory-
  // Usage-Sidecar (#154) — fire-and-forget, ein kaputter Sidecar darf keinen
  // Tool-Call brechen (Contract in usage-sidecar.ts).
  const telemetry = createDaemonTelemetry(VAULT_PATH!, (id) => vault.get(id));

  // #267: Die Armzuweisung der §17.4-Experimente. Ohne registrierte
  // Konfiguration bleibt jedes Ereignis `unassigned` — die Spalte existiert
  // seit #263, behauptet aber kein laufendes Experiment. Erst diese Zeile macht
  // die Naht echt statt tot.
  const experimentConfig = await getExperimentConfig();
  telemetry.setExperiment(experimentConfig);
  if (experimentConfig) {
    console.error(
      `[bastra-recall] experiment ACTIVE: ${experimentConfig.experiment} — arms ${experimentConfig.arms.join(", ")} (#267)`,
    );
  }

  // Die Meldekanäle aus core (ID-Scan-Kosten, Mutations-Incidents) und die
  // Start-Detection des Recovery-Journals — wer zuhört, steht in
  // boot-observers.ts.
  await wireBootObservers({ telemetry, vaultPath: VAULT_PATH! });

  // Curator-Demotions (#155) überleben Daemon-Restarts: Score-Set aus dem
  // State-File beim Boot in den Index laden. Best-effort.
  try {
    const curatorState = await loadCuratorState(VAULT_PATH!);
    const staleIds = Object.keys(curatorState.stale);
    if (staleIds.length > 0) search.setDemotions(staleIds);
  } catch {
    /* kein State = keine Demotions */
  }

  // #491: das gelernte Latenzprofil des dichten Arms, im SCHATTEN. Es rechnet
  // neben jedem Recall die Frist aus, die es gesetzt HÄTTE, und protokolliert
  // sie neben der, die tatsächlich galt — die festen 150/350/1500 ms bleiben
  // unangetastet, bis das Zeit-Tor aus #492 geöffnet ist.
  //
  // Geschlüsselt auf `rawProvider.id` (`ollama-embeddinggemma`,
  // `openai-text-embedding-3-small`) — dieselbe Kennung, an der schon
  // Vektor-Persistenz und Embed-Cache invalidieren. Ein Modellwechsel findet
  // seinen Schlüssel leer vor und erbt nichts.
  //
  // #493: VOR dem Provider aufgebaut, weil der Nebenläufigkeitszähler jetzt am
  // Providerrand sitzt (`countingProvider` unten) statt im Recall-Pfad.
  const latencyProfile = createLatencyProfile();
  // Beim Boot einmal gelesen, damit das Profil einen Neustart überlebt. Ein
  // Fehlschlag ist ein leeres Profil, kein Bootfehler.
  await latencyProfile.load().catch(() => {});
  const { provider: rawProvider, status: embeddingStatus, ollama } = await resolveEmbedding();
  console.error(embeddingStatusLine(embeddingStatus));
  // Für /health (#92): Runtime-Health des Index, nicht nur die Boot-Config.
  let embIdxForHealth: EmbeddingIndex | null = null;
  // Circuit breaker (#165) am Provider-Boundary: nach 3 konsekutiven
  // Provider-Fehlern skipt Hybrid-Recall den Embed-Versuch komplett
  // (BM25-only, kein Timeout pro Query gegen ein wedged Ollama); nach dem
  // Cooldown testet genau EIN Probe-Call, ob der Provider wieder lebt.
  const embeddingBreaker = rawProvider ? new EmbeddingBreaker() : null;
  // #361: the breaker-guarded provider, hoisted so the turn-start prewarm can
  // reach it. Null with embeddings off — the prewarm then reports
  // "skipped-no-provider" instead of silently not existing.
  let guardedProvider: EmbeddingProvider | null = null;
  // #490: the shared warm-up. One object per provider+model — the daemon
  // resolves exactly one provider, so this process-wide instance IS the
  // per-model one. It owns two things no single trigger can own: the residency
  // answer the session lane asks for instead of racing blind, and the
  // in-flight flag that makes several sessions starting at once share ONE
  // load instead of hitting a cold machine with an embed storm.
  //
  // #494: Und es steht JETZT hier, vor dem Embedding-Block, weil der
  // Boot-Warmup darin liegt und seit #494 durch dieselbe Grenze läuft wie die
  // beiden anderen Auslöser. Vorher entstand der Koordinator darunter, das
  // Boot-Prewarm feuerte seinen eigenen HTTP-Call, und die Zusage „ein Warmup"
  // galt für alles außer dem ersten. Die Getter lesen `guardedProvider` und
  // `embIdxForHealth` erst beim Aufruf, also stört die frühere Zeile nichts.
  const warmupEmbedding = createEmbeddingWarmup({
    // `ollama` is set exactly when the resolved provider is an Ollama one —
    // the only case with a model that goes cold and that our per-request
    // keep_alive (#78) governs. A hosted API keeps no model of ours resident,
    // so warming it is one egress request for nothing.
    hostedProvider: () => rawProvider !== null && ollama === undefined,
    denseArmAvailable: () => search.hasEmbeddings() && embeddingBreaker?.state(Date.now()) !== "open",
    // #494: Der Boot fragt nur den Breaker. `embIdx.start()` läuft daneben und
    // ist in den ersten Sekunden nicht fertig — daran zu scheitern hieße, #78
    // stillschweigend abzuschaffen.
    providerAvailable: () => guardedProvider !== null && embeddingBreaker?.state(Date.now()) !== "open",
    // Provider-agnostic and free (#490): the last successful provider call.
    // Deliberately not an Ollama /api/ps probe.
    lastOkAt: () => embIdxForHealth?.runtimeHealth().lastOkAt ?? null,
    warm: async () => {
      // #495: `embedWithMeta` wo der Provider es kann — genau wie der dichte
      // Arm es seit #493 tut. Mit `embed()` wurde Ollamas `load_duration`
      // weggeworfen, und seit #494 ist DAS der Pfad, der den Kaltstart trägt:
      // Der kalte SessionStart antwortet lexikalisch, der Ladevorgang passiert
      // hier. Isoliert gemessen (08.09.2026, zweites Ollama, Modell nicht
      // resident) verschwand ein 524,709-ms-Kaltstart spurlos, und Tor 3 aus
      // #492 zählte ihn nicht.
      if (!guardedProvider) return;
      if (guardedProvider.embedWithMeta) {
        const meta = await guardedProvider.embedWithMeta(["warm"]);
        return { loadMs: meta.loadMs };
      }
      await guardedProvider.embed(["warm"]);
      // Kein `embedWithMeta` heißt „dieser Provider kann nichts über einen
      // Ladevorgang sagen" — nicht „es gab keinen".
      return;
    },
    onError: () => {
      // Silent by design, same as the prewarm below.
    },
    // #495: Jeder Warmup schreibt seine eigene Zeile — mit Ladezeit,
    // Kaltstartflag, Auslöser und, wo vorhanden, der Klammer des
    // Sitzungsstarts, der ihn ausgelöst hat.
    onSettle: (s) => {
      void telemetry.logWarmupSettle({
        trigger: s.trigger,
        model: ollama?.model ?? rawProvider?.id ?? null,
        ok: s.ok,
        duration_ms: Math.round(s.durationMs),
        provider_load_ms: s.providerLoadMs,
        cold_start_observed: s.coldStartObserved,
        residency_before: s.residencyBefore,
        ...(s.sessionStartCallId ? { session_start_call_id: s.sessionStartCallId } : {}),
        host_profile_id: hostProfileId(),
      });
    },
  });
  if (rawProvider && embeddingBreaker) {
    // #493: Der Nebenläufigkeitszähler liegt am Providerrand, INNERHALB des
    // Breakers — ein Call, den der Breaker gar nicht durchlässt, beschäftigt
    // den Provider nicht. Hier kommt alles durch, was ihn wirklich beschäftigt:
    // der dichte Arm jeder Lane, der Content-Recall, die Backfill-Batches und
    // der Warmup. Vorher zählte der Recall-Pfad die wartenden Aufrufer, ließ
    // beim Timeout los, während der Embed weiterlief, und sah von den anderen
    // dreien nichts.
    const provider = new BreakerGuardedProvider(
      countingProvider(rawProvider, latencyProfile),
      embeddingBreaker,
    );
    guardedProvider = provider;
    const persistPath = path.join(VAULT_PATH!, ".bastra", "embeddings.json");
    const embIdx = new EmbeddingIndex(vault, provider, persistPath);
    embIdxForHealth = embIdx;
    // Wakeup (#78): Ollama-Server sicherstellen (Autostart, falls z.B. die
    // Mac-App beendet wurde, die ihn hielt), dann das Modell parallel zum
    // restlichen Boot laden — der erste Recall nach einem Cold-Start trifft
    // ein warmes Modell. Fire-and-forget, blockiert weder Vault-Load noch
    // /health.
    if (ollama) {
      void (async () => {
        const auto = await ensureOllamaServerForDaemon(ollama.baseURL);
        if (auto.detail !== "already running") {
          console.error(`[bastra-recall] ollama autostart: ${auto.detail}`);
        }
        // #165 Autostart-Fenster: frühe Embed-Fehler beim Boot (Ollama noch
        // down) haben den Breaker evtl. schon geöffnet und würden die ersten
        // Recalls der Session für einen vollen Cooldown auf BM25 pinnen,
        // obwohl der Server jetzt steht. Läuft er (frisch gestartet oder
        // schon da), Breaker hart zurücksetzen: closed, Counter 0.
        if (auto.started || auto.detail === "already running") {
          embeddingBreaker.reset();
        }
        // #494: DURCH den Koordinator, nicht daran vorbei. Bis hierher war das
        // ein eigener `POST /api/embed` (`prewarmOllamaModel`) — außerhalb der
        // Singleflight-Grenze, außerhalb des Breakers und außerhalb des
        // Nebenläufigkeitszählers aus #493. Ein frischer Daemon plus ein
        // SessionStart konnte damit fünf gleichzeitige Embeds auslösen. Jetzt
        // ist der Boot einer von drei Auslösern derselben einen Grenze: Läuft
        // schon ein Warmup, fällt er darauf; sonst startet er ihn, und der
        // SessionStart daneben fällt seinerseits darauf.
        const outcome = warmupEmbedding.ensureWarm("boot");
        // Der einzige Aufrufer, der auf einen Warmup wartet — für diese
        // Lifecycle-Zeile, nicht für eine Antwort an einen Nutzer.
        const fired = outcome === "fired" ? ((await warmupEmbedding.warming()) ?? false) : false;
        // #495: Der Ausgang und die Fehlerfrage sind zwei verschiedene Dinge.
        // `skipped-warm` und `skipped-in-flight` sind der Singleflight aus
        // #494 bei der Arbeit — nichts ist gescheitert, und `ok: false` ließ
        // sie wie ein kaputtes Prewarm aussehen.
        const lifecycleOutcome = outcome === "fired" ? (fired ? "fired" : "failed") : outcome;
        const ok = lifecycleOutcome !== "failed";
        console.error(
          `[bastra-recall] ollama prewarm: ${ollama.model} ${fired ? "loaded" : `not warmed (${outcome})`}`,
        );
        // #493: Ein geglücktes Prewarm ist ein BEOBACHTETER Ladevorgang. Die
        // Residenz las nach dem Boot sonst `unknown`, obwohl das Modell
        // nachweislich im Speicher lag. Seit #494 meldet das der Koordinator
        // selbst (`noteLoaded` im Settle von `ensureWarm`), also steht hier
        // keine zweite Meldung mehr.
        void telemetry.logOllamaLifecycle({
          action: "prewarm",
          model: ollama.model,
          ok,
          outcome: lifecycleOutcome,
          last_embed_age_ms: null,
          embed_calls_since_boot: embIdx.providerCallCount(),
        });
      })();
    }
    // Auto-Related-Enricher: pflegt frontmatter.related_via nach jedem Embed-
    // Batch. Threshold/topN über Env überschreibbar, sonst RelatedEnricher-
    // Defaults (top 5, cosine ≥ 0.7).
    const enricher = new RelatedEnricher(vault, embIdx, {
      topN: envInt("BASTRA_RELATED_TOP_N", 5),
      threshold: envFloat("BASTRA_RELATED_THRESHOLD", 0.7),
    });
    embIdx
      .start()
      .then(async () => {
        search.useEmbeddings(embIdx);
        if (envBool("BASTRA_AUTO_RELATED", true)) {
          enricher.start();
          console.error(
            `[bastra-recall] auto-related: enabled (top ${envInt("BASTRA_RELATED_TOP_N", 5)} ≥ ${envFloat("BASTRA_RELATED_THRESHOLD", 0.7)})`,
          );
        }
        // doc2query Trigger-Expander (#117): paraphrasiert recall_when offline
        // nach jedem Embed + backfillt bestehende Memories. Braucht ein lokales
        // Ollama-Chat-Modell, also nur wenn Ollama der Embedding-Provider ist
        // (dann läuft der Server). BASTRA_TRIGGER_EXPAND=0 schaltet die Last ab.
        // Self-Test gegen recallHybrid filtert halluzinierte Paraphrasen, behält
        // aber die wertvollen far-Paraphrasen (semantisch, nicht lexikalisch).
        if (ollama && envBool("BASTRA_TRIGGER_EXPAND", true)) {
          const expandModel = await resolveGenerationModel();
          // doc2query generation is far slower than a rerank judgment (a 4B model
          // writing 3-5 phrases takes ~30-90s, more on a cold start), so it gets
          // its own generous timeout instead of the reranker's 30s default —
          // otherwise every gen aborts and the backfill writes nothing.
          const expandTimeoutMs = envInt("BASTRA_EXPAND_TIMEOUT_MS", 120_000);
          const expander = new TriggerExpander(vault, embIdx, {
            chat: ollamaChat({ baseURL: ollama.baseURL, model: expandModel, timeoutMs: expandTimeoutMs }),
            selfTest: async (phrase, id) => {
              const hits = await search.recallHybrid(phrase, { k: 10, allow_private: true });
              return hits.some((h) => h.id === id);
            },
          });
          expander.start();
          console.error(`[bastra-recall] trigger-expand: enabled (doc2query, model ${expandModel})`);
        }
        console.error(
          `[bastra-recall] embeddings ready provider=${provider.id} (${embIdx.size()} vectors, ${embIdx.pendingSize()} pending)`,
        );
      })
      .catch((err) => {
        console.error(`[bastra-recall] embeddings start error: ${err}`);
      });
  }

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

  // Shared dependency-bag — wird sowohl vom MCP-stdio-Handler als auch von den
  // HTTP-REST-Routes konsumiert. Damit teilen beide Pfade Tool-Logik und
  // Telemetry; kein Drift.
  // #231 (language-first recall): the user's primary authoring language,
  // resolved once here like sharedRecallLang above; scoreSaveQuality uses it for
  // the save-time language-mismatch advisory. Absent = feature dormant.
  const primaryLanguage = await getPrimaryLanguage();

  // #361: one small embed at each turn start, so the first assertion call of
  // the turn meets a warm model instead of losing the dense arm to the 150ms
  // deadline (#342). It goes through the BREAKER-GUARDED provider on purpose:
  // the warm call is a real embed, so a failing one is real evidence the
  // provider is down (it counts toward the breaker, and may serve as its single
  // half-open probe) — the same boundary every other embed crosses. And
  // availability is asked exactly as the recall path asks it: an attached
  // embedding index, and a breaker that is not open (half-open passes).
  // Der Koordinator dazu steht seit #494 oben, vor dem Embedding-Block.

  // #491: das gelernte Latenzprofil des dichten Arms, im SCHATTEN. Es rechnet
  // neben jedem Recall die Frist aus, die es gesetzt HÄTTE, und protokolliert
  // sie neben der, die tatsächlich galt — die festen 150/350/1500 ms bleiben
  // unangetastet, bis das Zeit-Tor aus #492 geöffnet ist.
  //
  // Geschlüsselt auf `rawProvider.id` (`ollama-embeddinggemma`,
  // `openai-text-embedding-3-small`) — dieselbe Kennung, an der schon
  // Vektor-Persistenz und Embed-Cache invalidieren. Ein Modellwechsel findet
  // seinen Schlüssel leer vor und erbt nichts.
  const deadlineShadow: DeadlineShadow = {
    key: () => rawProvider?.id ?? null,
    // Die Residenz kommt aus dem Warmup-Koordinator (#490) und nirgendwo
    // sonst — eine zweite Quelle dafür wäre eine zweite Wahrheit. #493: mit
    // ihrer Herkunft, damit die Auswertung Grundwahrheit von Schätzung trennen
    // kann.
    residency: () => warmupEmbedding.residencyDetail(),
    // #493: Der Provider hat für einen Call geladen (Ollama `load_duration`) —
    // die einzige Grundwahrheit über die Residenz, die dieser Pfad hat. Sie
    // geht in denselben Lifecycle-Zustand wie Warmups und Unloads.
    observeLoad: (loadMs) => warmupEmbedding.noteLoaded(loadMs),
    // #493: Tor 5 aus #492 fragt nach einer zweiten Maschine. Gesalzener Hash,
    // Salt bleibt lokal — kein Hostname, kein Nutzername (`host-profile.ts`).
    hostProfileId,
    profile: latencyProfile,
  };

  const prewarmEmbedding = createEmbeddingPrewarmer({
    // `ollama` is set exactly when the resolved provider is an Ollama one —
    // the only case with a model that goes cold and that our per-request
    // keep_alive (#78) governs. A hosted API keeps no model of ours resident,
    // so warming it is one egress request per minute of work for nothing.
    hostedProvider: () => rawProvider !== null && ollama === undefined,
    denseArmAvailable: () => search.hasEmbeddings() && embeddingBreaker?.state(Date.now()) !== "open",
    // #490: through the coordinator, not straight at the provider. The turn
    // start stays the trigger and its telemetry keeps meaning "the turn fired
    // the warm-up path"; whether that path then embeds is the coordinator's
    // call — it now KNOWS the model is resident where the 60s debounce could
    // only assume it, and it will not start a second load while one is
    // already in flight for another session.
    warm: async () => {
      warmupEmbedding.ensureWarm("turn");
    },
    onError: () => {
      // Silent by design: the prewarm is an optimisation, and a provider that
      // is genuinely down surfaces through the breaker and /health — not
      // through one log line per turn.
    },
  });

  const toolDeps: ToolDeps = {
    vault,
    search,
    telemetry,
    vaultPath: VAULT_PATH!,
    commonsSearch,
    commonsVerifications,
    learnedBridges,
    sharedRecallLang,
    primaryLanguage,
    // #165: Recall-Telemetrie flaggt Events als embedding_degraded, wenn der
    // Breaker gerade offen ist (Vector-Leg geskippt, BM25-only serviert).
    embeddingDegraded: embeddingBreaker
      ? () => embeddingBreaker.state(Date.now()) === "open"
      : undefined,
    // #264: Der Evidenzentscheid, scharf oder nicht. Beim Boot aufgelöst wie
    // die übrigen Schalter; Default aus. Aus heißt NICHT „läuft nicht" — er
    // läuft und wird geloggt, er wirkt nur auf nichts (§21.1: erst shadow).
    evidenceGateEnabled: () => evidenceGateOn,
    // #361: the prompt lane fires this at turn start (fire-and-forget).
    prewarmEmbedding,
    // #490: the session lane asks this for residency and lets it start the
    // load beside the session-start recall.
    warmupEmbedding,
    // #491: shadow only — computed and logged next to the fixed deadline, and
    // it decides nothing until #492's time gate opens.
    deadlineShadow,
  };

  // Idle self-shutdown: the shared daemon is spawned on demand by the
  // mcp-forwarder, so it can safely self-terminate after a stretch of no
  // activity — the next recall respawns it (watchdog in daemon-jobs.ts).
  let lastActivityMs = Date.now();
  const markActivity = (): void => {
    lastActivityMs = Date.now();
  };

  const httpHandle =
    HTTP_DISABLED
      ? { port: null, close: async () => undefined }
      : await startHttpServer({
          port: HTTP_PORT,
          vault,
          search,
          telemetry,
          version: DAEMON_VERSION,
          toolDeps,
          documentWriteEnabled: DOCUMENT_WRITE_ENABLED,
          onActivity: markActivity,
          embedding: embeddingStatus,
          embeddingHealth: () => embIdxForHealth?.runtimeHealth() ?? null,
          embeddingBreaker: () => embeddingBreaker?.snapshot(Date.now()) ?? null,
          embeddingVectors: () => embIdxForHealth?.snapshot() ?? null,
          // Such-Copilot (#207): gleiche lokale Gen-Model-Auflösung wie
          // doc2query; ohne Ollama bleibt /ui/chat aus (503).
          uiChat: ollama
            // 8192 statt des 4096-Defaults (#366): die Lane feuert zwei
            // getrennte Calls. buildQueryPrompt nimmt history.slice(-4) ×
            // MAX_MESSAGE 2000 Zeichen + die Frage (webui-chat.ts:34,42) ≈ 10k
            // Zeichen ≈ 3k Tokens; buildAnswerPrompt läuft ohne History, dafür
            // mit HITS_TOTAL 8 × 600 Zeichen Body (:38,69) ≈ 1,5k Tokens. Der
            // Query-Prompt passt knapp in 4096 — 8192 ist der Headroom.
            ? ollamaChat({ baseURL: ollama.baseURL, model: await resolveGenerationModel(), timeoutMs: 45_000, numCtx: 8192 })
            : null,
          curator: { vaultRoot: VAULT_PATH!, vault, setDemotions: (ids) => search.setDemotions(ids) },
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

  const server = new Server(
    { name: "bastra-recall", version: DAEMON_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      ...MEMORY_TOOL_DEFS,
      ...documentTools,
      ...(DOCUMENT_WRITE_ENABLED ? documentWriteTools : []),
      ...productDocTools,
    ],
  }));


  // Banter-Lang: nutzt BASTRA_BANTER_LANG (de|en), default `en` —
  // MCP-Clients sind heterogen, ein deutsches "Stichwörter durchforsten"
  // im englischen Chat-Verlauf wirkt fremd. Deutsche Mac-App-User setzen
  // BASTRA_BANTER_LANG=de in ihrer Shell oder dem Daemon-Launchd-Plist.
  const banterMode = banterModeFromEnv(process.env);
  const banterLang = (process.env.BASTRA_BANTER_LANG ?? "en").toLowerCase() === "de" ? "de" : "en";

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    markActivity();
    const { name, arguments: rawArgs } = req.params;

    // #482: same check as the REST boundary — the standalone stdio surface is
    // the other place tool arguments arrive, and the client bug does not care
    // which transport it corrupts.
    const args = recoverCallArguments(name, rawArgs, TOOL_ARG_EXPECTATIONS) as
      | Record<string, unknown>
      | undefined;

    if (name === "recall") {
      try {
        // MCP-Progress-Notification (#38): wenn der Caller einen
        // progressToken mitschickt, leiten wir Stage-Events als
        // `notifications/progress` weiter. Claude Code rendert die als
        // Live-Stage-Lines unter dem Tool-Aufruf. Banter-Phrase landet
        // im `message`-Feld der Notification.
        const progressToken = (req.params as { _meta?: { progressToken?: string | number } })._meta
          ?.progressToken;
        const onStage: StageListener | undefined = progressToken !== undefined
          ? (s: RecallStage) => {
              // Nur Stop-Events (mit durationMs) als Progress-Tick
              // emittieren — Start-Events würden Claude Code mit
              // doppelten Lines fluten.
              if (s.durationMs === undefined && s.name !== "cache.hit" && s.name !== "done") return;
              const phrase = pickPhrase(s, banterMode, banterLang);
              const message = phrase
                ? `${s.name} — ${phrase}${s.durationMs !== undefined ? ` (${s.durationMs}ms)` : ""}`
                : `${s.name}${s.durationMs !== undefined ? ` (${s.durationMs}ms)` : ""}`;
              // Fire-and-forget — Notification-Failures dürfen den
              // Recall nicht kippen.
              void extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: progressIndexFor(s.name),
                  total: RECALL_STAGE_ORDER.length,
                  message,
                },
              }).catch(() => undefined);
            }
          : undefined;
        const result = await recallHandler(toolDeps, args, { onStage });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    if (name === "load_memory") {
      try {
        const result = await loadMemoryHandler(toolDeps, args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    if (name === "save_memory") {
      try {
        const result = await saveMemoryHandler(toolDeps, args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    if (name === "archive_memory") {
      try {
        const result = await archiveMemoryHandler(toolDeps, args ?? {});
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    if (name === "save_product_doc") {
      try {
        const result = await saveProductDocHandler(toolDeps, args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    if (name === "find_document") {
      const parsed = FindDocumentArgs.safeParse(args);
      if (!parsed.success) return errorResult(parsed.error.message);
      const result = findDocument(search, vault, parsed.data);
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    }

    if (name === "read_document") {
      const parsed = ReadDocumentArgs.safeParse(args);
      if (!parsed.success) return errorResult(parsed.error.message);
      const doc = readDocument(vault, parsed.data);
      // #457: derselbe Größen-Eintrag wie auf dem HTTP-Pfad.
      void toolDeps.telemetry.logReadDocument({
        id: parsed.data.id,
        found: doc !== null,
        ...(doc
          ? {
              delivered_chars: JSON.stringify(doc, null, 2).length,
              delivered_tokens_est: Math.ceil(JSON.stringify(doc, null, 2).length / 4),
              body_chars: doc.body.length,
            }
          : {}),
        caller_session: null,
      }).catch(() => {});
      if (!doc) return errorResult(`document not found: ${parsed.data.id}`);
      return {
        content: [
          { type: "text", text: JSON.stringify(doc, null, 2) },
        ],
      };
    }

    if (name === "open_document") {
      const parsed = OpenDocumentArgs.safeParse(args);
      if (!parsed.success) return errorResult(parsed.error.message);
      const result = await openDocument(vault, parsed.data);
      if ("ok" in result && !result.ok) {
        return errorResult(result.message);
      }
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    }

    if (name === "save_document" || name === "recategorize_document" || name === "move_document") {
      if (!DOCUMENT_WRITE_ENABLED) {
        return errorResult(
          `${name} is a Pro feature — set BASTRA_DOCUMENT_WRITE=1 to enable.`,
        );
      }
      try {
        if (name === "save_document") {
          const parsed = SaveDocumentArgs.safeParse(args);
          if (!parsed.success) return errorResult(parsed.error.message);
          const result = await saveDocument(vault, parsed.data);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }
        if (name === "recategorize_document") {
          const parsed = RecategorizeDocumentArgs.safeParse(args);
          if (!parsed.success) return errorResult(parsed.error.message);
          const result = await recategorizeDocument(vault, parsed.data);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }
        // move_document
        const parsed = MoveDocumentArgs.safeParse(args);
        if (!parsed.success) return errorResult(parsed.error.message);
        const result = await moveDocument(vault, parsed.data);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorResult((err as Error).message);
      }
    }

    return errorResult(`unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[bastra-recall] MCP server ready on stdio`);

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

function errorResult(msg: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: msg }],
  };
}

interface OllamaInfo {
  baseURL: string;
  model: string;
  keepAlive: string | number;
}

/**
 * Resolve the embedding provider. The PRECEDENCE (env > cli-settings >
 * API-key > none) lives in ONE shared place — resolveEmbeddingChoice in
 * settings.ts, also used by bridge.ts and the CLI (#79) — this function only
 * turns the resolved name into a provider instance + /health status.
 */
async function resolveEmbedding(): Promise<{
  provider: EmbeddingProvider | null;
  status: EmbeddingStatus;
  ollama?: OllamaInfo;
}> {
  const choice = await resolveEmbeddingChoice({
    onInvalidEnv: (raw) =>
      console.error(
        `[bastra-recall] ignoring invalid BASTRA_EMBEDDING_PROVIDER ${JSON.stringify(raw)} — falling through to cli-settings / API-key`,
      ),
  });
  if (choice.provider === "ollama") return ollamaEmbedding(choice.source);
  if (choice.provider === "openai") {
    // provider "openai" implies the resolver saw a key — re-read it for the ctor.
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.BASTRA_EMBEDDING_KEY;
    if (apiKey) return openaiEmbedding(choice.source, apiKey);
  }
  return offEmbedding(choice.source);
}

function ollamaEmbedding(source: EmbeddingSource): {
  provider: EmbeddingProvider;
  status: EmbeddingStatus;
  ollama: OllamaInfo;
} {
  const baseURL = process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434";
  const model = process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma";
  const dimEnv = process.env.BASTRA_EMBEDDING_DIM;
  const parsed = dimEnv ? Number.parseInt(dimEnv, 10) : undefined;
  // Number.isFinite guard: `NaN ?? 768` keeps NaN (NaN isn't nullish), which
  // would poison the index dim. A non-numeric env value → fall back to default.
  const dim = parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
  // keep_alive pro Embed-Request (#78 Power-Plan): hält das Modell während
  // aktiver Arbeit warm, ohne es für immer im RAM zu pinnen.
  const keepAlive = process.env.BASTRA_OLLAMA_KEEP_ALIVE ?? "10m";
  const provider = new OllamaEmbeddingProvider({ baseURL, model, dim, keepAlive });
  return { provider, status: { on: true, providerId: provider.id, source }, ollama: { baseURL, model, keepAlive } };
}

function openaiEmbedding(source: EmbeddingSource, apiKey: string): { provider: EmbeddingProvider; status: EmbeddingStatus } {
  const provider = new OpenAIEmbeddingProvider({ apiKey });
  return { provider, status: { on: true, providerId: provider.id, source } };
}

function offEmbedding(source: EmbeddingSource): { provider: null; status: EmbeddingStatus } {
  return { provider: null, status: { on: false, providerId: null, source } };
}

main().catch((err) => {
  console.error("[bastra-recall] FATAL:", err);
  process.exit(1);
});
