/**
 * Start-up phase 4 (#1039): the dense arm — latency profile, provider
 * resolution, circuit breaker, battery monitor, the shared warm-up
 * coordinator, the embedding index with its Ollama autostart + boot warm-up,
 * the related-enricher and the doc2query trigger expander.
 *
 * Moved verbatim out of `main()` in `index.ts`, together with the provider
 * resolution helpers that sat at the bottom of that file. The phase is split
 * in two only where an `await` boundary would otherwise move side effects:
 * `startEmbeddings` resolves the provider and builds the coordinators, and the
 * `startEmbeddingIndex` it returns starts the index and the fire-and-forget
 * Ollama autostart + boot warm-up. `main()` calls that synchronously, right
 * before the update check, so the warm-up's first steps land after the update
 * check exactly as they did before the split. `triggerExpandModel` is set
 * later (in the index start's `.then`), so it is handed out as a getter.
 */
import {
  Vault,
  SearchIndex,
  EmbeddingIndex,
  OllamaEmbeddingProvider,
  RelatedEnricher,
  TriggerExpander,
  type EmbeddingProvider,
} from "@bastra-recall/core";
import * as path from "node:path";
import type { Telemetry } from "./telemetry.js";
import { embeddingStatusLine, cloudConsentNotice, type EmbeddingStatus, type EmbeddingSource } from "./embedding-status.js";
import { cloudEmbeddingProvider } from "./embedding-cloud.js";
import { resolveEmbeddingChoice, resolveGenerationModel, getBatterySaver } from "./settings.js";
import { batterySaverEnabled, createPowerMonitor, type PowerMonitor } from "./power-source.js";
import { ollamaChat } from "./learned-recall/reranker.js";
import { envInt, envFloat, envBool } from "./env.js";
import { EmbeddingBreaker, BreakerGuardedProvider } from "./embedding-breaker.js";
import { createEmbeddingWarmup, type WarmupCoordinator } from "./embedding-warmup.js";
import { countingProvider, createLatencyProfile, type LatencyProfile } from "./latency-profile.js";
// #493: die datensparsame Kennung dieses Hosts — Tor 5 aus #492.
import { hostProfileId } from "./host-profile.js";
import { ensureOllamaServerForDaemon } from "./cli/ollama.js";

export async function startEmbeddings(opts: {
  vaultPath: string;
  vault: Vault;
  search: SearchIndex;
  telemetry: Telemetry;
}): Promise<{
  latencyProfile: LatencyProfile;
  rawProvider: EmbeddingProvider | null;
  embeddingStatus: EmbeddingStatus;
  ollama: OllamaInfo | undefined;
  startEmbeddingIndex: () => EmbeddingIndex | null;
  triggerExpandModel: () => string | null;
  embeddingBreaker: EmbeddingBreaker | null;
  power: PowerMonitor;
  warmupEmbedding: WarmupCoordinator;
}> {
  const { vaultPath, vault, search, telemetry } = opts;

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
  // #520: an installation that used to ride the OPENAI_API_KEY fallback must
  // see WHY it is on BM25 now, instead of degrading silently.
  const consentNotice = cloudConsentNotice(embeddingStatus);
  if (consentNotice) console.error(consentNotice);
  // Für /health (#92): Runtime-Health des Index, nicht nur die Boot-Config.
  let embIdxForHealth: EmbeddingIndex | null = null;
  /** Set once the doc2query paraphraser starts; /health reports it. */
  let triggerExpandModel: string | null = null;
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
  // #632: battery mode (opt-in). Polls `pmset` once a minute; off = never
  // polls and never defers anything.
  const power = createPowerMonitor({
    enabled: batterySaverEnabled(await getBatterySaver()),
    onChange: (source) => console.error(`[bastra-recall] power source: ${source}${source === "battery" ? " — battery saver defers background model work" : ""}`),
  });
  power.start();
  const warmupEmbedding = createEmbeddingWarmup({
    // `ollama` is set exactly when the resolved provider is an Ollama one —
    // the only case with a model that goes cold and that our per-request
    // keep_alive (#78) governs. A hosted API keeps no model of ours resident,
    // so warming it is one egress request for nothing.
    hostedProvider: () => rawProvider !== null && ollama === undefined,
    deferred: () => power.saving(),
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
      // Silent by design, same as the turn-start prewarm (boot-tool-deps.ts).
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
  // #1039: returns the index it attached (null with embeddings off). That is
  // assigned synchronously here and never again, so the plain value is the
  // same answer the old `embIdxForHealth` reads gave at call time.
  const startEmbeddingIndex = (): EmbeddingIndex | null => {
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
      const persistPath = path.join(vaultPath, ".bastra", "embeddings.json");
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
            const expandChat = ollamaChat({ baseURL: ollama.baseURL, model: expandModel, timeoutMs: expandTimeoutMs });
            const expander = new TriggerExpander(vault, embIdx, {
              // #632: on battery (saver on) every generation — the per-embed
              // one and the catch-up sweep, which is sequential — waits for AC.
              chat: async (prompt) => {
                await power.waitUntilNotSaving();
                return expandChat(prompt);
              },
              selfTest: async (phrase, id) => {
                const hits = await search.recallHybrid(phrase, { k: 10, allow_private: true });
                return hits.some((h) => h.id === id);
              },
            });
            expander.start();
            triggerExpandModel = expandModel;
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
    return embIdxForHealth;
  };

  return {
    latencyProfile,
    rawProvider,
    embeddingStatus,
    ollama,
    startEmbeddingIndex,
    triggerExpandModel: () => triggerExpandModel,
    embeddingBreaker,
    power,
    warmupEmbedding,
  };
}

export interface OllamaInfo {
  baseURL: string;
  model: string;
  keepAlive: string | number;
}

/**
 * Resolve the embedding provider. The PRECEDENCE (env > cli-settings > none)
 * lives in ONE shared place — resolveEmbeddingChoice in settings.ts, also used
 * by bridge.ts and the CLI (#79) — this function only turns the resolved name
 * into a provider instance + /health status. The cloud provider is built by
 * the one shared gate in embedding-cloud.ts (#520).
 */
async function resolveEmbedding(): Promise<{
  provider: EmbeddingProvider | null;
  status: EmbeddingStatus;
  ollama?: OllamaInfo;
}> {
  const choice = await resolveEmbeddingChoice({
    onInvalidEnv: (raw) =>
      console.error(
        `[bastra-recall] ignoring invalid BASTRA_EMBEDDING_PROVIDER ${JSON.stringify(raw)} — falling through to cli-settings`,
      ),
  });
  if (choice.provider === "ollama") return ollamaEmbedding(choice.source);
  const cloud = cloudEmbeddingProvider(choice);
  if (cloud) return { provider: cloud, status: { on: true, providerId: cloud.id, source: choice.source } };
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

function offEmbedding(source: EmbeddingSource): { provider: null; status: EmbeddingStatus } {
  return { provider: null, status: { on: false, providerId: null, source } };
}
