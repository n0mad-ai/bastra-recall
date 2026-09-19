/**
 * The `applies_to` edge: memory → file or symbol (#578, §13 / 13.1, C-089).
 *
 * WHAT WAS ALREADY THERE. `affects_files` has been in the memory schema since
 * C-084 (`packages/core/src/schema.ts:197`) and the save path has been writing
 * it all along (`save-frontmatter.ts:68`, `save-schema.ts:144`,
 * `tool-defs-memory.ts:478`). Retrieval never read it. So a lesson that
 * declared the file it is about could not be found BY that file — the one
 * lookup the field exists for. This module is that lookup, and nothing else:
 * no schema change, no new field, no migration.
 *
 * WHAT A DECLARED EDGE IS WORTH. It is an author's statement, so it opens the
 * candidate path — it is not, by itself, evidence that the memory is relevant
 * to THIS call. §13.1 and C-089 hold a code hop back from ever producing
 * `required` on its own, and {@link bandOf} keeps that promise on both sides:
 *
 *   - A memory whose `affects_files` names the edited file is an exact-lane
 *     candidate. It reaches `required` only if the ordinary evidence gate
 *     (`evidence-decision.ts`) says so independently. The edge never lifts it.
 *   - A memory attached to a file that DEPENDS ON the edited file is a one-hop
 *     candidate and is capped at `optional`, always, whatever the gate says.
 *     One hop of blast radius is a reason to look, never a duty.
 *
 * `path#symbol` ENTRIES are allowed and validated against the code graph where
 * one exists. Where no graph is loaded the symbol half is simply carried along
 * unchecked — a cold cache must not turn a good entry into a complaint
 * (`cache.ts`, the cold-start rule).
 *
 * STALE ENTRIES ARE REPORTED, NOT REPAIRED. An entry pointing at a path that
 * is no longer on disk is listed by {@link unresolvedEntries} for
 * `bastra doctor`. It never breaks recall, and it is never silently rewritten;
 * where git can prove a rename, `rename-evidence.ts` turns it into an OFFER
 * (§10). Everything here works on repo-relative POSIX paths — resolving an
 * absolute tool path against a repository root belongs to `git-paths.ts`.
 */

import type { LoadedGraph } from "./reader.js";
import { dependentFilesOf, symbolsOfFile } from "./reader.js";

/** One parsed `affects_files` entry. */
export interface AppliesToRef {
  /** The entry exactly as the memory wrote it, for reporting and offers. */
  entry: string;
  /** Repo-relative POSIX path. */
  file: string;
  /** The `#symbol` half, or null when the entry names a whole file. */
  symbol: string | null;
}

/** The minimum a memory has to expose to take part. Keeps this module free of
 *  a dependency on the full `Memory` shape, so tests can state the input. */
export interface AppliesToMemory {
  id: string;
  /** Shown in the note so the agent sees what it is being offered. */
  title?: string;
  affects_files?: readonly string[];
}

export type CandidateHop = "direct" | "1-hop";

export interface AppliesToCandidate {
  memoryId: string;
  title?: string;
  entry: string;
  file: string;
  symbol: string | null;
  hop: CandidateHop;
  /** One-hop only: the dependent file that carries the memory. */
  via?: string;
}

/**
 * Parse one entry. Returns null for anything that is not a usable repo-relative
 * path — absolute paths, traversal, Windows drive letters, empty strings.
 * `affects_files` is user- and agent-written text, so it gets the same
 * treatment as any other external input (see `limits.ts`).
 */
export function parseAppliesTo(entry: string): AppliesToRef | null {
  const raw = entry.trim();
  if (raw.length === 0) return null;
  const hash = raw.indexOf("#");
  const pathPart = hash === -1 ? raw : raw.slice(0, hash);
  const symbolPart = hash === -1 ? "" : raw.slice(hash + 1).trim();
  const file = normalizePath(pathPart);
  if (file === null) return null;
  return { entry: raw, file, symbol: symbolPart.length > 0 ? symbolPart : null };
}

function normalizePath(p: string): string | null {
  let s = p.trim().replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  if (s.length === 0) return null;
  if (s.startsWith("/")) return null;
  // `~/Library/…` is a home path, not a repo path. Without this it survives
  // normalisation and is then reported as a missing FILE, which sends the
  // reader looking for it in the repository — measured on a real vault.
  if (s === "~" || s.startsWith("~/")) return null;
  if (/^[A-Za-z]:/.test(s)) return null;
  if (s.split("/").some((seg) => seg === "..")) return null;
  return s;
}

/**
 * File → the memories that declare it, built once per vault change instead of
 * scanning every memory on every Write/Edit. The lane runs against a 200 ms
 * p90 budget (`hook-budgets.ts`); a vault scan per keystroke-sized edit is not
 * a thing that fits into it.
 */
export class AppliesToIndex {
  private readonly byFile = new Map<string, AppliesToCandidate[]>();

  constructor(memories: Iterable<AppliesToMemory> = []) {
    for (const m of memories) this.add(m);
  }

  add(memory: AppliesToMemory): void {
    for (const entry of memory.affects_files ?? []) {
      const ref = parseAppliesTo(entry);
      if (ref === null) continue;
      const list = this.byFile.get(ref.file);
      const candidate: AppliesToCandidate = {
        memoryId: memory.id,
        ...(memory.title !== undefined ? { title: memory.title } : {}),
        entry: ref.entry,
        file: ref.file,
        symbol: ref.symbol,
        hop: "direct",
      };
      if (list === undefined) this.byFile.set(ref.file, [candidate]);
      else list.push(candidate);
    }
  }

  /** The memories that declare exactly this file. */
  directOn(file: string): AppliesToCandidate[] {
    const norm = normalizePath(file);
    return norm === null ? [] : (this.byFile.get(norm) ?? []).slice();
  }

  /** Every file any memory declares — the input to the unresolved check. */
  files(): string[] {
    return [...this.byFile.keys()].sort();
  }

  size(): number {
    return this.byFile.size;
  }
}

/**
 * The candidates for an edit of `file`: the memories declared on it, plus the
 * memories declared on files that depend on it (one hop, extracted edges only).
 *
 * `graph` may be null — a cold or absent graph costs the one-hop half and
 * nothing else. The direct half never needs a graph: it is what the author
 * wrote down.
 *
 * Deduplicated by memory id with the direct hop winning, so a memory declared
 * on both the edited file and a dependant is not offered twice and is not
 * demoted to `1-hop` by the second entry.
 */
export function appliesToCandidates(
  index: AppliesToIndex,
  file: string,
  graph: LoadedGraph | null,
): AppliesToCandidate[] {
  const norm = normalizePath(file);
  if (norm === null) return [];

  const out = new Map<string, AppliesToCandidate>();
  for (const c of index.directOn(norm)) {
    if (!out.has(c.memoryId)) out.set(c.memoryId, c);
  }
  if (graph !== null) {
    for (const dependent of dependentFilesOf(graph, norm)) {
      for (const c of index.directOn(dependent)) {
        if (out.has(c.memoryId)) continue;
        out.set(c.memoryId, { ...c, hop: "1-hop", via: dependent });
      }
    }
  }
  return [...out.values()];
}

/**
 * The band a candidate may be shown in.
 *
 * `gate` is the decision the ordinary evidence gate reached for this memory on
 * its own merits, or undefined when it was not evaluated. The rule is a CAP,
 * never a lift: this function can only ever lower what the gate decided.
 */
export function bandOf(
  candidate: AppliesToCandidate,
  gate?: "required" | "optional" | "no_answer",
): "required" | "optional" {
  if (candidate.hop === "1-hop") return "optional";
  return gate === "required" ? "required" : "optional";
}

/** Why an `affects_files` entry could not be resolved. */
export type UnresolvedReason =
  /**
   * An absolute path, a `~` home path, or traversal — never a repository path.
   *
   * Measured on a real vault: six of seventeen entries were system files a
   * human deliberately wrote down that way (`~/Library/LaunchAgents/…`,
   * `/Users/…/.bastra/…`). Those are not damaged entries and there is nothing
   * to repair about them, which is why this reason is named for what it is
   * rather than "malformed" — and why a report should count them, not list
   * them next to a file that genuinely went missing.
   */
  | "not-repo-relative"
  /** No such file in the repository right now. */
  | "file-missing"
  /** The file exists and the graph knows it, but not under that symbol name. */
  | "symbol-missing";

export interface UnresolvedEntry {
  memoryId: string;
  entry: string;
  file: string;
  symbol: string | null;
  reason: UnresolvedReason;
}

/**
 * The entries `bastra doctor` should show as unresolved.
 *
 * `exists` answers whether a repo-relative path is present in the working
 * tree; the caller supplies it so this stays pure and testable.
 *
 * A symbol is only ever reported as missing when a graph is loaded AND the
 * graph knows the file. Without a graph, or for a file the graph never
 * indexed, the symbol half is not checked — reporting a symbol as gone on the
 * strength of an index that does not cover it would be a guess, not a finding.
 */
export function unresolvedEntries(
  memories: Iterable<AppliesToMemory>,
  opts: { exists: (file: string) => boolean; graph?: LoadedGraph | null },
): UnresolvedEntry[] {
  const graph = opts.graph ?? null;
  const out: UnresolvedEntry[] = [];
  for (const m of memories) {
    for (const entry of m.affects_files ?? []) {
      const ref = parseAppliesTo(entry);
      if (ref === null) {
        out.push({
          memoryId: m.id,
          entry: entry.trim(),
          file: "",
          symbol: null,
          reason: "not-repo-relative",
        });
        continue;
      }
      if (!opts.exists(ref.file)) {
        out.push({ memoryId: m.id, ...ref, reason: "file-missing" });
        continue;
      }
      if (ref.symbol === null || graph === null) continue;
      const known = symbolsOfFile(graph, ref.file);
      if (known.length === 0) continue; // the graph does not cover this file
      const wanted = ref.symbol.toLowerCase();
      if (!known.some((s) => s.label.toLowerCase() === wanted)) {
        out.push({ memoryId: m.id, ...ref, reason: "symbol-missing" });
      }
    }
  }
  return out;
}

/** One line per unresolved entry, for the doctor report. */
export function formatUnresolved(entries: readonly UnresolvedEntry[]): string[] {
  return entries.map((e) => `${e.memoryId}: ${e.entry} — ${wordingOf(e.reason)}`);
}

function wordingOf(reason: UnresolvedReason): string {
  switch (reason) {
    case "not-repo-relative":
      return "not a repository path — nothing to resolve";
    case "file-missing":
      return "no such file in this repository";
    case "symbol-missing":
      return "file exists, symbol not found in the code graph";
  }
}

/**
 * What a save should PROPOSE as `affects_files`, from the files touched in the
 * session (Working Memory, §6.1).
 *
 * A proposal, deliberately: it is returned, never written. Nothing in this
 * module adds a path to an existing memory, and §10 is the reason — a memory
 * says what its author said, and a session's file list is a guess about what
 * the author meant.
 *
 * Already-declared entries are filtered out so a re-save proposes only what is
 * genuinely new, and the order of `touched` is preserved: the caller knows the
 * session, this function does not.
 */
export function suggestAffectsFiles(
  touched: readonly string[],
  existing: readonly string[] = [],
  limit = 10,
): string[] {
  const have = new Set<string>();
  for (const e of existing) {
    const ref = parseAppliesTo(e);
    if (ref !== null) have.add(ref.file);
  }
  const out: string[] = [];
  for (const t of touched) {
    const file = normalizePath(t);
    if (file === null || have.has(file)) continue;
    have.add(file);
    out.push(file);
    if (out.length >= limit) break;
  }
  return out;
}

// ─── The process-wide index ──────────────────────────────────────────────────

/**
 * The live vault, as this module needs to see it: a list of memories and a way
 * to hear that they changed. Deliberately structural — the daemon's `Vault`
 * satisfies it, and a test can satisfy it with four lines.
 */
export interface AppliesToVaultSource {
  list(): Array<{ fm: { id: string; title?: string; affects_files?: readonly string[] } }>;
  on(listener: () => void): () => void;
}

let bound: AppliesToVaultSource | null = null;
let unbind: (() => void) | null = null;
let cached: AppliesToIndex | null = null;

/**
 * Bind the index to the daemon's vault. Returns the unbind function.
 *
 * WHY A BINDING AND NOT A SCAN. The index has to be process-wide for the same
 * reason `codeGraphCache()` is: two copies of it would be two answers to the
 * same question, and the second one silently older. Building it from the vault
 * DIRECTORY would mean reading every memory file again inside a process that
 * already holds them parsed, and it would need a staleness heuristic on top —
 * a TTL or an mtime sweep — that can always serve a stale mapping for as long
 * as the window is open. The vault already emits add/change/remove, so the
 * index is invalidated by the event that caused it, not by a timer.
 *
 * THE LIMITATION, stated rather than hidden: until something calls this, there
 * is no index and {@link appliesToIndex} answers `null`. Every caller treats
 * that exactly like a cold graph — it emits nothing, silently. An unbound
 * process is therefore feature-less, never wrong.
 */
export function bindAppliesToVault(vault: AppliesToVaultSource): () => void {
  unbindAppliesToVault();
  bound = vault;
  cached = null;
  unbind = vault.on(() => {
    cached = null;
  });
  return unbindAppliesToVault;
}

/** Drop the binding and the index — on shutdown, and between tests. */
export function unbindAppliesToVault(): void {
  unbind?.();
  unbind = null;
  bound = null;
  cached = null;
}

/**
 * The index, or `null` when no vault is bound. Rebuilt on first use after an
 * invalidation; the build is a walk over the memories already in memory, so it
 * stays on the calling side rather than needing a background pass.
 */
export function appliesToIndex(): AppliesToIndex | null {
  if (bound === null) return null;
  if (cached === null) {
    cached = new AppliesToIndex(
      bound.list().map((m) => ({
        id: m.fm.id,
        ...(typeof m.fm.title === "string" ? { title: m.fm.title } : {}),
        affects_files: m.fm.affects_files,
      })),
    );
  }
  return cached;
}
