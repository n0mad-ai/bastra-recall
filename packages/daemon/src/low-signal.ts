/**
 * #642 — memories that are on topic but carry almost nothing: they take recall
 * slots and context without changing what the agent does. `save_quality`
 * catches this only at save time and only for new memories; the curator asks
 * the same questions of what is already stored, for REPORT.md.
 *
 * Report only: nothing here demotes, edits or trashes. The checks are the
 * language-neutral half of the save-time advisory — a one-word trigger, a
 * trigger that restates the summary (`triggerRestatesSummary`, the #238
 * check) — plus two structural ones the advisory does not need at save time:
 * a body with almost no text and a title that is only a date. Trigger
 * collisions are not repeated here; the "Claimed twice" section covers them.
 */
import { stripAutoRelatedSection } from "@bastra-recall/core";
import { GENERATED_TRIGGER_TYPES } from "./claim-gate.js";
import { tokens, triggerRestatesSummary } from "./save-similarity.js";

/** Rows one report shows; the count above the list is always complete. */
export const LOW_SIGNAL_REPORT_LIMIT = 30;

/** A body below this many non-space characters says next to nothing. */
export const LOW_SIGNAL_BODY_MIN_CHARS = 40;

/** Digits and date/time separators only — `2026-11-17`, `17.11.2026 14:00`. */
const DATE_ONLY = /^[\p{N}\s./:-]+$/u;

export interface LowSignalMemory {
  id: string;
  title?: string;
  reasons: string[];
}

interface MemoryLike {
  fm: Record<string, unknown>;
  body?: string;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** Why this memory carries little signal; empty when nothing applies. */
export function lowSignalReasons(m: MemoryLike): string[] {
  const reasons: string[] = [];
  const triggers = strings(m.fm.recall_when);
  const summary = typeof m.fm.summary === "string" ? m.fm.summary : "";
  const title = typeof m.fm.title === "string" ? m.fm.title.trim() : "";
  if (triggers.length === 0) reasons.push("no recall_when trigger");
  const oneWord = triggers.filter((t) => tokens(t).length <= 1);
  if (oneWord.length > 0) reasons.push(`one-word trigger: ${oneWord.map((t) => `'${t}'`).join(", ")}`);
  if (triggers.some((t) => triggerRestatesSummary(t, summary))) reasons.push("a trigger restates the summary");
  const bodyChars = stripAutoRelatedSection(m.body ?? "").replace(/\s+/gu, "").length;
  if (bodyChars < LOW_SIGNAL_BODY_MIN_CHARS) reasons.push(`body has ${bodyChars} characters`);
  if (title !== "" && DATE_ONLY.test(title) && /\p{N}/u.test(title)) reasons.push("title is only a date");
  return reasons;
}

/** Active, authored memories with at least one reason, most reasons first. */
export function collectLowSignal(memories: Iterable<MemoryLike>): LowSignalMemory[] {
  const out: LowSignalMemory[] = [];
  for (const m of memories) {
    const id = typeof m.fm.id === "string" ? m.fm.id : "";
    if (!id || m.fm.obsolete === true || typeof m.fm.superseded_by === "string") continue;
    if (GENERATED_TRIGGER_TYPES.has(String(m.fm.type))) continue;
    const reasons = lowSignalReasons(m);
    if (reasons.length === 0) continue;
    out.push({ id, ...(typeof m.fm.title === "string" ? { title: m.fm.title } : {}), reasons });
  }
  return out.sort((a, b) => b.reasons.length - a.reasons.length || a.id.localeCompare(b.id));
}
