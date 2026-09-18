/**
 * Which repositories have code awareness turned on (#574).
 *
 * Recall builds a code graph ONLY for repositories the user enabled, never for
 * every directory it happens to see. A graph costs ~11 s to build, ~10 MB on
 * disk and ~20 MB of heap per repository, so "index whatever is open" is not a
 * defensible default — and it would also mean Recall writing into checkouts
 * nobody asked it to touch.
 *
 * The list lives in the global `~/.bastra/cli-settings.json`, not in a file
 * inside the repository. A config file in the repo would be an artifact that
 * shows up in other people's checkouts and can be committed by accident;
 * enabling is a decision of this machine, not of the project.
 *
 * Kept out of `settings.ts` on purpose: that file is already past the 800-line
 * ceiling the size convention sets, and this is a coherent responsibility of
 * its own rather than another entry in a grab bag. `settings.ts` keeps the
 * `code` field in `CliSettings`, because that is where the schema lives.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { mutateSettings, readSettings, settingsFilePath } from "../settings.js";
import { platformSupported } from "./graphify-tool.js";

/**
 * The env kill switch. Checked everywhere the feature could do work, and
 * deliberately the SAME variable the Write/Edit block uses, so one setting
 * turns the whole feature off rather than half of it.
 */
export function codeAwarenessDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.BASTRA_CODE_AWARENESS ?? "").toLowerCase() === "off";
}

/**
 * One repository path in the canonical form the list stores: absolute and
 * normalized. Not `realpath`ed — that would resolve symlinks and make an
 * enabled path stop matching the `cwd` a hook reports through a symlinked
 * checkout, which is a common macOS setup.
 */
export function canonicalRepoPath(repoRoot: string): string {
  return resolve(repoRoot);
}

/**
 * Every enabled repository, or an empty list. Empty is the normal state, not
 * an error: nothing is enabled until someone says so.
 *
 * Returns nothing at all when the platform is out of scope (C-094) or the kill
 * switch is set, so callers cannot accidentally act on a list the feature is
 * not allowed to use.
 */
export async function enabledRepos(
  path: string = settingsFilePath(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  if (codeAwarenessDisabledByEnv(env) || !platformSupported(platform)) return [];
  const raw = (await readSettings(path)).code?.repos;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim().length === 0) continue;
    seen.add(canonicalRepoPath(entry));
  }
  return [...seen];
}

/**
 * The enabled list for the hot paths, synchronously (#585).
 *
 * Every reader of a graph — the cache behind `find_code`, both Write/Edit
 * blocks, the refresher — asks this before it serves or builds anything.
 * Before, only the daemon's START read the list: `bastra code disable` and
 * `BASTRA_CODE_AWARENESS=off` changed nothing in a running daemon, and after a
 * restart any caller could still load the graph left on disk. A switch that
 * does not switch is worse than none, because the user believes it.
 *
 * Synchronous because `CodeGraphCache.get()` is, by the cold-start rule. The
 * cost is one `stat` per call; the file is re-read only when its mtime or size
 * moved. Unreadable or corrupt settings mean "nothing enabled" — the feature
 * fails closed, never open.
 */
export function isRepoEnabledSync(
  repoRoot: string,
  path: string = settingsFilePath(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (codeAwarenessDisabledByEnv(env) || !platformSupported(platform)) return false;
  return enabledSnapshot(path).has(canonicalRepoPath(repoRoot));
}

let snapshot: { path: string; mtimeMs: number; size: number; repos: Set<string> } | null = null;

function enabledSnapshot(path: string): Set<string> {
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(path);
  } catch {
    snapshot = null;
    return new Set();
  }
  if (snapshot?.path === path && snapshot.mtimeMs === st.mtimeMs && snapshot.size === st.size) {
    return snapshot.repos;
  }
  const repos = new Set<string>();
  try {
    const raw = (JSON.parse(readFileSync(path, "utf8")) as { code?: { repos?: unknown } }).code?.repos;
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (typeof entry === "string" && entry.trim().length > 0) repos.add(canonicalRepoPath(entry.trim()));
      }
    }
  } catch {
    // Corrupt settings: nothing is enabled. `readSettings` reports the
    // corruption loudly; this path only has to not act on it.
  }
  snapshot = { path, mtimeMs: st.mtimeMs, size: st.size, repos };
  return repos;
}

/** Is this repository enabled? */
export async function isRepoEnabled(
  repoRoot: string,
  path: string = settingsFilePath(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  return (await enabledRepos(path, env, platform)).includes(canonicalRepoPath(repoRoot));
}

/**
 * Turn code awareness on or off for one repository.
 *
 * Goes through `mutateSettings`, the single settings transaction from #534 —
 * a setter that reads and writes on its own brings back the race where two
 * mutations of different fields overwrite each other.
 *
 * Returns whether anything changed, so a CLI can say "already enabled"
 * instead of implying it did something.
 *
 * Disabling only removes the entry. It stops all background work and leaves
 * `graphify-out/` exactly where it is: deleting files as a side effect of a
 * settings change is not something a user asked for, and re-enabling would
 * otherwise cost a full rebuild. Removing the files is its own named action.
 */
export async function setRepoEnabled(
  repoRoot: string,
  on: boolean,
  path: string = settingsFilePath(),
): Promise<boolean> {
  const target = canonicalRepoPath(repoRoot);
  let changed = false;
  await mutateSettings(path, (current) => {
    const existing = Array.isArray(current.code?.repos)
      ? current.code!.repos!.filter((e): e is string => typeof e === "string").map(canonicalRepoPath)
      : [];
    const unique = [...new Set(existing)];
    const has = unique.includes(target);
    if (has === on) return null; // nothing to do — do not rewrite the file
    changed = true;
    const next = on ? [...unique, target] : unique.filter((e) => e !== target);
    return { ...current, code: { ...current.code, repos: next } };
  });
  return changed;
}
