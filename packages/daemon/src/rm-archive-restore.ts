/**
 * `bastra archive restore <path|ref|sha>` (#650): puts back what the archiving
 * `rm` moved away, or runs the restore command a git snapshot recorded.
 *
 * Split out of `rm-archive.ts` so the archiving `rm` no longer imports the git
 * shim (git-archive.ts), which itself builds on the archiving `rm`: this
 * module sits above both.
 */
import { existsSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { restoreShape } from "./git-archive.js";
import { isPin, pinLive, restorePin } from "./git-archive-pins.js";
import { restoreCommands } from "./rm-archive.js";
import { manifestRows } from "./rm-archive-store.js";

export function restore(target: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  // A git snapshot, by its ref or sha: run the command the receipt named.
  const pinned = [...manifestRows(env)]
    .reverse()
    .find(
      (r) =>
        r.action === "pinned" &&
        r.restore &&
        (r.dest === target || (target.length >= 7 && (r.sha ?? "").startsWith(target)))
    );
  if (pinned?.restore) {
    const cmds = [pinned.restore, ...(pinned.then ?? [])];
    // Only what the shim records: the manifest is a plain file, and this runs it.
    if (!isPin(pinned.dest) || !cmds.every((c) => Array.isArray(c) && restoreShape(pinned.sha, c))) {
      throw new Error(`the manifest row of ${target} is not one bastra's git snapshots wrote — not run`);
    }
    if (!pinLive(pinned.orig, pinned.dest)) throw new Error(`${pinned.dest} is gone from ${pinned.orig}`);
    for (const cmd of cmds) restorePin(cmd);
    return `what \`${pinned.act}\` discarded in ${pinned.orig} (${restoreCommands(pinned).join(" && ")})`;
  }
  // The manifest keeps the path with its parent resolved (/var → /private/var
  // on macOS); a path as the user typed it is resolved the same way.
  const typed = resolve(cwd, target);
  let want = typed;
  try {
    want = join(realpathSync(dirname(typed)), basename(typed));
  } catch {
    /* the parent went with it: match as typed */
  }
  const hit = [...manifestRows(env)]
    .reverse()
    .find(
      (r) =>
        r.action === "archived" &&
        r.dest &&
        (r.orig === want || r.orig === typed || r.dest === want || r.dest === typed) &&
        existsSync(r.dest)
    );
  if (!hit || !hit.dest) throw new Error(`nothing live in the archive for ${want}`);
  if (existsSync(hit.orig)) throw new Error(`${hit.orig} exists — not overwriting; move it away and retry`);
  mkdirSync(dirname(hit.orig), { recursive: true });
  renameSync(hit.dest, hit.orig);
  return hit.orig;
}
