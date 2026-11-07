/** Runtime compatibility only: no migration, file write, search or language matching. */
import type { Frontmatter } from "./schema.js";
export interface RulebookDeclaration {
  rulebook: "always" | "on-demand";
  applies_when: string;
  /** Runtime fallback, never authored/persisted as a rule description. */
  applies_when_derived?: true;
}
export interface RulebookLegacyContext {
  activeConvention?: boolean;
  floor?: boolean;
}

/** #1386: what is left of a proposal once `bound` became the memory's own
 * declaration. Bound fields are dropped; if nothing else is pending the
 * proposal is gone, otherwise the rest stays, aligned to the bound tier. */
export function remainingProposal(proposal: Record<string, unknown> | undefined,
  bound: { rulebook: RulebookDeclaration["rulebook"]; applies_when: string }, covered: readonly string[] = []): Record<string, unknown> | undefined {
  if (!proposal) return undefined;
  const rest = Object.entries(proposal).filter(([key]) => key !== "rulebook" && key !== "applies_when" && !covered.includes(key));
  return rest.length > 0 ? { ...bound, ...Object.fromEntries(rest) } : undefined;
}

/** Explicit declarations win. Legacy membership requires user-directed origin.
 * Only active conventions and floors default to always; intrinsic preferences
 * and reflex rules use the description index to keep the always budget small. */
export function resolveRulebook(fm: Frontmatter, context: RulebookLegacyContext = {}): RulebookDeclaration | undefined {
  if (fm.obsolete || fm.superseded_by) return undefined;
  let rulebook = fm.rulebook;
  if (!rulebook && fm.write_origin === "user-directed") {
    if (context.floor || context.activeConvention) rulebook = "always";
    else if (fm.recall_mode === "reflex" || fm.type === "meta-working" || fm.type === "user-preference" || fm.type === "workflow" || fm.rule_categories?.length || fm.validator) rulebook = "on-demand";
  }
  return rulebook ? { rulebook, applies_when: fm.applies_when ?? fm.summary,
    ...(fm.applies_when === undefined ? { applies_when_derived: true as const } : {}) } : undefined;
}
