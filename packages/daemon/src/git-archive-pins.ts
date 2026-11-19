/**
 * The refs bastra's git snapshots pin under `refs/bastra-archive/` (#650):
 * what counts as one, whether it is still there, letting it go, and the
 * restore command a receipt shows and `bastra archive restore` runs. The git
 * shim (git-archive.ts), the archive restore and reconcile build on this; it
 * imports none of them.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Our own git calls: fsmonitor off, hooks pointed at /dev/null, diffs not relative. */
export const SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.relative=false"];

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The restore command of a pinned row, for the receipt (shell-quoted). */
export function restoreCommand(args: string[]): string {
  return `git ${args.map((a) => (/^[\w@%+=:,./{}^-]+$/.test(a) ? a : shq(a))).join(" ")}`;
}

/** A ref the shim made. The manifest is a plain file: a torn or foreign line
 *  must not aim `update-ref -d` at a branch. */
export function isPin(ref: string | undefined): ref is string {
  return typeof ref === "string" && /^refs\/bastra-archive\/[^\s~^:?*[\\]+$/.test(ref) && !ref.includes("..");
}

/** Whether a pinned ref still exists (reconcile only lets live ones go). */
export function pinLive(repo: string, ref: string): boolean {
  if (!isPin(ref) || !existsSync(repo)) return false;
  try {
    execFileSync("git", [...SAFE, "-C", repo, "rev-parse", "--verify", "-q", ref], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function unpin(repo: string, ref: string, sha: string): void {
  if (!isPin(ref)) return;
  try {
    execFileSync("git", [...SAFE, "-C", repo, "update-ref", "-d", ref, sha], { stdio: "ignore" });
  } catch {
    /* already gone, or moved: leave it */
  }
}

/** `bastra archive restore <ref|sha>` for a pinned row: runs its restore command. */
export function restorePin(args: string[]): void {
  execFileSync("git", args, { stdio: "inherit" });
}
