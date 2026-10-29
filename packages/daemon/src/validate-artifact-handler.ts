/**
 * #1309: MCP tool `validate_artifact` — the copy-blocks validator from core,
 * exposed to agents before they deliver copy-ready blocks. Pure computation,
 * no vault access; `review_draft` (learning-candidate moderation) stays separate.
 */
import { z } from "zod";
import { validateCopyBlocks, renderForChat } from "@bastra-recall/core";

const UNIT_DESCRIPTION = "Counting unit for other channels; omit for the stricter of both. discord-dm always applies max(codepoints,utf16) until its counting unit is verified; an explicit unit cannot weaken this fallback.";

export const ValidateArtifactArgs = z.object({
  text: z.string(),
  channel: z.string().min(1),
  limit: z.number().int().min(1).optional(),
  unit: z.enum(["codepoints", "utf16"]).optional().describe(UNIT_DESCRIPTION),
  normalize: z.enum(["crlf-to-lf", "none"]),
  rule: z.object({ id: z.string().min(1), revision: z.string().min(1) }).optional(),
  task: z.object({ kind: z.string().min(1), generation: z.number().int().min(0) }).optional(),
});

export const validateArtifactTools = [{
  name: "validate_artifact",
  annotations: { readOnlyHint: true, destructiveHint: false },
  description:
    "Discord's counting unit is unverified: discord-dm always uses the conservative max(codepoints,utf16) fallback; " +
    "an explicit unit cannot weaken it. Other channels respect an explicit unit. " +
    "Call before you deliver text the user will copy into a size-limited channel. " +
    "Splits the final text into blocks at paragraph, line, sentence or word boundaries (never inside a character), " +
    "returns each payload with its offsets and count, the separators between blocks, and `rendered`: labels outside " +
    "fenced blocks, ready to show. Fails on `> ` quote prefixes, counters like (1/3) inside a payload, or a word longer " +
    "than the limit. A `receipt` is issued only when every check passed: it proves these exact bytes, split this way, " +
    "passed these mechanical checks under this channel, limit, unit, rule and task state. It does not check translation " +
    "quality, language, or whether a draft was approved. Deliver the payloads unchanged; any edit needs a new call.",
  inputSchema: {
    type: "object" as const,
    properties: {
      text: { type: "string", description: "The final text, exactly as it will be delivered." },
      channel: { type: "string", description: "Target channel, e.g. discord-dm (default limit 2000; unverified counting unit, so always the stricter of code-point and UTF-16 counts)." },
      limit: { type: "number", description: "Maximum count per block. Optional for channels with a default." },
      unit: { type: "string", enum: ["codepoints", "utf16"], description: UNIT_DESCRIPTION },
      normalize: { type: "string", enum: ["crlf-to-lf", "none"], description: "Line-ending normalization applied before splitting." },
      rule: { type: "object", properties: { id: { type: "string" }, revision: { type: "string" } }, required: ["id", "revision"], description: "The rule the text was produced under, bound into the receipt." },
      task: { type: "object", properties: { kind: { type: "string" }, generation: { type: "number" } }, required: ["kind", "generation"], description: "Task state and generation, bound into the receipt." },
    },
    required: ["text", "channel", "normalize"],
  },
}];

export function validateArtifactHandler(args: Record<string, unknown>) {
  const result = validateCopyBlocks(ValidateArtifactArgs.parse(args));
  return { ...result, rendered: renderForChat(result) };
}
