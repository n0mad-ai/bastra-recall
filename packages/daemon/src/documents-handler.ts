/**
 * Document-Hub MCP-Tool-Handler. Read-only — Phase 2.1 lebt komplett hier in
 * bastra-recall (OSS, MIT) und ist für jeden MCP-fähigen Coding-Agent ohne
 * Pro-Lizenz nutzbar (Triage-Repo-Split aus Issue #24).
 *
 * Schreib-Tools (`save_document`/`recategorize`/`move_document`) leben in
 * bastra-pro hinter Lizenz-Gate.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { Vault, SearchIndex } from "@bastra-recall/core";

// ─── Argument schemas ───────────────────────────────────────────

export const FindDocumentArgs = z.object({
  query: z.string().min(1),
  // Triage: Top-3 default, Token-Budget. Hardcap 5.
  k: z.number().int().min(1).max(5).optional(),
});

export const ReadDocumentArgs = z.object({
  id: z.string().min(1),
});

export const OpenDocumentArgs = z.object({
  id: z.string().min(1),
});

// ─── Tool definitions for ListTools response ─────────────────────

export const documentTools = [
  {
    name: "find_document",
    // Read-only annotation: lands in the bulk-approvable "Read-only tools"
    // permission group of clients like Claude Desktop.
    annotations: { readOnlyHint: true, destructiveHint: false },
    description:
      "Search the user's document vault (PDFs, notes, contracts, code) " +
      "and return top-3 hits with id, title, summary and score. " +
      "Pair with read_document to load full content. " +
      "The response carries `docs_indexed`: how many documents this caller " +
      "can see at all. When it is 0 the vault holds no documents yet — an " +
      "empty `hits` array then says nothing about whether the user has the " +
      "thing you are looking for, so do NOT report it as absent; fall back " +
      "to other lookups (recall, the filesystem) and say which surface you " +
      "actually searched.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language description of the document, e.g. " +
            "'OAuth flow architecture notes', 'Vertrag Muster Q3 2025'.",
        },
        k: {
          type: "number",
          description: "Max hits (1–5, default 3).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_document",
    annotations: { readOnlyHint: true, destructiveHint: false },
    description:
      "Load a document's metadata + extracted text by id (returned from " +
      "find_document). Use this before quoting or summarizing.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Document id (slug, no .md extension).",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "open_document",
    description:
      "Open a document in the system's default handler (macOS only). " +
      "Use only when the user explicitly says 'open', 'show me' or similar.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Document id (slug, no .md extension).",
        },
      },
      required: ["id"],
    },
  },
];

// ─── Handler implementations ─────────────────────────────────────

/**
 * Zählt die Documents, die DIESER Caller sehen darf. Spiegelt den
 * Sensitivity-Filter aus `findDocument`/`readDocument`, damit die Zahl nie
 * die Existenz privater Docs an externe MCP-Caller verrät.
 */
function visibleDocCount(vault: Vault, allowPrivate: boolean): number {
  let n = 0;
  for (const m of vault.list()) {
    if (m.fm.type !== "doc") continue;
    if (!allowPrivate && (m.fm as { sensitivity?: string }).sensitivity === "private") {
      continue;
    }
    n++;
  }
  return n;
}

/**
 * Filtert Recall-Hits auf type=doc und liefert die Top-k. SearchIndex
 * versteht den `type`-Filter bereits — wir delegieren komplett dahin.
 * Sensitivity (#58) wird über `allowPrivate` propagiert: externe MCP-Caller
 * sehen nur `team`+`public` Documents, die Mac-App ruft mit `true`.
 *
 * `docs_indexed` ist das Gegenstück zu `vault_size` bei `recall`: ohne die
 * Zahl ist `hits: []` auf einem NIE befüllten Doc-Vault nicht von „gesucht
 * und nichts gefunden" zu unterscheiden — der Caller liest die leere Liste
 * als Antwort über die Welt statt als Zustand des Index. Da die Tool-
 * Beschreibung Agents anweist, `find_document` VOR anderen Lookups zu
 * fragen, ist dieser stille Nullfall besonders teuer.
 */
export function findDocument(
  search: SearchIndex,
  vault: Vault,
  args: { query: string; k?: number },
  opts: { allowPrivate?: boolean } = {},
): { query: string; docs_indexed: number; hits: Array<unknown> } {
  const k = args.k ?? 3;
  const allowPrivate = opts.allowPrivate ?? false;
  const hits = search.recall(args.query, {
    k,
    type: "doc",
    allow_private: allowPrivate,
  });
  return {
    query: args.query,
    docs_indexed: visibleDocCount(vault, allowPrivate),
    hits,
  };
}

/**
 * Liefert das volle Sidecar inklusive Document-spezifischer Felder
 * (`original_path`, `document_category`, `folder_path`, `linked_file`).
 * `allowPrivate=false` (default) blendet `sensitivity: private` Documents
 * aus — verhindert Bypass des Sensitivity-Filters per direkter ID.
 */
export function readDocument(
  vault: Vault,
  args: { id: string },
  opts: { allowPrivate?: boolean } = {},
):
  | {
      id: string;
      title: string;
      summary: string;
      tags: string[];
      folder_path: string | null;
      document_category: string | null;
      original_path: string | null;
      linked_file: boolean;
      file_path: string;
      body: string;
    }
  | null {
  const m = vault.get(args.id);
  if (!m || m.fm.type !== "doc") return null;
  if (
    !opts.allowPrivate &&
    (m.fm as { sensitivity?: string }).sensitivity === "private"
  ) {
    return null;
  }
  const fm = m.fm as typeof m.fm & {
    original_path?: string;
    linked_file?: boolean;
    document_category?: string;
    folder_path?: string;
  };
  return {
    id: fm.id,
    title: fm.title,
    summary: fm.summary,
    tags: fm.tags,
    folder_path: fm.folder_path ?? null,
    document_category: fm.document_category ?? null,
    original_path: fm.original_path ?? null,
    linked_file: fm.linked_file ?? false,
    file_path: m.filePath,
    body: m.body,
  };
}

/**
 * Öffnet das Originalfile im System-Default-Handler. macOS-only — auf
 * anderen Plattformen liefern wir den Pfad zurück, ohne ihn zu starten.
 */
export async function openDocument(
  vault: Vault,
  args: { id: string },
  opts: { allowPrivate?: boolean; platform?: NodeJS.Platform } = {},
): Promise<
  | { ok: true; path: string }
  | { ok: false; path?: string; message: string }
> {
  const m = vault.get(args.id);
  if (!m || m.fm.type !== "doc") {
    return { ok: false, message: `document not found: ${args.id}` };
  }
  if (
    !opts.allowPrivate &&
    (m.fm as { sensitivity?: string }).sensitivity === "private"
  ) {
    return { ok: false, message: `document not found: ${args.id}` };
  }
  const fm = m.fm as typeof m.fm & { original_path?: string };
  const path = fm.original_path ?? m.filePath;
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      ok: false,
      path,
      message: platform === "win32"
        ? "open_document cannot launch originals on Windows yet — returning path. Windows document import/OCR has no supported backend yet (#85); search and read of already-extracted document text remain available. Open this path manually."
        : "open_document is only supported on macOS — returning path.",
    };
  }
  // #240/B11: the try/catch was dead code for the real failure mode — spawn
  // reports ENOENT ASYNCHRONOUSLY via an "error" event, so nothing was caught
  // and, with no listener, the event would take the process down. The call
  // also returned ok:true before `open` could possibly have succeeded, so a
  // missing file reported success. Await the outcome instead.
  if (!existsSync(path)) {
    return { ok: false, path, message: `file no longer exists at ${path}` };
  }
  return await new Promise((resolve) => {
    const child = spawn("open", [path], { stdio: "ignore" });
    child.on("error", (err) => {
      resolve({ ok: false, path, message: `failed to open: ${err.message}` });
    });
    child.on("exit", (code) => {
      resolve(
        code === 0
          ? { ok: true, path }
          : { ok: false, path, message: `open exited with code ${code}` },
      );
    });
  });
}
