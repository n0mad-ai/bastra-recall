/**
 * #621: the PreToolUse Write/Edit hint as a compact first-touch note.
 *
 * The seven-day readout on 2026-09-21 had this lane inject ~96,957 tokens over
 * 964 calls for four explicit loads. Low load-through is not proof the hints
 * were useless (a short rule can change an edit without a load), but it rules
 * out a repeated multi-summary feed as the default shape at the highest-
 * frequency boundary. The default is therefore:
 *
 *   - rich retrieval is shown only on the FIRST edit of a task area in the
 *     session; later edits in the same area stay silent,
 *   - at most one candidate, rendered as id + title + one rule line, under an
 *     explicit character ceiling,
 *   - one named exception: a REQUIRED-band hit whose hand-written
 *     `recall_when` matched with a strong anchor (a proven binding rule for
 *     exactly this edit) is shown on a repeat edit too — same one-candidate
 *     shape, telemetry reason `binding-anchored`.
 *
 * Ranking is untouched; `BASTRA_PRETOOL_SHAPE=legacy` restores the previous
 * presentation (every edit, full candidate list with summaries).
 */
import { HINT_FRAME_NOTE, stripFenceMarkers } from "@bastra-recall/core/scrub";
import { repoRelative } from "./code-graph/dependents-block.js";
import { envFirst } from "./env.js";

/** At most this many candidates in the default document. */
export const PRETOOL_MAX_CANDIDATES = 1;
/** Hard ceiling of the default hint block in characters (~150 tokens at 4 chars/token). */
export const PRETOOL_HINT_CHAR_CEILING = 600;
/** Longest rule line before the ceiling is even considered. */
const RULE_LINE_MAX = 160;
/** Longest title; keeps even a title-only line under the ceiling. */
const TITLE_MAX = 120;
/** An area is the first this many directory segments of the repo-relative path. */
const AREA_DEPTH = 2;

export type PretoolHintReason = "first-touch" | "binding-anchored" | "repeat-area" | "weak";

export function pretoolLegacyShape(): boolean {
  return (envFirst("BASTRA_PRETOOL_SHAPE") ?? "").toLowerCase() === "legacy";
}

/**
 * The task area of a file: repository root plus the first AREA_DEPTH directory
 * segments, case-folded. Bounded by construction — a repository has only so
 * many top-level directories — so aliases and renames inside an area do not
 * open new areas. Outside a repository the parent directory is the area.
 * Stored as a `shown` key, so compact/clear (`clearShown`) release it.
 */
export function pretoolAreaKey(repoRoot: string, filePath: string): string {
  const rel = repoRelative(repoRoot, filePath);
  if (rel === null) {
    const parent = filePath.slice(0, Math.max(0, filePath.lastIndexOf("/")));
    return `area:${parent.toLowerCase()}`;
  }
  const dirs = rel.split("/").slice(0, -1).slice(0, AREA_DEPTH);
  return `area:${repoRoot.toLowerCase()}:${dirs.join("/").toLowerCase()}`;
}

interface ShapeHit {
  id: string;
  title: string;
  type: string;
  summary: string;
  score: number;
  matched_recall_when?: boolean;
  anchor_strength?: "strong" | "weak";
}

/** The one exception to "repeat edits stay silent". Needs the fused scale. */
export function isBindingAnchored(h: ShapeHit, mustLoadScore: number, unfused: boolean): boolean {
  return !unfused && h.score >= mustLoadScore && h.matched_recall_when === true && h.anchor_strength === "strong";
}

/** First sentence of the summary, capped — the "one actionable rule line". */
function ruleLine(summary: string, max: number): string {
  const flat = summary.replace(/\s+/g, " ").trim();
  const cut = flat.search(/[.!?](\s|$)/);
  const first = cut >= 0 ? flat.slice(0, cut + 1) : flat;
  return first.length > max ? first.slice(0, max - 1) + "…" : first;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The default PreToolUse document: one candidate, id + title + one rule line,
 * never above PRETOOL_HINT_CHAR_CEILING — the rule line shrinks first, then
 * goes.
 */
export function formatCompactHint(
  hit: ShapeHit,
  project: string | null,
  surface: string,
  reason: "first-touch" | "binding-anchored",
): string {
  const projAttr = project ? ` project="${escapeAttr(project)}"` : "";
  const head = `<recall-hints surface="${escapeAttr(surface)}" trigger="${reason}"${projAttr}>`;
  const tail = `</recall-hints>`;
  const headline =
    reason === "first-touch"
      ? "First edit in this area this session — one vault candidate that may bear on it (a pointer, not the rule; load_memory(id) for the full body):"
      : "A rule whose own trigger matched this edit — load_memory(id) for the full body:";
  const render = (line: string) =>
    [head, HINT_FRAME_NOTE, stripFenceMarkers(`${headline}\n${line}`), tail].join("\n");
  const title = hit.title.length > TITLE_MAX ? hit.title.slice(0, TITLE_MAX - 1) + "…" : hit.title;
  const base = `- ${hit.id} (${hit.type}): ${title}`;
  const rule = ruleLine(hit.summary, RULE_LINE_MAX);
  let block = render(rule ? `${base} — ${rule}` : base);
  if (block.length > PRETOOL_HINT_CHAR_CEILING && rule) {
    const room = rule.length - (block.length - PRETOOL_HINT_CHAR_CEILING);
    block = render(room >= 24 ? `${base} — ${ruleLine(rule, room)}` : base);
  }
  return block;
}
