/** #1378: request semantic review at a structured rule-write boundary.
 * No text is classified: the agent owns the judgement. This is not a finding,
 * quality penalty, write gate, rewrite or authority to change an owner's rule.
 */
import type { Memory } from "@bastra-recall/core";
import { catalogDeclaration } from "./rulebook-catalog.js";

export interface RuleTextReview {
  status: "not-assessed";
  fields: ["title", "summary", "body", "applies_when"];
  advice: string;
}

/** Use the committed frontmatter, not the incoming patch or a later index read.
 * Proposals need the same author review without acquiring rule authority.
 * Deliberately no text scan, language list, date/version regexp or model call.
 */
export function ruleTextReview(fm: Memory["fm"]): RuleTextReview | undefined {
  if (fm.obsolete || fm.superseded_by || (!catalogDeclaration(fm) && !fm.rulebook_proposed)) return undefined;
  return {
    status: "not-assessed",
    fields: ["title", "summary", "body", "applies_when"],
    advice: "Review the complete resulting memory, not just the incoming fragment: title and summary should state the lasting rule; " +
      "body should integrate rule, why and how to apply instead of accumulating addenda. Keep temporary release, milestone and progress state in a work-state note or issue. " +
      "Preserve decided content, incident dates, quoted examples and explicit owner time bounds. This is a review request, not a detected defect; " +
      "the agent decides whether any edit is needed. Do not repeat a successful write merely to acknowledge this advice.",
  };
}
