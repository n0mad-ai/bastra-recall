import reviewRule from "./draft-review-rule.json" with { type: "json" };
import { z } from "zod";
import type { ToolDeps } from "./tool-deps.js";
import { answerDraftReview } from "./draft-review.js";
import { draftVaultId } from "./draft-promote.js";
export const ReviewDraftArgs = z.object({ id: z.string().regex(/^d-[a-f0-9]{12}$/), decision: z.enum(["confirm", "reject"]) });
export const draftReviewTools = [{
  name: "review_draft",
  description: "Answer a shown open candidate from <draft-review> after checking correctness, durability and existing vault notes. " + reviewRule.en + " Confirmation neither promotes nor changes promotion gates; rejection retains the fingerprint tombstone.\n\nDeutsch: Antworte auf einen gezeigten offenen Kandidaten aus <draft-review>. " + reviewRule.de + " Bestätigen ändert keine Übernahmesperren; Ablehnen erhält den Fingerprint-Sperrvermerk.",
  inputSchema: { type: "object" as const, properties: { id: { type: "string", description: "Draft ID / Entwurfs-ID from <draft-review>" }, decision: { type: "string", enum: ["confirm", "reject"] } }, required: ["id", "decision"] },
}];
export async function reviewDraftHandler(deps: Pick<ToolDeps,"vault">, args: Record<string,unknown>) {
  const parsed = ReviewDraftArgs.parse(args);
  return answerDraftReview(parsed.id, parsed.decision, await draftVaultId(deps.vault.root));
}
