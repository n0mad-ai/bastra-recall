/** Shared save/edit wire declaration; null deliberately removes the validator. */
export const VALIDATOR_INPUT = {
  anyOf: [{
    type: "object", additionalProperties: false,
    properties: {
      tool: { type: "string", enum: ["validate_artifact"] },
      channel: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1 },
      unit: { type: "string", enum: ["codepoints", "utf16"] },
    },
    required: ["tool", "channel", "limit", "unit"],
  }, { type: "null" }],
  description: "Explicit mechanical validator for this convention. Omit to preserve on overwrite; null removes it. Agent changes/removal on existing rules apply immediately after reindex, by explicit Owner decision (#1336); no confirmation is required. On a non-rule, a new agent-supplied validator is staged in rulebook_proposed; a validator alone never authorizes a binding declaration. No validator is inferred from prose or channel names.",
};

/** New agent declarations need a description and remain proposals; existing rules are directly editable. */
export const RULE_CATEGORIES_INPUT = {type:"array",maxItems:2,items:{type:"string",enum:["github-issues-prs","correspondence"]},description:"Fixed structural rule categories. GitHub issue/PR actions bind the first category through shell AST structure. Never infer a category from natural-language keywords. Missing categories retain legacy discovery; agent edits to existing rules apply directly without confirmation."};
export const RULEBOOK_INPUT = { type: "string", enum: ["always", "on-demand"],
  description: "Rule delivery tier. New saves require applies_when. Only an explicitly user-directed new declaration binds; new agent declarations remain proposals. Agent edits to existing rules apply directly without confirmation. Existing means a preexisting valid declaration or user-directed legacy declaration, never validator-only or session activation/floor status." };
export const APPLIES_WHEN_INPUT = { type: "string", minLength: 1,
  description: "One sentence describing when this rule applies, in the user's language. No keyword list. Required for a new rulebook declaration." };
export const RULEBOOK_PROPOSED_INPUT = { type: "object", additionalProperties: false,
  properties: { rulebook: RULEBOOK_INPUT, applies_when: APPLIES_WHEN_INPUT, rule_categories:RULE_CATEGORIES_INPUT,
    validator:VALIDATOR_INPUT,archive:{type:'boolean'},obsolete:{type:'boolean'},superseded_by:{type:['string','null']},sensitivity:{type:'string',enum:['public','team','private']} },
  required: ["rulebook", "applies_when"],
  description: "Unconfirmed proposal. Excluded from the binding catalog and catalog hash until user confirmation in CLI/UI." };
