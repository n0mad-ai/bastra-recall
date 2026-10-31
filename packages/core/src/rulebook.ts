/** Runtime compatibility only: no migration, file write, search or language matching. */
import type { Frontmatter } from "./schema.js";
import {ConventionValidatorSchema} from './schema.js';

/** MCP authority is transport-bound, never inferred from write_origin args.
 * User surfaces use the underlying writers without this proposal transform. */
export function proposeValidatorRuleChange(prev:Record<string,unknown>,next:Record<string,unknown>):Record<string,unknown>{
 if(!ConventionValidatorSchema.safeParse(prev.validator).success)return next;
 const out={...next};const changes:Record<string,unknown>={};
 for(const key of ['validator','obsolete','superseded_by','sensitivity']){
  if(JSON.stringify(prev[key])!==JSON.stringify(next[key]))changes[key]=next[key]??(key==='obsolete'?false:key==='sensitivity'?'public':null);
  if(prev[key]===undefined)delete out[key];else out[key]=prev[key];
 }
 if(Object.keys(changes).length)out.rulebook_proposed={rulebook:prev.rulebook??'on-demand',applies_when:prev.applies_when??prev.summary??'When this rule applies',...(next.rulebook_proposed as object??{}),...changes};
 return out;
}

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
    else if (fm.recall_mode === "reflex" || fm.type === "meta-working" || fm.type === "user-preference" || fm.type === "workflow" || fm.rule_categories?.length) rulebook = "on-demand";
  }
  return rulebook ? { rulebook, applies_when: fm.applies_when ?? fm.summary,
    ...(fm.applies_when === undefined ? { applies_when_derived: true as const } : {}) } : undefined;
}
