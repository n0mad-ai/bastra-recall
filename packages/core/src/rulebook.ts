/** Runtime compatibility only: no migration, file write, search or language matching. */
import type { Frontmatter } from "./schema.js";

export interface RulebookDeclaration {
  rulebook: "always" | "on-demand";
  applies_when: string;
}
export interface RulebookLegacyContext {
  activeConvention?: boolean;
  floor?: boolean;
}

/** Explicit metadata wins. Proposals alone never confer membership.
 * Floor/active membership is external state, supplied by the session caller.
 * Existing user-directed preferences are always-on; other legacy rules use
 * the description index. summary is a fallback only for existing notes. */
export function resolveRulebook(fm: Frontmatter, context: RulebookLegacyContext = {}): RulebookDeclaration | undefined {
  if (fm.obsolete || fm.superseded_by) return undefined;
  let rulebook = fm.rulebook;
  if (!rulebook) {
    if (context.floor || (fm.write_origin === "user-directed" &&
      (fm.type === "meta-working" || fm.type === "user-preference"))) rulebook = "always";
    else if (context.activeConvention || fm.recall_mode === "reflex" ||
      (fm.write_origin === "user-directed" && fm.type === "workflow")) rulebook = "on-demand";
  }
  return rulebook ? { rulebook, applies_when: fm.applies_when ?? fm.summary } : undefined;
}
