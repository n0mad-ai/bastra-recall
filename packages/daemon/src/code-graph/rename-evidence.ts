/**
 * Renames, from git evidence or not at all (#578).
 *
 * THE CORRECTION THIS MODULE EXISTS FOR. The original plan for #578 said: when
 * the code graph shows that a file moved, offer to update the memory that
 * points at the old path. The pre-build counter-review measured the graph and
 * found the premise wrong — Graphify's `graph.json` has FIFTEEN relation types
 * and NONE of them is `rename` or `move` (the measured census lives in
 * `limits.ts`). The graph is a snapshot of one commit; it cannot say that
 * anything moved, because it has no previous state to compare against.
 *
 * So the evidence is git's, or there is none:
 *
 *   git diff-tree -M -r --name-status <commit>
 *
 * with git's own similarity threshold. A rename is NEVER inferred from similar
 * symbol sets, from similar paths, or from a file disappearing in the graph
 * while a similar one appears. Those three all look like a rename and are
 * equally often a deletion next to an unrelated addition, and a memory
 * repointed at the wrong file is worse than a memory that admits it is stale.
 *
 * PER COMMIT, NOT PER RANGE, and this is the whole difference. `git diff A..B`
 * pairs a file deleted early in the range with a similar file added later and
 * reports it as one rename — the two events never happened together, but the
 * range diff cannot tell. Walking the range one commit at a time keeps the
 * pairing inside the commit where the author actually made it: a `git mv` in
 * one commit is a rename, a delete in one commit and an add in the next is two
 * separate facts. Renames are then chained across commits (a→b, later b→c
 * yields a→c), so a path that moved twice still resolves to where it is now.
 *
 * NOTHING HERE WRITES. The result is an OFFER (§10): Recall shows the new path
 * and the author decides. Outside a git repository, or where git reports no
 * rename, the stale entry stays unresolved and is reported as such in
 * `bastra doctor` (`applies-to.ts`). That is the honest state, not a failure.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { UnresolvedEntry } from "./applies-to.js";
import { isGitRepo } from "./git-paths.js";

const run = promisify(execFile);

/** Git may not be installed, the repo may be huge, and this may run near a
 *  hook budget. Every call is bounded on all three axes. Tighter than
 *  `git-paths.ts`'s 5 s on purpose: this walks a range, so the bound is per
 *  commit and a slow repository must not multiply it into seconds. */
const RENAME_GIT_TIMEOUT_MS = 3_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
/** Commits walked at most. A memory older than this many commits gets no
 *  offer rather than a multi-second walk — unresolved is a valid answer. */
export const MAX_COMMITS_WALKED = 500;

/** One rename git actually reported, in one commit. */
export interface RenameEvidence {
  /** Repo-relative POSIX path before the move. */
  from: string;
  /** Repo-relative POSIX path after the move. */
  to: string;
  /** Git's own similarity score in percent (the `R095` half), or null when
   *  git did not attach one. Reported, never re-thresholded here. */
  similarity: number | null;
  /** The commit that carried the rename. */
  commit: string;
}

export type RenameLookup =
  | { available: true; renames: RenameEvidence[] }
  | { available: false; reason: "not-a-repo" | "git-unavailable" | "bad-range" };

export interface RenameOffer {
  memoryId: string;
  /** The entry as the memory has it today. */
  entry: string;
  from: string;
  to: string;
  /** What the entry would become, `#symbol` preserved. Offered, not applied. */
  suggestedEntry: string;
  similarity: number | null;
  commit: string;
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repoRoot, ...args], {
    timeout: RENAME_GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout;
}

/**
 * The last commit at or before `iso` — the anchor for "since this memory was
 * last updated". Null when the repository has no such commit, which simply
 * means there is nothing to look back over.
 */
export async function commitBefore(repoRoot: string, iso: string): Promise<string | null> {
  try {
    const out = (await git(repoRoot, ["rev-list", "-n", "1", `--before=${iso}`, "HEAD"])).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Every rename git reports between `since` (exclusive) and HEAD, one commit at
 * a time. `since` may be any revision git accepts; pass null to walk the whole
 * history up to {@link MAX_COMMITS_WALKED}.
 */
export async function renamesSince(repoRoot: string, since: string | null): Promise<RenameLookup> {
  if (!(await isGitRepo(repoRoot))) return { available: false, reason: "not-a-repo" };

  let commits: string[];
  try {
    const range = since === null ? "HEAD" : `${since}..HEAD`;
    const out = await git(repoRoot, ["rev-list", "--reverse", `--max-count=${MAX_COMMITS_WALKED}`, range]);
    commits = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    // A revision git does not know is a bad range, not a broken git: the
    // caller asked about a commit that is not in this repository.
    return { available: false, reason: "bad-range" };
  }

  const renames: RenameEvidence[] = [];
  for (const commit of commits) {
    try {
      const out = await git(repoRoot, [
        "diff-tree",
        "-M",
        "-r",
        "--no-commit-id",
        "--name-status",
        "--root",
        commit,
      ]);
      renames.push(...parseNameStatus(out, commit));
    } catch {
      return { available: false, reason: "git-unavailable" };
    }
  }
  return { available: true, renames };
}

/**
 * Parse `--name-status` output. Only `R` lines are read; `A`, `D` and `M` are
 * deliberately ignored — an add next to a delete is exactly the pair this
 * module refuses to call a rename.
 */
export function parseNameStatus(stdout: string, commit: string): RenameEvidence[] {
  const out: RenameEvidence[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (!status.startsWith("R") || parts.length < 3) continue;
    const from = parts[1]?.trim() ?? "";
    const to = parts[2]?.trim() ?? "";
    if (from.length === 0 || to.length === 0) continue;
    const score = Number.parseInt(status.slice(1), 10);
    out.push({ from, to, similarity: Number.isFinite(score) ? score : null, commit });
  }
  return out;
}

/**
 * Where a path ended up, following renames in order. Null when git reported no
 * rename starting at that path, or when the chain leads back to itself (a
 * rename cycle inside the range — possible, and not something to offer).
 */
export function resolvePath(
  path: string,
  renames: readonly RenameEvidence[],
): { to: string; similarity: number | null; commit: string } | null {
  let current = path;
  let last: { to: string; similarity: number | null; commit: string } | null = null;
  const seen = new Set<string>([current]);
  for (const r of renames) {
    if (r.from !== current) continue;
    if (seen.has(r.to)) return null;
    seen.add(r.to);
    current = r.to;
    last = { to: r.to, similarity: r.similarity, commit: r.commit };
  }
  return last;
}

/**
 * Turn unresolved `affects_files` entries into rename offers, where — and only
 * where — git proved the move. Entries without git evidence are not in the
 * result; they stay unresolved and stay in the doctor report.
 *
 * `malformed` and `symbol-missing` entries are never offered: the first is not
 * a path git could have moved, and the second names a file that is still
 * there, so a rename is not what happened to it.
 */
export function renameOffers(
  unresolved: readonly UnresolvedEntry[],
  lookup: RenameLookup,
): RenameOffer[] {
  if (!lookup.available) return [];
  const out: RenameOffer[] = [];
  for (const u of unresolved) {
    if (u.reason !== "file-missing") continue;
    const hit = resolvePath(u.file, lookup.renames);
    if (hit === null) continue;
    out.push({
      memoryId: u.memoryId,
      entry: u.entry,
      from: u.file,
      to: hit.to,
      suggestedEntry: u.symbol === null ? hit.to : `${hit.to}#${u.symbol}`,
      similarity: hit.similarity,
      commit: hit.commit,
    });
  }
  return out;
}

/** One line per offer, for the doctor report and the save-time prompt. */
export function formatOffers(offers: readonly RenameOffer[]): string[] {
  return offers.map((o) => {
    const sim = o.similarity === null ? "" : ` (git: ${o.similarity}% similar)`;
    return `${o.memoryId}: ${o.entry} → ${o.suggestedEntry}${sim} — offered, not applied`;
  });
}
