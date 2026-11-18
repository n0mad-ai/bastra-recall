/**
 * Where the local learned-recall bridge pool lives, and the one-time move of a
 * pool minted before #648 out of the Commons checkout. Backend code (boot, the
 * bridge, scheduled jobs) and the `bastra bridges` CLI both build on it (#1518).
 */
import { cpSync, existsSync, linkSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { bastraDataDir } from "../platform-paths.js";
import { commonsPath } from "../commons-store.js";
import { LAST_MINT_FILE } from "./mint-job.js";

/** #648: the local pool (`bridges/`, `last-mint.json`) is per-box state and
 *  lives in its own directory, not inside the git checkout of the shared
 *  Commons repo. Env override kept for tests/relocation. */
export function bridgesPath(): string {
  return process.env.BASTRA_BRIDGES_PATH ?? join(bastraDataDir(), "bridges");
}

/**
 * #648: one-time move of a pool minted before the split, from its old home
 * inside the Commons root to `bridgesPath()`. Copies, never deletes: the old
 * files stay where they were, so a downgrade still finds them. Idempotent — it
 * only runs while the new root has no `bridges/` yet, so a pool minted at the
 * new path is never overwritten. Returns what it copied (empty when nothing).
 */
export function migrateBridgesPool(
  io: { beforePublish?: (name: string) => void; afterPublished?: (name: string) => void } = {}
): string[] {
  const from = commonsPath();
  const to = bridgesPath();
  if (from === to || existsSync(join(to, "bridges"))) return [];
  const copied: string[] = [];
  // The bridge directory is the completion signal used above, so publish it
  // LAST. A crash after the first file still leaves the next run eligible to
  // finish the migration instead of silently skipping last-mint.json.
  for (const name of [LAST_MINT_FILE, "bridges"]) {
    const src = join(from, name);
    const dest = join(to, name);
    if (!existsSync(src) || existsSync(dest)) continue;
    // Staged, then renamed: a copy that stops midway must not leave a partial
    // `bridges/` that the idempotence check above would take for a finished one.
    const staging = `${dest}.migrating-${process.pid}-${randomUUID()}`;
    mkdirSync(to, { recursive: true });
    try {
      cpSync(src, staging, { recursive: true });
      io.beforePublish?.(name);
      try {
        if (name === LAST_MINT_FILE) linkSync(staging, dest);
        else renameSync(staging, dest);
        copied.push(name);
        io.afterPublished?.(name);
      } catch (err) {
        // Another daemon, CLI or bridge startup may have published the same
        // destination while this copy was staged. Never replace its pool.
        if (!["EEXIST", "ENOTEMPTY"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return ["bridges", LAST_MINT_FILE].filter((name) => copied.includes(name));
}
