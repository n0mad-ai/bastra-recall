import { z } from "zod";
import type { ToolDeps } from "./tool-deps.js";
import { answerDraftReview } from "./draft-review.js";
import { draftVaultId } from "./draft-promote.js";
export const ReviewDraftArgs = z.object({ id: z.string().regex(/^d-[a-f0-9]{12}$/), decision: z.enum(["confirm", "reject"]) });
export const draftReviewTools = [{
  name: "review_draft",
  description: "Answer a candidate from <draft-review> after checking correctness, durability and existing vault notes. confirm records an agent verdict only: it never saves, promotes or changes promotion gates. reject closes the draft with its retained fingerprint tombstone. Only a shown open candidate in this vault can be answered.\n\nDeutsch: Antworte auf einen Kandidaten aus <draft-review>, nachdem du Richtigkeit, Dauerhaftigkeit und vorhandene Vault-Notizen geprüft hast. confirm speichert nur das Agentenurteil: keine Notiz, Übernahme oder Änderung der Übernahmesperren. reject schließt den Entwurf mit seinem aufbewahrten Fingerprint-Sperrvermerk. Nur ein gezeigter offener Kandidat dieses Vaults lässt sich beantworten.",
  inputSchema: { type: "object" as const, properties: { id: { type: "string", description: "Draft ID / Entwurfs-ID from <draft-review>" }, decision: { type: "string", enum: ["confirm", "reject"] } }, required: ["id", "decision"] },
}];
export async function reviewDraftHandler(deps: Pick<ToolDeps,"vault">, args: Record<string,unknown>) {
  const parsed = ReviewDraftArgs.parse(args);
  return answerDraftReview(parsed.id, parsed.decision, await draftVaultId(deps.vault.root));
}
