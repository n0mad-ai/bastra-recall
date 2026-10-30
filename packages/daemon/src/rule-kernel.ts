/** A: complete always bodies. B: description index plus a complete paged catalog. */
import { HINT_FRAME_NOTE } from "@bastra-recall/core/scrub";
import { catalogHash, cleanRuleText, oneLine, rulebookCursor, ruleIndexLine, RULEBOOK_INDEX_CHAR_BUDGET,
  type KernelCandidates } from "./rulebook-catalog.js";
export { cachedRulebookCatalog as collectRuleKernel } from "./rulebook-catalog.js";
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
  if (candidates.ids_only) throw new Error("IDs-only catalog cannot render a rule kernel");
  const entries = candidates.entries.map(e => ({ ...e, id: oneLine(e.id), title: oneLine(e.title), revision: e.revision ? oneLine(e.revision) : null, updated: e.updated ? oneLine(e.updated) : null, body: cleanRuleText(e.body).trim() }));
  const total = entries.length;
  if (!total && !candidates.fallback && !(candidates.unconfirmed_legacy ?? 0) && !candidates.omitted && !candidates.unavailable_sources) return { text: "", full: [], degraded: [], omitted: 0, always_overflow: [] };
  const trigger = oneLine(opts.trigger).slice(0, 120).replaceAll('"', "&quot;");
  const header = [`<rule-kernel trigger="${trigger}">`,
    ...(candidates.fallback ? ["Catalog unavailable: restored available indexed rules; full catalog/floor coverage is not verified."] : []),
    `Rulebook: ${total} rules; catalog=${catalogHash(candidates)}; ${candidates.unconfirmed_legacy ?? 0} possible rules without confirmation.`,
    ...(opts.lexicalOnly ? [RULE_KERNEL_LEXICAL_LINE] : []), '<recall-hints trigger="rule-kernel">', HINT_FRAME_NOTE];
  if (candidates.unavailable_sources) header.push(`Catalog source check incomplete: ${candidates.unavailable_sources} sources unavailable; listed entries do not prove full restoration.`);
  const always = entries.filter(e => (e.rulebook ?? "always") === "always");
  const full: string[] = [], bodies: string[] = [], overflow: string[] = [];
  let aUsed = 0;
  for (const e of always) {
    const block = `Always ${e.id} revision=${e.revision ?? "unknown"} updated=${e.updated ?? "unknown"} stale_status=${e.stale_status ?? "unknown"}:\n` + e.body.split("\n").map(s => "  " + s).join("\n");
    if (e.source_unavailable || aUsed + block.length + 1 > RULEBOOK_ALWAYS_CHAR_BUDGET) { overflow.push(e.id); continue; }
    bodies.push(block); full.push(e.id); aUsed += block.length + 1;
  }
  const overflowLine = () => {
    if (!overflow.length) return [];
    const names: string[] = [];
    for (const id of overflow) { if (names.join(", ").length + id.length > 400) break; names.push(id); }
    const named = names.join(", ") + (names.length < overflow.length ? ` (+${overflow.length - names.length} more)` : "");
    return [`Always overflow (${overflow.length}): ${named}. Complete texts did not fit or were unavailable; shorten them or set on-demand. All IDs are in list_rules.`];
  };
  const base = () => [...header, ...bodies, ...overflowLine(),
    ...(candidates.omitted ? [`Catalog incomplete from source: ${candidates.omitted} entries unavailable; complete restoration is not established.`] : []),
    "Rule index (all tiers; descriptions are facts):"];
  const tail = ["</recall-hints>", RULE_KERNEL_ASK_LINE, "</rule-kernel>"];
  const footer = (offset: number) => offset < total
    ? `Catalog continuation: list_rules(cursor=${JSON.stringify(rulebookCursor(candidates, offset))}); total=${total}, shown=${offset}.`
    : `Catalog end: hash=${catalogHash(candidates)} count=${total}.`;
  const measured = (lines: string[], offset: number) => [...lines, footer(offset), ...tail].join("\n").length;
  // Reserve the ACTUAL cursor, including its encoded project key. Whole A
  // entries may be deferred, but neither their bodies nor the cursor is cut.
  while (bodies.length && measured(base(), 0) > RULE_KERNEL_CHAR_BUDGET) {
    bodies.pop(); overflow.push(full.pop()!);
  }
  const minimal = (): RenderedKernel => ({
    text: [`<rule-kernel trigger="${trigger}">`,
      `Rulebook: ${total} rules; ${candidates.unconfirmed_legacy ?? 0} possible rules without confirmation.`,
      "The complete catalog and Always-overflow IDs are available through list_rules(); the cursor did not fit this context.",
      "</rule-kernel>"].join("\n"),
    full: [], degraded: [], omitted: candidates.omitted, paged_index: total,
    always_overflow: always.map(e => e.id),
  });
  if (measured(base(), 0) > RULE_KERNEL_CHAR_BUDGET) return minimal();
  const lines = base(), degraded: string[] = [];
  let offset = 0, indexUsed = 0;
  for (const e of entries) {
    const line = ruleIndexLine(e);
    if (indexUsed + line.length + 1 > RULEBOOK_INDEX_CHAR_BUDGET || measured([...lines, line], offset + 1) > RULE_KERNEL_CHAR_BUDGET) break;
    lines.push(line); indexUsed += line.length + 1; offset++;
    if (!full.includes(e.id)) degraded.push(e.id);
  }
  const next_cursor = offset < total ? rulebookCursor(candidates, offset) : undefined;
  const text = [...lines, footer(offset), ...tail].join("\n");
  // Hard boundary, independent of metadata/cursor lengths.
  if (text.length > RULE_KERNEL_CHAR_BUDGET) return minimal();
  return { text, full, degraded, omitted: candidates.omitted, paged_index: total - offset,
    always_overflow: overflow, ...(next_cursor ? { next_cursor } : {}) };
}
