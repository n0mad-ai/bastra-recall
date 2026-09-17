/**
 * Recall's own manifest next to the code graph (#574).
 *
 * The plan assumed `graph.json` could answer "is this graph current". Measured
 * on the real file, it cannot: `graph` is `{}`, there is no schema version and
 * no build timestamp. It does carry a top-level `built_at_commit`, but a
 * commit is not a build time and the field is absent outside a git repo.
 *
 * Graphify writes its own `graphify-out/manifest.json` — a per-file build
 * cache of mtime and content hashes, which is what makes `extract` incremental
 * (182 KB on this repo). That file is an internal format of a third-party tool
 * with no stability guarantee, so Recall reads it at most as a hint, never
 * depends on it, and never writes to it.
 *
 * Hence a Recall-owned manifest, deliberately NOT called `manifest.json` —
 * that name is taken, and two tools writing one file is how a build cache gets
 * corrupted.
 *
 * The `dirty` flag is the reason this lives on disk rather than in memory: a
 * daemon restart loses the in-flight single-flight queue, and the counter-review
 * named that as the gap where a repository silently keeps a half-built graph.
 * Startup reconciliation (#581) reads this flag and re-enqueues.
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

/** Recall's manifest file, inside the graph directory. */
export const MANIFEST_NAME = ".bastra-manifest.json";

/** Graphify's own build cache — read-only for us, and never written. */
export const GRAPHIFY_MANIFEST_NAME = "manifest.json";

export interface CodeGraphManifest {
  /** Version the pinned Graphify binary reported when this graph was built. */
  graphifyVersion: string;
  /** COMPLETION time of the build, ISO. Not its start: a start time would
   *  make a build that crashed halfway look newer than the files it missed. */
  builtAt: string | null;
  /** `git rev-parse HEAD` at build time, or null outside a git repo. */
  commit: string | null;
  /** Absolute path of the repository this graph describes. */
  repoRoot: string;
  /** Exactly what was run, so a stale graph can be explained, not guessed. */
  command: string;
  /** File state at build time, for the staleness comparison in #577. */
  fileState: { count: number; newestMtimeMs: number };
  /** The last failed build, or null. Survives restarts on purpose. */
  lastError: string | null;
  /** Set before a build starts, cleared only on success. On-disk so that a
   *  killed daemon still reports an incomplete graph after a restart. */
  dirty: boolean;
}

export function manifestPath(graphDir: string): string {
  return join(graphDir, MANIFEST_NAME);
}

/**
 * The manifest, or null when it is missing or unusable. A missing manifest is
 * NOT "the graph is fine, we just lost the note": the reader treats it as code
 * awareness unavailable, because nothing else can establish that the graph
 * finished building.
 */
export async function readManifest(graphDir: string): Promise<CodeGraphManifest | null> {
  try {
    const raw = await readFile(manifestPath(graphDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write the manifest atomically (temp file + rename), following the #104
 * lesson: a partially written manifest would claim a state that never existed,
 * and it is the one file the staleness decision rests on.
 */
export async function writeManifest(graphDir: string, m: CodeGraphManifest): Promise<void> {
  const target = manifestPath(graphDir);
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(m, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

/**
 * True when the graph cannot be trusted as current: no manifest, a build that
 * never completed, or a file touched after the build finished. Deliberately
 * conservative — "unknown" counts as stale, since the cost of a stale marker
 * is a line of wording and the cost of a wrong "current" is an agent acting on
 * a dependency list that no longer holds.
 */
export function isStale(m: CodeGraphManifest | null, newestMtimeMs: number): boolean {
  if (m === null) return true;
  if (m.dirty) return true;
  if (m.builtAt === null) return true;
  const builtMs = Date.parse(m.builtAt);
  if (!Number.isFinite(builtMs)) return true;
  return newestMtimeMs > builtMs;
}

function isManifest(v: unknown): v is CodeGraphManifest {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.graphifyVersion === "string" &&
    (typeof m.builtAt === "string" || m.builtAt === null) &&
    (typeof m.commit === "string" || m.commit === null) &&
    typeof m.repoRoot === "string" &&
    typeof m.command === "string" &&
    typeof m.dirty === "boolean" &&
    typeof m.fileState === "object" &&
    m.fileState !== null
  );
}
