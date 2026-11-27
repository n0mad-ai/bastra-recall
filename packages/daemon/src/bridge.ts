#!/usr/bin/env node
import { processOwnsVault } from "./local-account-access.js";
/**
 * bastra-recall bridge — line-JSON RPC over stdio.
 *
 * Designed to be spawned as a child process by the Mac-app's Tauri
 * backend. The MCP server (index.ts) is for Claude Code; this bridge
 * is for the app's UI. Same vault, same in-memory index, different
 * transport.
 *
 * #464: this is the TRUSTED transport. Being it is the capability — the app
 * spawns this process itself, so nothing here has to (or can) be requested by
 * an argument. The bridge therefore reads and writes `sensitivity: private`
 * records without asking, while the two public transports (REST dispatcher,
 * stdio MCP) can never reach them. `private-access.ts` holds that rule and
 * `TRUSTED_LOCAL_APP` is the single marker a future in-process app transport
 * passes into the shared tool handlers.
 *
 * Protocol (one JSON object per line, both directions):
 *   request:  {"id": <number>, "method": <string>, "params"?: <object>}
 *   response: {"id": <number>, "result": <any>}  OR
 *             {"id": <number>, "error": {"message": <string>}}
 *
 * Methods:
 *   vault_status()                       -> { size: number }
 *   recall({ query, k?, scope?, type? }) -> RecallHit[]
 *   list_memorys({ type?, scope? })      -> Frontmatter[]
 *   load_memory({ id })                  -> { id, frontmatter, body, file_path } | null
 *   save_memory(SaveMemoryInput)         -> { id, file_path, created }
 *   delete_memory({ id })                -> { id, file_path, deleted }
 *   docs_settings_get()                  -> { mode, language }
 *   docs_settings_set({ mode?, language? }) -> { mode, language }
 */
import { tasksEnabled } from "./tasks-enabled.js";
import { isTaskExecution } from "./task-execution.js";
import { forwardTaskExecution } from "./task-execution-client.js";
import { isTaskTool, defaultTaskContext, taskClientAuthorization, taskFailure } from "./task-transport.js";
import { taskAttachment } from "./task-delivery.js";
import type { TaskServiceContext } from "./task-service.js";
import { callTaskCrud } from "./task-service.js";
import { Vault, SearchIndex, EmbeddingIndex, RelatedEnricher, AuditLog } from "@bastra-recall/core";
import { envFirst, envInt, envFloat, envBool } from "./env.js";
import { resolveDaemonEndpoint } from "./daemon-endpoint.js";
import { embeddingStatusLine, cloudConsentNotice } from "./embedding-status.js";
import { resolveEmbedding } from "./embedding-provider.js";
import {
  getSharedRecallEnabled,
  getSharedRecallLanguage,
  getSharedRecallLive,
  getVaultReconcileEnabled,
} from "./settings.js";
import { BridgePool } from "./learned-recall/bridges.js";
import { createBridgeMethods, type BridgeMethod } from "./bridge-methods.js";
import { isSupportedLanguage, type SupportedLanguage } from "./learned-recall/language.js";
import { bridgesPath, migrateBridgesPool } from "./learned-recall/pool-path.js";
import { startVaultReconcile } from "./daemon-jobs.js";
import { ensureLocalTaskAgent } from "./task-auto-setup.js";
import { startProactiveTaskJob } from "./daemon-jobs.js";
import readline from "node:readline";
import * as path from "node:path";

/**
 * Aktiviert Embeddings über die EINE geteilte Auflösung (settings.ts,
 * resolveEmbeddingChoice — dieselbe wie index.ts und die CLI, #79):
 *   env BASTRA_EMBEDDING_PROVIDER > cli-settings.json embedding.provider >
 *   none (Recall fällt auf reines BM25). Ein bloßer OPENAI_API_KEY schaltet
 *   die Cloud NIE frei (#520).
 *
 * Env gewinnt immer — die Pro-App gibt ihre Wahl im Spawn-Env mit und wird
 * von der Datei nie überstimmt. Setzt die App KEIN Env, greift die per
 * `bastra embeddings on` persistierte Wahl, damit semantischer Recall den
 * Daemon unabhängig vom spawnenden Client erreicht.
 */
async function attachEmbeddings(search: SearchIndex, vault: Vault): Promise<void> {
  // As before, the bridge sends no Ollama keep_alive; only the daemon's power plan does (#78).
  const { provider, status } = await resolveEmbedding({
    keepAlive: false,
    onInvalidEnv: (raw) =>
      process.stderr.write(
        `[bastra-recall.bridge] ignoring invalid BASTRA_EMBEDDING_PROVIDER ${JSON.stringify(raw)} — falling through to cli-settings\n`
      ),
  });
  // Same wording as the daemon (index.ts) via the shared helper; bridge keeps
  // its own tag. Logged on every path including success (the silence was #79).
  process.stderr.write(embeddingStatusLine(status, "[bastra-recall.bridge]") + "\n");
  // #520: same migration notice as the daemon, same wording, bridge tag.
  const consentNotice = cloudConsentNotice(status, "[bastra-recall.bridge]");
  if (consentNotice) process.stderr.write(consentNotice + "\n");
  if (!provider) return;
  const persistPath = path.join(VAULT_PATH!, ".bastra", "embeddings.json");
  const idx = new EmbeddingIndex(vault, provider, persistPath);
  await idx.start();
  search.useEmbeddings(idx);
  process.stderr.write(
    `[bastra-recall.bridge] embeddings ready (${idx.size()} vectors, ${idx.pendingSize()} pending)\n`
  );
  // Auto-Related-Enricher: pflegt frontmatter.related_via nach jedem Embed-
  // Batch. Im Bridge-Pfad (Mac-App) gleicher Default-Status wie im MCP-Pfad.
  // Single-Writer: writeGate lässt die Bridge nur schreiben, wenn KEIN Daemon
  // läuft (App-only-Setup). Läuft einer, gehört related_via ihm — zwei
  // Enricher mit eigenen Indizes runden Cosines minimal anders und
  // überschreiben sonst dasselbe File im Sekundentakt (Write-Ping-Pong,
  // hielt das Ollama-Modell permanent geladen).
  if (envBool("BASTRA_AUTO_RELATED", true)) {
    const enricher = new RelatedEnricher(vault, idx, {
      topN: envInt("BASTRA_RELATED_TOP_N", 5),
      threshold: envFloat("BASTRA_RELATED_THRESHOLD", 0.7),
      writeGate: daemonAbsent,
    });
    enricher.start();
    process.stderr.write(
      `[bastra-recall.bridge] auto-related: enabled (top ${envInt("BASTRA_RELATED_TOP_N", 5)} ≥ ${envFloat("BASTRA_RELATED_THRESHOLD", 0.7)}, defers to daemon)\n`
    );
  }
  // doc2query Trigger-Expander (#117) läuft bewusst NUR im Daemon (index.ts),
  // nicht hier: die App-only-Bridge hat ihren eigenen Ollama-Lifecycle, und
  // LLM-Gen-Last pro Embed ist anders gelagert als das billige Cosine des
  // RelatedEnrichers. App-only-Setups bekommen Trigger-Expansion beim nächsten
  // Daemon-Lauf (der Backfill-Sweep holt dann alles Unexpandierte nach).
}

// ─── Single-Writer-Probe ─────────────────────────────────────────
// Cached health-Probe auf den Daemon — THE Endpunkt (#531), dieselbe
// Auflösung wie CLI, Daemon, Forwarder und Hooks. TTL 30s: der Gate wird pro Enrich-Write
// gefragt; ohne Cache würde jeder Embed-Batch eine HTTP-Probe kosten.
const DAEMON_PROBE_TTL_MS = 30_000;
let daemonProbeAt = 0;
let daemonAlive = false;

async function daemonAbsent(): Promise<boolean> {
  const now = Date.now();
  if (now - daemonProbeAt > DAEMON_PROBE_TTL_MS) {
    daemonProbeAt = now;
    daemonAlive = await probeDaemonHealth();
  }
  return !daemonAlive;
}

async function probeDaemonHealth(): Promise<boolean> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 1000);
  try {
    const resp = await fetch(resolveDaemonEndpoint().healthUrl, {
      signal: ctrl.signal,
    });
    if (!resp.ok) return false;
    const body = (await resp.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(tid);
  }
}

const VAULT_PATH = envFirst("BASTRA_VAULT_PATH", "NEXUS_VAULT_PATH");
if (!VAULT_PATH) {
  process.stderr.write("[bastra-recall.bridge] FATAL: BASTRA_VAULT_PATH is not set\n");
  process.exit(2);
}

interface Request {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

let passiveTaskContext: TaskServiceContext | undefined;
function send(payload: object): void {
  const write = (value: object) => process.stdout.write(JSON.stringify(value) + "\n");
  if (!passiveTaskContext || !("result" in payload)) {
    write(payload);
    return;
  }
  void (async () => {
    const attachment = await taskAttachment(passiveTaskContext!, await taskClientAuthorization(), "bridge", "http");
    write(attachment ? { ...payload, proactive_due: attachment.due } : payload);
    attachment?.record();
  })().catch(() => write(payload));
}

/** One request line: task tools go to the task service, everything else to the method table. */
async function handleLine(line: string, vault: Vault, methods: Record<string, BridgeMethod>): Promise<void> {
  let req: Request;
  try {
    req = JSON.parse(line);
  } catch {
    return; // malformed → silently drop, no id to reply to
  }
  const { id, method, params } = req;
  try {
    if (isTaskTool(method)) {
      if (!tasksEnabled())
        throw Object.assign(new Error("Tasks disabled; enable in Settings or with BASTRA_TASKS=1"), {
          code: "feature_disabled",
        });
      const result = isTaskExecution(method)
        ? await forwardTaskExecution(method, params ?? {}, await taskClientAuthorization())
        : await callTaskCrud(
            defaultTaskContext({ vault, vaultPath: VAULT_PATH! }),
            await taskClientAuthorization(),
            method,
            params ?? {}
          );
      process.stdout.write(JSON.stringify({ id, result }) + "\n");
      return;
    }
    const run = typeof method === "string" && Object.hasOwn(methods, method) ? methods[method] : undefined;
    if (!run) throw new Error(`unknown method: ${method}`);
    send({ id, result: await run(params) });
  } catch (err) {
    send({
      id,
      error: isTaskTool(method) ? taskFailure(err).body : { message: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Shared learned-recall (#120): the bridge pool, so the Mac-app recall surface
 * widens queries consistently with the MCP + hook paths. Same gate as index.ts —
 * off ⇒ null pool ⇒ expandQuery is a no-op. Degrades to the raw query.
 */
async function loadSharedRecall(): Promise<{
  learnedBridges: BridgePool | null;
  sharedRecallLang: SupportedLanguage | null;
}> {
  if (!(await getSharedRecallEnabled())) return { learnedBridges: null, sharedRecallLang: null };
  try {
    migrateBridgesPool(); // #648: the app may start before the daemon does
  } catch {
    /* the daemon's own start retries and logs it */
  }
  try {
    const learnedBridges = BridgePool.load(bridgesPath(), undefined, { live: await getSharedRecallLive() });
    const lang = await getSharedRecallLanguage();
    return { learnedBridges, sharedRecallLang: isSupportedLanguage(lang) ? lang : null };
  } catch {
    return { learnedBridges: null, sharedRecallLang: null };
  }
}

async function main(): Promise<void> {
  const vault = new Vault(VAULT_PATH!);
  const { loaded, skipped } = await vault.init();
  process.stderr.write(
    `[bastra-recall.bridge] vault loaded: ${loaded} memorys` +
      (skipped.length ? `, ${skipped.length} skipped` : "") +
      "\n"
  );
  vault.startWatching();
  // #368: the bridge is long-lived (spawned once by the Mac app's Tauri
  // backend) and, unlike the daemon, had only the watcher for ongoing sync —
  // no fallback for what fsevents misses on cloud mounts or after a watcher
  // error. Same job the daemon runs on its own boot (daemon-jobs.ts), reused
  // rather than re-implemented: the same setting and environment override
  // apply to both, and the unref()'d timer is cleared below on stdin close.
  const reconcileTimer = startVaultReconcile(vault, await getVaultReconcileEnabled());
  // Dedicated mapping is required even on this trusted legacy transport.
  passiveTaskContext = (await processOwnsVault(vault.root))
    ? defaultTaskContext({ vault, vaultPath: VAULT_PATH! })
    : undefined;
  if (passiveTaskContext) await ensureLocalTaskAgent().catch(() => undefined);
  const proactiveJob =
    passiveTaskContext && (await taskClientAuthorization()) ? startProactiveTaskJob(passiveTaskContext) : undefined;
  const search = new SearchIndex(vault);
  search.start();
  const auditLog = new AuditLog(VAULT_PATH!);

  const { learnedBridges, sharedRecallLang } = await loadSharedRecall();
  const methods = createBridgeMethods({
    vault,
    search,
    auditLog,
    vaultPath: VAULT_PATH!,
    learnedBridges,
    sharedRecallLang,
  });

  // Optional: Embedding-Index für semantische Recall-Suche. Provider wird per
  // BASTRA_EMBEDDING_PROVIDER gewählt (ollama|openai|none) und mit BM25 via RRF
  // gefused. Ohne expliziten Provider aktiviert ein vorhandener OPENAI_API_KEY
  // OpenAI (Backwards-Compat); sonst bleibt Recall reines BM25.
  attachEmbeddings(search, vault).catch((err) => {
    process.stderr.write(`[bastra-recall.bridge] embeddings attach error: ${err}\n`);
  });

  // Push-Channel: jedes Vault-Event geht als unsolicited Notification an die
  // App, damit die UI live aktualisiert ohne pollen zu müssen. Notifications
  // haben kein `id`-Feld — die App unterscheidet so von Responses.
  vault.on((e) => {
    if (e.kind === "remove") {
      send({ event: "vault_changed", kind: "remove", memory_id: e.id });
    } else {
      send({ event: "vault_changed", kind: e.kind, memory_id: e.memory.fm.id });
    }
  });

  process.stderr.write("[bastra-recall.bridge] ready\n");

  const rl = readline.createInterface({ input: process.stdin });

  rl.on("line", (line) => void handleLine(line, vault, methods));

  rl.on("close", () => {
    // Stop the reconcile loop explicitly on the bridge's one shutdown path
    // (the parent closing stdin) — process.exit() below would take it with
    // it regardless since it's unref'd, but a live handle left dangling past
    // its owner's shutdown is the wrong invariant to leave for the next
    // reader of this file.
    if (reconcileTimer) clearInterval(reconcileTimer);
    proactiveJob?.stop();
    process.stderr.write("[bastra-recall.bridge] stdin closed, exiting\n");
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`[bastra-recall.bridge] FATAL: ${err}\n`);
  process.exit(1);
});
