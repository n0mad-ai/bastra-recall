/** A: complete always bodies. B: description index plus a complete paged catalog. */
import { HINT_FRAME_NOTE } from "@bastra-recall/core/scrub";
import { catalogHash, cleanRuleText, oneLine, rulebookCursor, ruleIndexLine, RULEBOOK_INDEX_CHAR_BUDGET,
  type KernelCandidates } from "./rulebook-catalog.js";
export { collectRulebookCatalog as collectRuleKernel } from "./rulebook-catalog.js";
export type { KernelCandidates, KernelEntry, KernelGroup } from "./rulebook-catalog.js";

export const RULE_KERNEL_CHAR_BUDGET = 9400;
/** ~2k tokens; total host additionalContext must remain below 10k characters. */
export const RULEBOOK_ALWAYS_CHAR_BUDGET = 8000;
export const RULE_KERNEL_SHORT_BODY_CHARS = 1500;
export const RULE_KERNEL_TOOL_CALLS = 25;
/** No catalog entry cap. Kept as an API compatibility constant. */
export const RULE_KERNEL_MAX_ENTRIES = Infinity;
export const RULE_KERNEL_ASK_LINE = "Rule applicability is decided from the descriptions; bodies are available through load_memory(id).";
export const RULE_KERNEL_LEXICAL_LINE = "Rulebook membership is independent of search and embeddings.";
export interface RenderedKernel {
  text: string; full: string[]; degraded: string[]; omitted: number;
  always_overflow?: string[]; next_cursor?: string; paged_index?: number;
}
export function renderRuleKernel(candidates: KernelCandidates, opts: { trigger: string; lexicalOnly?: boolean }): RenderedKernel {
  const entries = candidates.entries.map(e => ({ ...e, id: oneLine(e.id), title: oneLine(e.title), revision: e.revision ? oneLine(e.revision) : null, updated: e.updated ? oneLine(e.updated) : null, body: cleanRuleText(e.body).trim() }));
  const total = entries.length;
  if (!total && !(candidates.unconfirmed_legacy ?? 0) && !candidates.omitted && !candidates.unavailable_sources) return { text: "", full: [], degraded: [], omitted: 0, always_overflow: [] };
  const trigger = oneLine(opts.trigger).slice(0, 120).replaceAll('"', "&quot;");
  const lines = [`<rule-kernel trigger="${trigger}">`,
    `Rulebook: ${total} rules; catalog=${catalogHash(candidates)}; ${candidates.unconfirmed_legacy ?? 0} possible rules without confirmation.`,
    ...(opts.lexicalOnly ? [RULE_KERNEL_LEXICAL_LINE] : []), '<recall-hints trigger="rule-kernel">', HINT_FRAME_NOTE];
  if (candidates.unavailable_sources) lines.push(`Catalog source check incomplete: ${candidates.unavailable_sources} sources unavailable; listed entries do not prove full restoration.`);
  const full: string[] = [], degraded: string[] = [], overflow: string[] = [];
  let aUsed = 0;
  for (const e of entries.filter(e => (e.rulebook ?? "always") === "always")) {
    const block = `Always ${e.id} revision=${e.revision ?? "unknown"} updated=${e.updated ?? "unknown"} stale_status=${e.stale_status ?? "unknown"}:\n` + e.body.split("\n").map(s => "  " + s).join("\n");
    if (!e.body || aUsed + block.length + 1 > RULEBOOK_ALWAYS_CHAR_BUDGET || lines.join("\n").length + block.length + 1200 > RULE_KERNEL_CHAR_BUDGET) { overflow.push(e.id); continue; }
    lines.push(block); full.push(e.id); aUsed += block.length + 1;
  }
  if (overflow.length) {
    const names: string[] = [];
    for (const id of overflow) { if (names.join(", ").length + id.length > 400) break; names.push(id); }
    const named = names.join(", ") + (names.length < overflow.length ? ` (+${overflow.length - names.length} more)` : "");
    lines.push(`Always overflow (${overflow.length}): ${named}. Complete texts did not fit or were unavailable; shorten them or set on-demand. All IDs are in list_rules.`);
  }
  if (candidates.omitted) lines.push(`Catalog incomplete from source: ${candidates.omitted} entries unavailable; complete restoration is not established.`);
  lines.push("Rule index (all tiers; descriptions are facts):");
  // Reserve enough for an opaque cursor, close tags and the factual footer.
  const tail = ["</recall-hints>", RULE_KERNEL_ASK_LINE, "</rule-kernel>"];
  let used = [...lines, ...tail].join("\n").length;
  let offset = 0, indexUsed = 0;
  for (const e of entries) {
    const line = ruleIndexLine(e);
    if (used + line.length + 1 + 300 > RULE_KERNEL_CHAR_BUDGET || indexUsed + line.length + 1 > RULEBOOK_INDEX_CHAR_BUDGET) break;
    lines.push(line); used += line.length + 1; indexUsed += line.length + 1; offset++;
    if (!full.includes(e.id)) degraded.push(e.id);
  }
  const next_cursor = offset < total ? rulebookCursor(candidates, offset) : undefined;
  if (next_cursor) lines.push(`Catalog continuation: list_rules(cursor=${JSON.stringify(next_cursor)}); total=${total}, shown=${offset}.`);
  else lines.push(`Catalog end: hash=${catalogHash(candidates)} count=${total}.`);
  lines.push(...tail);
  return { text: lines.join("\n"), full, degraded, omitted: candidates.omitted, paged_index: total - offset,
    always_overflow: overflow, ...(next_cursor ? { next_cursor } : {}) };
}
