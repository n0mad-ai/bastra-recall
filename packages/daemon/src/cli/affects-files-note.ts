/**
 * The `affects_files` note in `bastra doctor` (#578) — the fifth global check.
 *
 * WHY THIS IS A NOTE AND NOT A FAILURE. A memory that points at a path which
 * has since moved or vanished is not a broken installation; it is a true
 * statement about a file that is no longer where the author left it. Recall
 * keeps working — the entry simply resolves to nothing (`applies-to.ts`), and
 * the whole point of #578 is that this state is SAID OUT LOUD instead of
 * silently doing nothing. So, like the four notes next to it, this one never
 * touches doctor's exit code and never throws.
 *
 * WHAT IT MAY CLAIM. Where git proves a rename, the new path is OFFERED —
 * the line says "offered, not applied", and nothing here writes to a memory
 * (§10). Where git proves nothing, the entry is reported as unresolved and
 * stays that way. Outside a git repository the check says it cannot look
 * rather than reporting a clean bill: a diagnostic that goes quiet exactly
 * where it is blind is the problem it is supposed to catch
 * (`stub-freshness.ts` makes the same argument for `unknown-sources`).
 *
 * ONE git walk, not one per memory: the range is anchored at the OLDEST
 * `updated` among the memories that actually have an unresolved entry, and
 * every offer is resolved out of that single lookup.
 *
 * A DIAGNOSIS, NOT A REPORT. Measured on a real vault: 17 unresolved entries,
 * six of which were deliberate absolute paths to system files. So two rules
 * shape the output. Only the first {@link MAX_LISTED} findings are listed and
 * the rest becomes one count — a diagnostic that grows with the vault stops
 * being read. And an entry that was never a repository path is COUNTED, never
 * listed: nothing about it can be repaired, and six such lines are exactly
 * what buries the one file that really did go missing. `file-missing` is the
 * category that matters, because it is the only one a rename can explain.
 *
 * ONLY THIS REPOSITORY'S MEMORIES. `affects_files` holds REPO-RELATIVE paths,
 * and one vault serves every project on the machine. Measured on a real vault:
 * checking all of them against the current checkout reported dozens of paths
 * from other repositories as "no such file" — every one of them a true path in
 * the project it belongs to. So a memory is only checked when its `scope`
 * positively names this project (or a family member of it, `scope.ts`).
 * Memories with no scope, or with a global one, are not about this checkout
 * and are left alone.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { GLOBAL_SCOPES, isScopeCompatible, normalizeScopeKey, Vault } from "@bastra-recall/core";
import {
  formatUnresolved,
  unresolvedEntries,
  type AppliesToMemory,
  type UnresolvedEntry,
} from "../code-graph/applies-to.js";
import { repoRootOf } from "../code-graph/git-paths.js";
import { commitBefore, formatOffers, renameOffers, renamesSince } from "../code-graph/rename-evidence.js";
import { loadGraph, type LoadedGraph } from "../code-graph/reader.js";
import { isRepoEnabledSync } from "../code-graph/enabled-repos.js";
import { projectForFilter } from "../scope-filter.js";

/** Findings listed by name before the rest becomes a count. */
const MAX_LISTED = 5;

/** Everything the note needs from the outside, injectable for tests. */
export interface AffectsFilesIo {
  /** The memories to check — `{ id, affects_files, updated, scope }`. */
  memories: () => Promise<Array<AppliesToMemory & { updated?: string; scope?: string }>>;
  /** The repository the paths are relative to, or null when there is none. */
  repoRoot: () => Promise<string | null>;
  /** Does this repo-relative path exist in the working tree? */
  exists: (repoRoot: string, file: string) => boolean;
  /** The project name this checkout is known under, or null when it cannot be
   *  established with confidence — then nothing is checked, because every path
   *  would be measured against the wrong repository. */
  project: (repoRoot: string) => string | null;
  /**
   * The code graph to check `file.ts#symbol` entries against, loaded and
   * awaited. Omitted → symbols are not checked, only files.
   */
  graph?: (repoRoot: string) => Promise<LoadedGraph | null>;
}

/**
 * The lines the note prints, or an empty array when there is nothing to say.
 * Pure apart from `io`, so the wording is testable without a vault, a repo or
 * a daemon.
 */
export async function affectsFilesLines(io: AffectsFilesIo): Promise<string[]> {
  const memories = await io.memories();
  const withEntries = memories.filter((m) => (m.affects_files ?? []).length > 0);
  if (withEntries.length === 0) return [];

  const repoRoot = await io.repoRoot();
  if (repoRoot === null) {
    // Honest blindness, not silence: the entries exist and could not be checked.
    const count = withEntries.reduce((n, m) => n + (m.affects_files ?? []).length, 0);
    return [
      `${count} entr${count === 1 ? "y" : "ies"} in ${withEntries.length} memor${withEntries.length === 1 ? "y" : "ies"} — not checked here (no git repository at this location)`,
    ];
  }

  const project = io.project(repoRoot);
  const declared = withEntries.filter((m) => belongsToProject(m.scope, project));
  if (declared.length === 0) return [];

  // Awaited, unlike a hook (#587): the cache's non-blocking `get()` answers
  // null on its first call, and a short-lived CLI never gets a second one —
  // so every symbol anchor used to be checked for its file only.
  const graph = io.graph !== undefined ? await io.graph(repoRoot).catch(() => null) : null;
  const unresolved = unresolvedEntries(declared, {
    exists: (file) => io.exists(repoRoot, file),
    graph,
  });
  if (unresolved.length === 0) return [];

  // Never a repository path in the first place: counted, not listed.
  const notRepoPaths = unresolved.filter((u) => u.reason === "not-repo-relative");
  const findings = unresolved.filter((u) => u.reason !== "not-repo-relative");

  const offers = await offersFor(repoRoot, findings, declared);
  // An entry that got an offer is not ALSO listed as unresolved: the offer
  // already says what is wrong and what to do about it.
  const key = (memoryId: string, entry: string): string => JSON.stringify([memoryId, entry]);
  const offered = new Set(offers.map((o) => key(o.memoryId, o.entry)));
  const stillUnresolved = findings.filter((u) => !offered.has(key(u.memoryId, u.entry)));

  // Offers first: they are the ones with something to do about them.
  const lines = capped([...formatOffers(offers), ...formatUnresolved(stillUnresolved)]);
  // Only ever an aside next to a real finding. On its own it would be a note
  // about entries that are exactly as their author meant them.
  if (lines.length > 0 && notRepoPaths.length > 0) {
    const n = notRepoPaths.length;
    lines.push(
      `${n} further entr${n === 1 ? "y names an absolute or home path" : "ies name absolute or home paths"} — not repository paths, nothing to resolve`,
    );
  }
  return lines;
}

/**
 * Does this memory belong to the checkout being examined? A missing scope and
 * a global one both mean "not specifically this project" — and a repo-relative
 * path only means anything inside the project it was written in.
 */
function belongsToProject(scope: string | undefined, project: string | null): boolean {
  if (project === null || scope === undefined || scope.length === 0) return false;
  if (GLOBAL_SCOPES.has(normalizeScopeKey(scope))) return false;
  return isScopeCompatible(scope, project);
}

/** The first {@link MAX_LISTED} lines, then one line counting the rest. */
function capped(lines: string[]): string[] {
  if (lines.length <= MAX_LISTED) return lines;
  const rest = lines.length - MAX_LISTED;
  return [...lines.slice(0, MAX_LISTED), `… and ${rest} more`];
}

async function offersFor(
  repoRoot: string,
  unresolved: readonly UnresolvedEntry[],
  memories: ReadonlyArray<AppliesToMemory & { updated?: string }>,
): Promise<ReturnType<typeof renameOffers>> {
  const affected = new Set(unresolved.map((u) => u.memoryId));
  const dates = memories
    .filter((m) => affected.has(m.id))
    .map((m) => m.updated)
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .sort();
  const since = dates.length > 0 ? await commitBefore(repoRoot, dates[0]!) : null;
  return renameOffers(unresolved, await renamesSince(repoRoot, since));
}

/** The default io: the configured vault, the repository around the cwd. */
export function defaultAffectsFilesIo(vaultPath: string): AffectsFilesIo {
  return {
    memories: async () => {
      const vault = new Vault(vaultPath);
      await vault.init();
      return vault.list().map((m) => ({
        id: m.fm.id,
        affects_files: m.fm.affects_files,
        updated: m.fm.updated,
        scope: m.fm.scope,
      }));
    },
    repoRoot: () => repoRootOf(process.cwd()),
    exists: (repoRoot, file) => existsSync(isAbsolute(file) ? file : join(repoRoot, file)),
    project: (repoRoot) => projectForFilter(repoRoot),
    // Only for an enabled repository: a disabled one has switched code
    // awareness off, graph on disk or not (#585).
    graph: async (repoRoot) => {
      if (!isRepoEnabledSync(repoRoot)) return null;
      const result = await loadGraph(repoRoot);
      return result.ok ? result.graph : null;
    },
  };
}
