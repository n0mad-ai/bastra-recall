/**
 * #1309: MCP tool `validate_artifact` — the copy-blocks validator from core,
 * exposed to agents before they deliver copy-ready blocks. Pure computation,
 * no vault access; `review_draft` (learning-candidate moderation) stays separate.
 */
import { z } from "zod";
import { validateCopyBlocks, renderForChat } from "@bastra-recall/core";
import { callerSessionStore } from "./caller-session.js";
import { storeReceipt, type StoreOutcome } from "./receipt-store.js";
import type { Telemetry } from "./telemetry.js";

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

const RECEIPT_NOTES: Readonly<Record<Exclude<StoreOutcome, "stored">, string>> = {
  no_task: "Receipt not stored: the session has no correspondence task in progress.",
  task_mismatch: "Receipt not stored: `task` does not match the session's current task and generation.",
  not_persisted: "Receipt not stored: the session state could not be written.",
};
const UNATTRIBUTED_NOTE =
  "Receipt not stored: this call carried no Claude Code session (stdio or no session header), so it cannot be bound to a task.";

/**
 * #1310: a passing result is stored as a receipt in the CALLING session only —
 * the session the forwarder named (`x-bastra-cc-session`). Without one the
 * receipt is returned but not stored, and a `receipt_unattributed` line is
 * written; it is never written into some or all sessions on a guess.
 */
export async function validateArtifactHandler(args: Record<string, unknown>, deps?: { telemetry?: Telemetry }) {
  const input = ValidateArtifactArgs.parse(args);
  const result = validateCopyBlocks(input);
  const caller = callerSessionStore.getStore();
  const session_known = typeof caller === "string" && caller.length > 0;
  const base = { ...result, rendered: renderForChat(result), session_known };
  if (result.receipt === null) return { ...base, receipt_stored: false };
  if (!session_known) {
    await deps?.telemetry?.logReceiptUnattributed({ channel: result.channel, transport: caller === undefined ? "stdio" : "forwarded" }).catch(() => {});
    return { ...base, receipt_stored: false, receipt_note: UNATTRIBUTED_NOTE };
  }
  const outcome = await storeReceipt(caller, { ...result, receipt: result.receipt }, input.task);
  return outcome === "stored"
    ? { ...base, receipt_stored: true }
    : { ...base, receipt_stored: false, receipt_note: RECEIPT_NOTES[outcome] };
}
