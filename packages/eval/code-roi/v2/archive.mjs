/**
 * Where a run writes, and the one directory it may never write to (#582).
 *
 * `~/.bastra/eval/code-roi-v2` holds the completed v3 measurement: its frozen
 * scenario file, the 88 transcripts its report was scored from, and the truth
 * sets that were adjudicated by hand. That report is only reproducible while
 * every one of those files is exactly as it was, and the v4 scripts share
 * their filenames with it — one forgotten `CODE_ROI_OUT` would overwrite
 * `scenarios.json` and take the record with it.
 *
 * So the guard is a hard check in code, not a line in a README: every v4
 * script calls `writableOut()` and gets a directory or an exception.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

/** The completed v3 archive. Read freely, never written. */
export const FROZEN_ARCHIVES = [resolve(homedir(), ".bastra", "eval", "code-roi-v2")];

/** True when `dir` is a frozen archive or lies inside one. */
export function isFrozen(dir) {
  const target = resolve(dir);
  return FROZEN_ARCHIVES.some((frozen) => target === frozen || target.startsWith(`${frozen}/`));
}

/**
 * The output directory for a v4 script: `CODE_ROI_OUT`, or `fallback`.
 * Throws rather than writing into a frozen archive.
 */
export function writableOut(fallback = resolve(homedir(), ".bastra", "eval", "code-roi-v4")) {
  const out = resolve(process.env.CODE_ROI_OUT ?? fallback);
  if (isFrozen(out)) {
    throw new Error(
      `refusing to write into the frozen v3 archive at ${out}. ` +
        `Set CODE_ROI_OUT to a fresh directory — the v3 report is only ` +
        `reproducible while that archive is untouched.`,
    );
  }
  return out;
}
