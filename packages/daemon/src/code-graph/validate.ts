/**
 * Treating `graph.json` as untrusted input (#575).
 *
 * The counter-review's finding: the planned format guard validated that the
 * fields we read exist, which is a compatibility check, not a trust boundary.
 * A graph can arrive with an absolute path, a `..` escape, a NUL byte, control
 * characters or a multi-megabyte symbol name, and every one of those would
 * have been passed straight into an agent's context.
 *
 * Two rules run through everything here:
 *
 *   1. Reject, never repair. A path that escapes the repository is dropped,
 *      not rewritten to something plausible — a "fixed" path is a guess about
 *      what a file we do not trust meant.
 *   2. Allowlist on output. Only fields named here are ever emitted. An
 *      unknown field in the graph is dropped, so a future Graphify release
 *      cannot widen what reaches the context without us deciding to.
 */

import { MAX_STRING_BYTES } from "./limits.js";

/** Why a graph, or one record in it, was refused. Shown in `bastra doctor`. */
export type RejectReason =
  | "too-large"
  | "unreadable"
  | "not-json"
  | "wrong-shape"
  | "too-many-nodes"
  | "too-many-edges"
  | "string-too-long"
  | "bad-path"
  | "no-manifest";

/**
 * Control characters stripped before anything is emitted. Covers C0 and C1
 * plus the bidirectional-override run, which can make a path RENDER as
 * something other than what it is — and the rendering is what a human
 * reviewer acts on.
 */
const CONTROL_CHARS = new RegExp(
  "[\\u0000-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069]",
  "g",
);

/** A NUL byte, checked separately from the strip so a path carrying one is
 *  refused outright rather than quietly cleaned into a valid-looking path. */
const NUL = "\u0000";

/**
 * A string safe to put in front of an agent, or null when it is not a string
 * or busts the length limit. Length is measured in BYTES, not code units:
 * the limit exists to bound context, and an emoji-heavy name costs four bytes
 * per character while `.length` reports one.
 */
export function safeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) return null;
  const cleaned = value.replace(CONTROL_CHARS, "");
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * A repo-relative POSIX path, or null when the value cannot be trusted as one.
 *
 * Accepted: `packages/core/src/save.ts`.
 * Refused: absolute paths, Windows drive letters and UNC paths, any `..`
 * segment, a NUL byte, a path that normalizes to nothing, and anything over
 * the string limit.
 *
 * Backslashes are normalized to `/` first, because a graph built on Windows
 * writes them and they are a legitimate separator there. That normalization
 * happens BEFORE the traversal check, never after, so a `..\..\etc` cannot
 * slip past a check that only looked for `../`. The NUL check likewise runs
 * on the raw value, before any stripping.
 */
export function safeRepoPath(value: unknown): string | null {
  if (typeof value === "string" && value.includes(NUL)) return null;
  const raw = safeString(value);
  if (raw === null) return null;
  const norm = raw.replace(/\\/g, "/");
  if (norm.startsWith("/")) return null;
  if (/^[A-Za-z]:/.test(norm)) return null;
  const segments = norm.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0) return null;
  if (segments.some((s) => s === "..")) return null;
  return segments.join("/");
}

/**
 * Graphify's `source_location` is a string like `L42`. Returned as a positive
 * integer, or null. A line number is the one field an agent acts on directly
 * (it opens the file there), so a malformed one is dropped rather than guessed.
 */
export function safeLine(value: unknown): number | null {
  const raw = safeString(value);
  if (raw === null) return null;
  const m = /^L(\d{1,9})$/.exec(raw);
  if (m === null) return null;
  const line = Number(m[1]);
  return Number.isInteger(line) && line > 0 ? line : null;
}

/** The node fields Recall reads. Everything else in the graph is dropped. */
export interface SafeNode {
  id: string;
  label: string;
  file: string;
  line: number | null;
  community: number | null;
}

/** The edge fields Recall reads. */
export interface SafeEdge {
  source: string;
  target: string;
  relation: string;
}

/**
 * One node, reduced to the allowlisted fields and validated, or null when it
 * is not a usable code location. Non-code nodes (`concept`, `rationale`) are
 * dropped here: they came out of code comments and stay inside the code-only
 * boundary, but they are not somewhere an agent can navigate to.
 */
export function safeNode(raw: unknown, codeFileType: string): SafeNode | null {
  if (typeof raw !== "object" || raw === null) return null;
  const n = raw as Record<string, unknown>;
  if (n.file_type !== codeFileType) return null;
  const id = safeString(n.id);
  const label = safeString(n.label);
  const file = safeRepoPath(n.source_file);
  if (id === null || label === null || file === null) return null;
  return {
    id,
    label,
    file,
    line: safeLine(n.source_location),
    community:
      typeof n.community === "number" && Number.isFinite(n.community) ? n.community : null,
  };
}

/**
 * One edge, or null. `confidence` must be exactly the extracted marker: the
 * check is per edge and not per relation, because `calls` mixes 4363 extracted
 * with 153 inferred edges and the relation name alone would admit both.
 */
export function safeEdge(raw: unknown, extracted: string): SafeEdge | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (e.confidence !== extracted) return null;
  const source = safeString(e.source);
  const target = safeString(e.target);
  const relation = safeString(e.relation);
  if (source === null || target === null || relation === null) return null;
  return { source, target, relation };
}
