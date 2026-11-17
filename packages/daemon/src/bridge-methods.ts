/**
 * The app bridge's request methods (#1529): one entry per method name, each
 * resolving to the reply's `result` or rejecting with the reply's error. The
 * stdio loop, the task tools and the push channel stay in bridge.ts.
 */
import {
  type Vault,
  type SearchIndex,
  type AuditLog,
  SaveMemoryInput,
  AuditContext,
  auditedSave,
  auditedSoftDelete,
  auditedRestore,
  scopeEquals,
} from "@bastra-recall/core";
import {
  getDocsMode,
  setDocsMode,
  getDocsLanguage,
  setDocsLanguage,
  isDocsMode,
  isDocsLanguage,
  DOCS_MODES,
} from "./settings.js";
import { expandQuery, type BridgePool } from "./learned-recall/bridges.js";
import type { SupportedLanguage } from "./learned-recall/language.js";
import { isDryRun } from "./save-preview-request.js";

export interface BridgeMethodDeps {
  vault: Vault;
  search: SearchIndex;
  auditLog: AuditLog;
  vaultPath: string;
  learnedBridges: BridgePool | null;
  sharedRecallLang: SupportedLanguage | null;
}

type Params = Record<string, unknown> | undefined;
export type BridgeMethod = (params: Params) => Promise<unknown>;

/** Caller-supplied audit context; Mac app calls default to the user (no reason needed). */
const auditContext = (params: Params) =>
  AuditContext.parse((params?.audit_context as Record<string, unknown> | undefined) ?? { actor: "user" });

function required(params: Params, field: string, message: string): string {
  const value = String(params?.[field] ?? "").trim();
  if (!value) throw new Error(message);
  return value;
}

const auditFields = (audit: { id: string } | null | undefined, audit_warning: string | undefined) => ({
  audit_id: audit?.id ?? null,
  ...(audit_warning ? { audit_warning } : {}),
});

export function createBridgeMethods(d: BridgeMethodDeps): Record<string, BridgeMethod> {
  const { vault, search, auditLog, vaultPath } = d;
  return {
    vault_status: async () => ({ size: vault.size() }),

    // Hybrid (BM25 + vector via RRF) when an embedding index is registered,
    // else plain BM25. The Mac app always sees the full vault including private
    // memories → allow_private is hard-coded (#464: never from `params`, which
    // would be a self-issued permission). expand_hops/scope/type are optional.
    recall: async (params) => {
      const opts = {
        k: params?.k as number | undefined,
        scope: params?.scope as string | undefined,
        type: params?.type as string | undefined,
        allow_private: true,
        expand_hops: (params?.expand_hops === 1 ? 1 : 0) as 0 | 1,
      };
      const authoredQuery = String(params?.query ?? "");
      const recallQuery = expandQuery(authoredQuery, d.learnedBridges, { configuredLang: d.sharedRecallLang }).query;
      // Anchors and permissions come from the authored query only — the
      // expansion may find hits but never claim intent.
      const anchoredOpts = { ...opts, authored_query: authoredQuery };
      return search.hasEmbeddings()
        ? search.recallHybrid(recallQuery, anchoredOpts)
        : search.recall(recallQuery, anchoredOpts);
    },

    list_memorys: async (params) => {
      const wantType = params?.type as string | undefined;
      const wantScope = params?.scope as string | undefined;
      return vault
        .list()
        .filter((m) => !m.fm.obsolete)
        .filter((m) => !wantType || m.fm.type === wantType)
        .filter((m) => !wantScope || scopeEquals(m.fm.scope, wantScope))
        .map((m) => m.fm);
    },

    load_memory: async (params) => {
      const m = search.loadFull(String(params?.id ?? ""));
      return m ? { id: m.fm.id, frontmatter: m.fm, body: m.body, file_path: m.filePath } : null;
    },

    save_memory: async (params) => {
      if (isDryRun(params))
        throw new Error("save_memory: preview is unavailable on the app bridge. Nothing was written.");
      const { audit_context: _ignored, ...rest } = (params ?? {}) as Record<string, unknown>;
      void _ignored;
      const context = auditContext(params);
      const parsed = SaveMemoryInput.safeParse(rest);
      if (!parsed.success) throw new Error(parsed.error.message);
      const { result, audit, audit_warning } = await auditedSave({
        vault,
        auditLog,
        vaultRoot: vaultPath,
        input: parsed.data,
        context,
      });
      await vault.reindexFile(result.file_path);
      // Codex counter-review round 10 (security): audit_before/audit_after are
      // full frontmatter images incl. `sensitivity: private`; the MCP path drops
      // them (tool-handlers.ts), so the bridge does too.
      const { audit_before: _b, audit_after: _a, ...payload } = result;
      return { ...payload, ...auditFields(audit, audit_warning) };
    },

    delete_memory: async (params) => {
      const memoryID = required(params, "id", "id is required");
      const { id, trashPath, audit, audit_warning } = await auditedSoftDelete({
        vault,
        auditLog,
        vaultRoot: vaultPath,
        memoryID,
        context: auditContext(params),
      });
      return { id, file_path: trashPath, deleted: true, ...auditFields(audit, audit_warning) };
    },

    restore_memory: async (params) => {
      const memoryID = required(params, "id", "id is required");
      const context = auditContext(params);
      const destFilePath = typeof params?.dest_file_path === "string" ? params.dest_file_path : undefined;
      const { id, restoredTo, audit, audit_warning } = await auditedRestore({
        auditLog,
        vault,
        vaultRoot: vaultPath,
        memoryID,
        destFilePath,
        context,
      });
      // A restore is a new file for the vault — explicit reindex.
      await vault.reindexFile(restoredTo);
      return { id, file_path: restoredTo, ...auditFields(audit, audit_warning) };
    },

    // The cloud-storage watcher can lag by seconds; the Mac app calls this after
    // a direct sidecar write to force consistent recall (Document Hub phase 1.4).
    reindex_file: async (params) => {
      const filePath = required(params, "file_path", "file_path is required");
      await vault.reindexFile(filePath);
      return { reindexed: true, file_path: filePath };
    },

    // Product-doc settings for the Mac app's options pane: thin wrappers over
    // the OSS settings, so the app never touches the settings store itself.
    docs_settings_get: async () => {
      const [mode, language] = await Promise.all([getDocsMode(), getDocsLanguage()]);
      return { mode, language };
    },
    docs_settings_set: async (params) => {
      const mode = params?.mode;
      const language = params?.language;
      if (mode !== undefined) {
        if (!isDocsMode(mode)) throw new Error(`mode must be one of: ${DOCS_MODES.join(" | ")}`);
        await setDocsMode(mode);
      }
      if (language !== undefined) {
        if (!isDocsLanguage(language)) throw new Error("language must be a short tag like 'en', 'de', 'pt-br'");
        await setDocsLanguage(language);
      }
      return { mode: await getDocsMode(), language: await getDocsLanguage() };
    },

    audit_history: async (params) => auditLog.forMemory(required(params, "memory_id", "memory_id is required")),
    audit_recent: async (params) => {
      const sinceISO = String(params?.since ?? "");
      if (!sinceISO) throw new Error("since (ISO timestamp) is required");
      return auditLog.since(sinceISO, {
        actor: params?.actor as never,
        operation: params?.operation as never,
      });
    },
  };
}
