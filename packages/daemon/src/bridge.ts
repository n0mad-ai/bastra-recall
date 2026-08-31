#!/usr/bin/env node
/**
 * bastra-recall bridge — line-JSON RPC over stdio.
 *
 * Designed to be spawned as a child process by the Mac-app's Tauri
 * backend. The MCP server (index.ts) is for Claude Code; this bridge
 * is for the app's UI. Same vault, same in-memory index, different
 * transport.
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
import {
  Vault,
  SearchIndex,
  EmbeddingIndex,
  OpenAIEmbeddingProvider,
  OllamaEmbeddingProvider,
  RelatedEnricher,
  type EmbeddingProvider,
  SaveMemoryInput,
  AuditLog,
  AuditContext,
  auditedSave,
  auditedSoftDelete,
  auditedRestore,
  scopeEquals,
} from "@bastra-recall/core";
import { envFirst, envInt, envFloat, envBool } from "./env.js";
import { embeddingStatusLine, type EmbeddingStatus, type EmbeddingSource } from "./embedding-status.js";
import {
  getDocsMode,
  setDocsMode,
  getDocsLanguage,
  setDocsLanguage,
  isDocsMode,
  isDocsLanguage,
  DOCS_MODES,
  getSharedRecallEnabled,
  getSharedRecallLanguage,
  resolveEmbeddingChoice,
} from "./settings.js";
import { expandQuery, BridgePool } from "./learned-recall/bridges.js";
import { isSupportedLanguage, type SupportedLanguage } from "./learned-recall/language.js";
import { bridgesPath } from "./cli/bridges.js";
import readline from "node:readline";
import * as path from "node:path";

/**
 * Aktiviert Embeddings über die EINE geteilte Auflösung (settings.ts,
 * resolveEmbeddingChoice — dieselbe wie index.ts und die CLI, #79):
 *   env BASTRA_EMBEDDING_PROVIDER > cli-settings.json embedding.provider >
 *   API-Key (Backwards-Compat) > none (Recall fällt auf reines BM25).
 *
 * Env gewinnt immer — die Pro-App gibt ihre Wahl im Spawn-Env mit und wird
 * von der Datei nie überstimmt. Setzt die App KEIN Env, greift die per
 * `bastra embeddings on` persistierte Wahl, damit semantischer Recall den
 * Daemon unabhängig vom spawnenden Client erreicht.
 */
async function attachEmbeddings(search: SearchIndex, vault: Vault): Promise<void> {
  const { provider, status } = await resolveEmbedding();
  // Same wording as the daemon (index.ts) via the shared helper; bridge keeps
  // its own tag. Logged on every path including success (the silence was #79).
  process.stderr.write(embeddingStatusLine(status, "[bastra-recall.bridge]") + "\n");
  if (!provider) return;
  const persistPath = path.join(VAULT_PATH!, ".bastra", "embeddings.json");
  const idx = new EmbeddingIndex(vault, provider, persistPath);
  await idx.start();
  search.useEmbeddings(idx);
  process.stderr.write(
    `[bastra-recall.bridge] embeddings ready (${idx.size()} vectors, ${idx.pendingSize()} pending)\n`,
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
      `[bastra-recall.bridge] auto-related: enabled (top ${envInt("BASTRA_RELATED_TOP_N", 5)} ≥ ${envFloat("BASTRA_RELATED_THRESHOLD", 0.7)}, defers to daemon)\n`,
    );
  }
  // doc2query Trigger-Expander (#117) läuft bewusst NUR im Daemon (index.ts),
  // nicht hier: die App-only-Bridge hat ihren eigenen Ollama-Lifecycle, und
  // LLM-Gen-Last pro Embed ist anders gelagert als das billige Cosine des
  // RelatedEnrichers. App-only-Setups bekommen Trigger-Expansion beim nächsten
  // Daemon-Lauf (der Backfill-Sweep holt dann alles Unexpandierte nach).
}

// ─── Single-Writer-Probe ─────────────────────────────────────────
// Cached health-Probe auf den Daemon (Port BASTRA_HTTP_PORT, Default 6723 —
// gleiche Auflösung wie die Hooks). TTL 30s: der Gate wird pro Enrich-Write
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
  const port = envInt("BASTRA_HTTP_PORT", 6723, "NEXUS_HTTP_PORT");
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 1000);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
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

/**
 * Provider resolution via the shared resolveEmbeddingChoice (settings.ts) —
 * identical precedence to index.ts and the CLI: env > cli-settings.json >
 * API-key > none. Env always wins, so the Pro app's spawn-env choice is never
 * overridden by the file; the file only fills the gap when no env is set
 * (owner decision on #79: the persisted setting reaches the daemon regardless
 * of which client spawned it).
 */
async function resolveEmbedding(): Promise<{ provider: EmbeddingProvider | null; status: EmbeddingStatus }> {
  const choice = await resolveEmbeddingChoice({
    onInvalidEnv: (raw) =>
      process.stderr.write(
        `[bastra-recall.bridge] ignoring invalid BASTRA_EMBEDDING_PROVIDER ${JSON.stringify(raw)} — falling through to cli-settings / API-key\n`,
      ),
  });
  if (choice.provider === "ollama") return ollamaE(choice.source);
  if (choice.provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.BASTRA_EMBEDDING_KEY;
    if (apiKey) return openaiE(choice.source, apiKey);
  }
  return offE(choice.source);
}

function ollamaE(source: EmbeddingSource): { provider: EmbeddingProvider; status: EmbeddingStatus } {
  const baseURL = process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434";
  const model = process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma";
  // Optional dim override for non-default models (e.g. bge-m3 at 1024 dim).
  // Number.isFinite guard: `NaN ?? default` keeps NaN, poisoning the index dim.
  const dimEnv = process.env.BASTRA_EMBEDDING_DIM;
  const parsed = dimEnv ? Number.parseInt(dimEnv, 10) : undefined;
  const dim = parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
  const provider = new OllamaEmbeddingProvider({ baseURL, model, dim });
  return { provider, status: { on: true, providerId: provider.id, source } };
}

function openaiE(source: EmbeddingSource, apiKey: string): { provider: EmbeddingProvider; status: EmbeddingStatus } {
  const provider = new OpenAIEmbeddingProvider({ apiKey });
  return { provider, status: { on: true, providerId: provider.id, source } };
}

function offE(source: EmbeddingSource): { provider: null; status: EmbeddingStatus } {
  return { provider: null, status: { on: false, providerId: null, source } };
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

function send(payload: object): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function main(): Promise<void> {
  const vault = new Vault(VAULT_PATH!);
  const { loaded, skipped } = await vault.init();
  process.stderr.write(
    `[bastra-recall.bridge] vault loaded: ${loaded} memorys` +
      (skipped.length ? `, ${skipped.length} skipped` : "") +
      "\n",
  );
  vault.startWatching();
  const search = new SearchIndex(vault);
  search.start();
  const auditLog = new AuditLog(VAULT_PATH!);

  // Shared learned-recall (#120): load the bridge pool so the Mac-app recall
  // surface widens queries consistently with the MCP + hook paths. Same gate as
  // index.ts — off ⇒ null pool ⇒ expandQuery is a no-op. Degrades to raw query.
  let learnedBridges: BridgePool | null = null;
  let sharedRecallLang: SupportedLanguage | null = null;
  if (await getSharedRecallEnabled()) {
    try {
      learnedBridges = BridgePool.load(bridgesPath());
      const lang = await getSharedRecallLanguage();
      sharedRecallLang = isSupportedLanguage(lang) ? lang : null;
    } catch {
      learnedBridges = null;
    }
  }

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

  rl.on("line", (line) => {
    let req: Request;
    try {
      req = JSON.parse(line);
    } catch {
      return; // malformed → silently drop, no id to reply to
    }
    const { id, method, params } = req;
    try {
      let result: unknown;
      switch (method) {
        case "vault_status":
          result = { size: vault.size() };
          break;
        case "recall": {
          // Hybrid (BM25 + Vector via RRF) wenn EmbeddingIndex registriert,
          // sonst plain BM25 (sync). Mac-App sieht IMMER den vollen Vault
          // inkl. private-Memories → allow_private: true hardgecoded; der
          // MCP-Server (index.ts) ist die richtige Stelle für externen
          // Filter. expand_hops/scope/type sind optional vom Caller.
          const opts = {
            k: params?.k as number | undefined,
            scope: params?.scope as string | undefined,
            type: params?.type as string | undefined,
            allow_private: true,
            expand_hops: (params?.expand_hops === 1 ? 1 : 0) as 0 | 1,
          };
          const authoredQuery = String(params?.query ?? "");
          const recallQuery = expandQuery(authoredQuery, learnedBridges, {
            configuredLang: sharedRecallLang,
          }).query;
          // Anker und Berechtigungen nur aus der authored Query — die
          // Erweiterung darf Treffer finden, aber keine Absicht behaupten.
          const anchoredOpts = { ...opts, authored_query: authoredQuery };
          if (search.hasEmbeddings()) {
            search
              .recallHybrid(recallQuery, anchoredOpts)
              .then((hits) => send({ id, result: hits }))
              .catch((err: Error) => send({ id, error: { message: err.message } }));
            return;
          }
          result = search.recall(recallQuery, anchoredOpts);
          break;
        }
        case "list_memorys": {
          const wantType = params?.type as string | undefined;
          const wantScope = params?.scope as string | undefined;
          const all = vault.list();
          const filtered = all
            .filter((m) => !m.fm.obsolete)
            .filter((m) => !wantType || m.fm.type === wantType)
            .filter((m) => !wantScope || scopeEquals(m.fm.scope, wantScope));
          result = filtered.map((m) => m.fm);
          break;
        }
        case "load_memory": {
          const m = search.loadFull(String(params?.id ?? ""));
          result = m
            ? {
                id: m.fm.id,
                frontmatter: m.fm,
                body: m.body,
                file_path: m.filePath,
              }
            : null;
          break;
        }
        case "save_memory": {
          // Caller-supplied audit_context wird vor dem Save-Schema getrennt;
          // Default-Actor für Mac-App-Aufrufe ist "user" (kein expliziter Reason nötig).
          const rawParams = (params ?? {}) as Record<string, unknown>;
          const ctxRaw = rawParams.audit_context as Record<string, unknown> | undefined;
          const { audit_context: _ignored, ...rest } = rawParams;
          void _ignored;
          const ctx = AuditContext.parse(ctxRaw ?? { actor: "user" });
          const parsed = SaveMemoryInput.safeParse(rest);
          if (!parsed.success) {
            throw new Error(parsed.error.message);
          }
          auditedSave({
            vault,
            auditLog,
            vaultRoot: VAULT_PATH!,
            input: parsed.data,
            context: ctx,
          })
            .then(async ({ result, audit, audit_warning }) => {
              await vault.reindexFile(result.file_path);
              // Codex-Gegenreview Runde 10 (Security): Der Spread schickte
              // `audit_before`/`audit_after` mit — vollständige
              // Frontmatter-Abbilder inklusive `sensitivity: private`. Der
              // MCP-Pfad entfernt sie seit langem ausdrücklich
              // (`tool-handlers.ts`), die Bridge tat es nicht; derselbe Client
              // bekam über den einen Weg Audit-Material, über den anderen nicht.
              const { audit_before: _b, audit_after: _a, ...payload } = result;
              send({
                id,
                result: {
                  ...payload,
                  audit_id: audit?.id ?? null,
                  ...(audit_warning ? { audit_warning } : {}),
                },
              });
            })
            .catch((err: Error) => {
              send({ id, error: { message: err.message } });
            });
          return;
        }
        case "delete_memory": {
          const targetId = String(params?.id ?? "").trim();
          if (!targetId) throw new Error("id is required");
          const ctxRaw = (params as Record<string, unknown> | undefined)
            ?.audit_context as Record<string, unknown> | undefined;
          const ctx = AuditContext.parse(ctxRaw ?? { actor: "user" });
          auditedSoftDelete({
            vault,
            auditLog,
            vaultRoot: VAULT_PATH!,
            memoryID: targetId,
            context: ctx,
          })
            .then(({ id: deletedId, trashPath, audit, audit_warning }) => {
              send({
                id,
                result: {
                  id: deletedId,
                  file_path: trashPath,
                  deleted: true,
                  audit_id: audit?.id ?? null,
                  ...(audit_warning ? { audit_warning } : {}),
                },
              });
            })
            .catch((err: Error) => {
              send({ id, error: { message: err.message } });
            });
          return;
        }
        case "restore_memory": {
          const targetId = String(params?.id ?? "").trim();
          if (!targetId) throw new Error("id is required");
          const ctxRaw = (params as Record<string, unknown> | undefined)
            ?.audit_context as Record<string, unknown> | undefined;
          const ctx = AuditContext.parse(ctxRaw ?? { actor: "user" });
          const destOverride =
            typeof (params as Record<string, unknown> | undefined)?.dest_file_path
              === "string"
              ? ((params as Record<string, unknown>).dest_file_path as string)
              : undefined;
          auditedRestore({
            auditLog,
            vault,
            vaultRoot: VAULT_PATH!,
            memoryID: targetId,
            destFilePath: destOverride,
            context: ctx,
          })
            .then(async ({ id: restoredId, restoredTo, audit, audit_warning }) => {
              // Restore = neuer File-Add für den Vault — explicit reindex.
              await vault.reindexFile(restoredTo);
              send({
                id,
                result: {
                  id: restoredId,
                  file_path: restoredTo,
                  audit_id: audit?.id ?? null,
                  ...(audit_warning ? { audit_warning } : {}),
                },
              });
            })
            .catch((err: Error) => {
              send({ id, error: { message: err.message } });
            });
          return;
        }
        case "reindex_file": {
          // Cloud-Storage chokidar-Watcher kann mehrere Sekunden lagged
          // sein. Mac-App ruft das nach direktem Sidecar-Write um sofortige
          // Recall-Konsistenz zu erzwingen (Document-Hub Phase 1.4).
          const filePath = String(params?.file_path ?? "").trim();
          if (!filePath) throw new Error("file_path is required");
          vault.reindexFile(filePath)
            .then(() => send({ id, result: { reindexed: true, file_path: filePath } }))
            .catch((err: Error) => send({ id, error: { message: err.message } }));
          return;
        }
        // Produkt-Doku-Settings für die Options-Pane der Mac-App — dünne
        // Wrapper über das OSS-Settings-File (~/.bastra/cli-settings.json),
        // damit die App das File nie direkt anfasst.
        case "docs_settings_get": {
          Promise.all([getDocsMode(), getDocsLanguage()])
            .then(([mode, language]) => send({ id, result: { mode, language } }))
            .catch((err: Error) => send({ id, error: { message: err.message } }));
          return;
        }
        case "docs_settings_set": {
          const mode = params?.mode;
          const language = params?.language;
          (async () => {
            if (mode !== undefined) {
              if (!isDocsMode(mode)) {
                throw new Error(`mode must be one of: ${DOCS_MODES.join(" | ")}`);
              }
              await setDocsMode(mode);
            }
            if (language !== undefined) {
              if (!isDocsLanguage(language)) {
                throw new Error("language must be a short tag like 'en', 'de', 'pt-br'");
              }
              await setDocsLanguage(language);
            }
            return { mode: await getDocsMode(), language: await getDocsLanguage() };
          })()
            .then((result) => send({ id, result }))
            .catch((err: Error) => send({ id, error: { message: err.message } }));
          return;
        }
        case "audit_history": {
          const memoryID = String(params?.memory_id ?? "").trim();
          if (!memoryID) throw new Error("memory_id is required");
          auditLog.forMemory(memoryID)
            .then((entries) => send({ id, result: entries }))
            .catch((err: Error) => send({
              id,
              error: { message: err.message },
            }));
          return;
        }
        case "audit_recent": {
          const sinceISO = String(params?.since ?? "");
          if (!sinceISO) throw new Error("since (ISO timestamp) is required");
          const filterActor = params?.actor as string | undefined;
          const filterOp = params?.operation as string | undefined;
          auditLog
            .since(sinceISO, {
              actor: filterActor as never,
              operation: filterOp as never,
            })
            .then((entries) => send({ id, result: entries }))
            .catch((err: Error) => send({
              id,
              error: { message: err.message },
            }));
          return;
        }
        default:
          throw new Error(`unknown method: ${method}`);
      }
      send({ id, result });
    } catch (err) {
      send({
        id,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  rl.on("close", () => {
    process.stderr.write("[bastra-recall.bridge] stdin closed, exiting\n");
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`[bastra-recall.bridge] FATAL: ${err}\n`);
  process.exit(1);
});
