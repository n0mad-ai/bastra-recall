/** Shared save/edit wire declaration; null deliberately removes the validator. */
export const VALIDATOR_INPUT = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        tool: { type: "string", enum: ["validate_artifact"] },
        channel: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1 },
        unit: { type: "string", enum: ["codepoints", "utf16"] },
      },
      required: ["tool", "channel", "limit", "unit"],
    },
    { type: "null" },
  ],
  description:
    "Explicit mechanical validator for this convention; never inferred from prose or channel names. Omit to keep it on overwrite, null removes it. On an existing rule an agent change applies after reindex without confirmation (Owner decision #1336). On a non-rule that is not user-directed, a new validator is staged in rulebook_proposed; a validator alone never makes a declaration binding.",
};

/** New agent declarations need a description and remain proposals; existing rules are directly editable. */
export const RULE_CATEGORIES_INPUT = {
  type: "array",
  maxItems: 2,
  items: { type: "string", enum: ["github-issues-prs", "correspondence"] },
  description:
    "Fixed structural categories; github-issues-prs binds through the shell command structure. Never infer one from keywords. Without categories, legacy discovery applies.",
};
export const RULEBOOK_INPUT = {
  type: "string",
  enum: ["always", "on-demand"],
  description:
    "Rule delivery tier; a new declaration needs applies_when. It binds only on a user-directed save or memory; other new agent declarations stay proposals. Agent edits to an existing rule (a valid or user-directed legacy declaration or validator) apply directly without confirmation; a validator on a non-user-directed memory or a session status alone does not make one existing.",
};
export const APPLIES_WHEN_INPUT = {
  type: "string",
  minLength: 1,
  description:
    "One sentence describing when this rule applies, in the user's language. No keyword list. Required for a new rulebook declaration.",
};
/** #1462: the same field schema without its prose. Inside rulebook_proposed the
 *  fields mean exactly what they mean one level up, where the description is
 *  already sent once; repeating it there doubled the text on two tools. */
function bare<T extends { description: string }>(input: T): Omit<T, "description"> {
  const { description: _description, ...schema } = input;
  return schema;
}

export const RULEBOOK_PROPOSED_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    rulebook: bare(RULEBOOK_INPUT),
    applies_when: bare(APPLIES_WHEN_INPUT),
    rule_categories: bare(RULE_CATEGORIES_INPUT),
    validator: bare(VALIDATOR_INPUT),
    archive: { type: "boolean" },
    obsolete: { type: "boolean" },
    superseded_by: { type: ["string", "null"] },
    sensitivity: { type: "string", enum: ["public", "team", "private"] },
  },
  required: ["rulebook", "applies_when"],
  description:
    "Unconfirmed proposal, outside the binding catalog until the user decides in chat; then edit_memory with rulebook_decision (accept or reject) and the loaded revision. Never accept your own proposal without that decision.",
};
