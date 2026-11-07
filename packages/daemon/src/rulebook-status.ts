/**
 * #1384/#1385: the one line a save or edit response carries about the rule
 * state of the memory it wrote — rule, proposal or note. Derived only from
 * structured fields of the written memory (Owner decision 2026-11-04): no
 * reading of user text, no promotion. The response informs, it does not decide.
 */
import type { Memory } from "@bastra-recall/core";
import { catalogDeclaration } from "./rulebook-catalog.js";

/** Types that describe how the agent should behave (#1384). */
const BEHAVIOURAL_TYPES: ReadonlySet<string> = new Set(["lesson", "meta-working", "preference", "user-preference", "workflow"]);

export function rulebookDelivery(fm: Memory["fm"]): string {
  const declaration = catalogDeclaration(fm);
  if (declaration) {
    return `rule (${declaration.rulebook}): active now` +
      (declaration.rulebook === "always" ? " — its text is loaded in every session." : " — listed in the rule catalog, loaded when it applies.") +
      (declaration.applies_when_derived ? " applies_when is derived from the summary; set applies_when to say when it applies." : "");
  }
  if (fm.rulebook_proposed) {
    return "proposal (not active): the declaration waits in rulebook_proposed and is not a rule yet. " +
      "It binds only on the user's word (write_origin: user-directed).";
  }
  return "note only (no rulebook declaration): surfaces through recall, it is not a rule." +
    (fm.write_origin === "user-directed" && BEHAVIOURAL_TYPES.has(fm.type)
      ? " If the user asked for a rule, add rulebook + applies_when."
      : "");
}
