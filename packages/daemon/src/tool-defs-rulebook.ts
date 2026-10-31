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
  description: "Explicit mechanical validator for this convention. Omit to preserve on overwrite; null requests removal. Changes/removal on an existing validator rule are unconfirmed proposals until the user applies them via CLI/UI. No validator is inferred from prose or channel names.",
};

/** New declarations need a description; MCP edits stage proposals. */
export const RULE_CATEGORIES_INPUT = {type:"array",maxItems:2,items:{type:"string",enum:["github-issues-prs","correspondence"]},description:"Fixed structural rule categories. GitHub issue/PR actions bind the first category through shell AST structure. Never infer a category from natural-language keywords. Missing categories retain legacy discovery; edits are proposals until user confirmation."};
export const RULEBOOK_INPUT = { type: "string", enum: ["always", "on-demand"],
  description: "Rule delivery tier. New saves require applies_when. Only an explicitly user-directed new declaration binds; agent declarations and edits remain proposals." };
export const APPLIES_WHEN_INPUT = { type: "string", minLength: 1,
  description: "One sentence describing when this rule applies, in the user's language. No keyword list. Required for a new rulebook declaration." };
export const RULEBOOK_PROPOSED_INPUT = { type: "object", additionalProperties: false,
  properties: { rulebook: RULEBOOK_INPUT, applies_when: APPLIES_WHEN_INPUT, rule_categories:RULE_CATEGORIES_INPUT,
    validator:VALIDATOR_INPUT,archive:{type:'boolean'},obsolete:{type:'boolean'},superseded_by:{type:['string','null']},sensitivity:{type:'string',enum:['public','team','private']} },
  required: ["rulebook", "applies_when"],
  description: "Unconfirmed proposal. Excluded from the binding catalog and catalog hash until user confirmation in CLI/UI." };
