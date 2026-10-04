/**
 * Shared pieces of the folder import (#215, split out of `import-vault.ts` in
 * #680): the reserved import subtree, the public option/result shapes, and the
 * source-directory walk. Used by `importVault` and by the client-memory CLI;
 * `import-vault.ts` re-exports everything here, so importers stay unchanged.
 */
import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ImportVaultOrphan } from "./import/orphans.js";

/** Reserved subtree for all folder imports — its own graph cluster, and the
 *  atomic unit for delete/re-import. Never a target of the normal scope/type
 *  routing, so it can't overlap a hand-authored memory's path. */
export const IMPORT_ROOT = "memories/imported";

export interface ImportVaultOptions {
  /** Namespace label for this batch; defaults to the source dir's basename.
   *  Becomes the subfolder, the scope, and the id prefix. */
  label?: string;
  /** Re-import in place instead of erroring on an existing id (default true —
   *  a folder import is idempotent by design). */
  overwrite?: boolean;
  /** Map + count without writing anything (default false). */
  dryRun?: boolean;
  /** #220 (zzallirog): additional directory NAMES to skip anywhere in the
   *  tree (case-insensitive). Dotdirs, node_modules and `_archive`/`archive`
   *  are always skipped — retired notes must not compete with live ones for
   *  node identity. */
  exclude?: string[];
}

/** Always-skipped directory names (#220): archives hold retired copies of
 *  live notes — importing them mints `-2`/`-3` collision twins. */
const DEFAULT_EXCLUDED_DIRS = new Set(["_archive", "archive"]);

export interface ImportVaultSkip {
  path: string;
  reason: string;
}

export interface ImportVaultResult {
  sourceDir: string;
  label: string;
  folder: string;
  scope: string;
  scanned: number;
  imported: number;
  /** #312: every id in `ids` is counted in exactly ONE of these, so the
   *  breakdown always sums to `imported`. `index` is the synthetic
   *  curated-index node (#217) — it is a written memory like any other, but it
   *  comes from no source file and therefore from no adapter, which is why it
   *  used to fall out of the itemisation while still inflating the total.
   *  #365/7: counted is the import that LANDED, not the attempt. A dry-run and
   *  the real run therefore still predict the same numbers as long as no save
   *  fails; a failed write shows up in `skipped` and in no counter — deliberate,
   *  because the breakdown must keep summing to `imported`. */
  byAdapter: { claudeCode: number; generic: number; index: number };
  /** #530: Wie viel von `imported` wirklich geschrieben wurde. Ein identischer
   *  Re-Import meldete vorher erneut jede Datei als importiert, obwohl er
   *  nichts änderte. `created + updated + unchanged === imported`; im Dry-Run
   *  steht alles in `created`, weil ohne Write niemand sagen kann, was ein
   *  echter Lauf vorgefunden hätte. */
  written: { created: number; updated: number; unchanged: number };
  skipped: ImportVaultSkip[];
  /** #710: imported, but the adapter had to fix a field on the way in (a bare
   *  type word dropped from recall_when, an over-long entry cut). One entry
   *  per fix; the file still counts as imported. */
  warnings: ImportVaultSkip[];
  ids: string[];
  /** #217: id of the synthetic curated-index node minted from the source
   *  index (MEMORY.md / hubs), or null when the source carried no index.
   *  #312: a dry-run predicts this id too — it is resolved without writing. */
  indexNode: string | null;
  /** #240/A10: kept for shape compatibility, ALWAYS []. Weg C: the import
   *  never trashes a pre-A10 twin — automatic retirement could not be made
   *  loss-free (see the orchestrator). A pre-A10 duplicate stays active until
   *  the user, or a future opt-in `bastra migrate`, removes it with a
   *  confirmed delete. */
  migrated: Array<{ from: string; to: string }>;
  /** #530 follow-up: memories kept despite a vanished source file — never
   *  acted on, only reported (see {@link ImportVaultOrphan}). */
  orphaned: ImportVaultOrphan[];
  dryRun: boolean;
}

// ── directory walk ───────────────────────────────────────────────────────────

/** Recursively collect `*.md` files under `dir`, skipping dotdirs and
 *  node_modules (same policy as the vault loader) and the `MEMORY.md` pointer
 *  index (it's a table of contents, not a memory). Returns absolute paths. */
export async function listSourceMarkdown(dir: string, exclude: Set<string> = new Set()): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === "node_modules" || (e.name.startsWith(".") && e.name.length > 1)) continue;
      const full = join(current, e.name);
      if (e.isDirectory()) {
        const name = e.name.toLowerCase();
        if (DEFAULT_EXCLUDED_DIRS.has(name) || exclude.has(name)) continue;
        await walk(full);
      } else if (e.isFile() && extname(e.name).toLowerCase() === ".md" && e.name.toLowerCase() !== "memory.md") {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}
