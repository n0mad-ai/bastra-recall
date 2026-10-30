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

/** Explicit declarations win. Legacy membership requires user-directed origin.
 * Only active conventions and floors default to always; intrinsic preferences
 * and reflex rules use the description index to keep the always budget small. */
export function resolveRulebook(fm: Frontmatter, context: RulebookLegacyContext = {}): RulebookDeclaration | undefined {
  if (fm.obsolete || fm.superseded_by) return undefined;
  let rulebook = fm.rulebook;
  if (!rulebook && fm.write_origin === "user-directed") {
    if (context.floor || context.activeConvention) rulebook = "always";
    else if (fm.recall_mode === "reflex" || fm.type === "meta-working" || fm.type === "user-preference" || fm.type === "workflow") rulebook = "on-demand";
  }
  return rulebook ? { rulebook, applies_when: fm.applies_when ?? fm.summary,
    ...(fm.applies_when === undefined ? { applies_when_derived: true as const } : {}) } : undefined;
}
