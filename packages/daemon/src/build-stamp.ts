/**
 * The build stamp `dist/.build-revision` (#528) — written by
 * `scripts/write-build-revision.mjs` at the end of every package build, read
 * here by the two places that need to know WHICH sources produced a build:
 *
 *   - `cli/source-build.ts`, so `bastra update` compares the built revision
 *     against HEAD instead of comparing timestamps that prove nothing;
 *   - the health payload, so the revision a RUNNING daemon serves can be asked
 *     for rather than assumed from the disk it was started from.
 *
 * Format is `key=value` lines, not JSON: it is written by a build script and
 * read by a human as often as by this parser.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUILD_STAMP_FILE = ".build-revision";

export interface BuildStamp {
  /** Full commit sha the build was produced from. */
  revision: string;
  /** Did the tree carry uncommitted or untracked changes at build time? */
  dirty: boolean;
  /** ISO timestamp of the stamp, or null when the file predates the field. */
  builtAt: string | null;
}

/** Pure parse, so every malformed shape is testable without a build. */
export function parseBuildStamp(text: string): BuildStamp | null {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const revision = fields.get("revision");
  // A stamp without a revision carries nothing to verify against — treat it as
  // absent rather than as a half-answer a caller might trust.
  if (!revision) return null;
  return {
    revision,
    dirty: fields.get("dirty") === "true",
    builtAt: fields.get("built_at") ?? null,
  };
}

/** The stamp in `distDir`, or null when there is none (or it is unreadable). */
export function readBuildStamp(distDir: string): BuildStamp | null {
  try {
    return parseBuildStamp(readFileSync(join(distDir, BUILD_STAMP_FILE), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The stamp of the build THIS process runs from — this module compiles to
 * `dist/build-stamp.js`, so the stamp sits next to it. Null when running from
 * source via tsx: there is no build, hence no built revision to report.
 */
export function ownBuildStamp(): BuildStamp | null {
  return readBuildStamp(dirname(fileURLToPath(import.meta.url)));
}
