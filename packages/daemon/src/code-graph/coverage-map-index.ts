/** Bind a cached coverage map's trust verdict to the worktree's Git index. */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { repoRootSync } from "./git-paths.js";

const paths = new Map<string, { marker: string; index: string }>();

function stamp(path: string): string | null {
  try {
    const s = statSync(path);
    return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : null;
  }
}

/** No Git process on a cache hit. Git resolves the index (including linked
 * worktrees and submodules); a changed .git marker resolves it afresh. Null
 * means the reader must not reuse a snapshot. */
export function coverageIndexStamp(repoRoot: string): string | null {
  const root = repoRootSync(repoRoot);
  if (root === null) return null;
  const marker = stamp(join(root, ".git"));
  if (marker === null || marker === "absent") return null;
  let cached = paths.get(repoRoot);
  if (!cached || cached.marker !== marker) {
    const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "--git-path", "index"], {
      stdio: ["ignore", "pipe", "ignore"], timeout: 1_000, encoding: "utf8",
    });
    if (result.error || result.signal !== null || result.status !== 0 || !result.stdout?.trim()) return null;
    cached = { marker, index: resolve(repoRoot, result.stdout.trim()) };
    paths.delete(repoRoot);
    if (paths.size >= 8) paths.delete(paths.keys().next().value!);
    paths.set(repoRoot, cached);
  }
  const index = stamp(cached.index);
  return index === null ? null : `${marker}|${cached.index}|${index}`;
}
