/**
 * #1603: the agent reports the user's answer to the setup interview offer.
 * The agent understands what the user said, in any language; Recall never
 * reads the user's words. A tool instead of `bastra onboard skip|done`, so
 * the answer needs no shell command the user would have to approve.
 */
import { z } from "zod";
import type { ToolDeps } from "./tool-deps.js";
import { markOnboardingDone } from "./onboarding.js";
import {
  claimOnboardingOffer,
  deferOnboarding,
  ONBOARDING_LATER_DEFAULT_DAYS,
  ONBOARDING_LATER_MAX_DAYS,
  recordOnboardingOffer,
} from "./onboarding-offer.js";

export const OnboardingAnswerArgs = z.strictObject({
  answer: z.enum(["later", "skip", "done", "offer_ready", "offer_shown"]),
  days: z.number().int().min(1).max(ONBOARDING_LATER_MAX_DAYS).optional(),
  offer_id: z.uuid().optional(),
});

export const onboardingAnswerTools = [
  {
    name: "onboarding_answer",
    description:
      "Report the user's answer to onboarding: later (defer), skip (declined), done (interview finished). " +
      "For delivery accounting, use offer_ready immediately before presenting any unsolicited offer if no user task is active. " +
      "Present only the returned offer to the user, then record it with offer_shown and offer_id. " +
      "In hosts that only display final replies, make that the first tool call on the next turn. " +
      "Do not record an offer you did not present.",
    inputSchema: {
      type: "object" as const,
      properties: {
        answer: { type: "string", enum: ["later", "skip", "done", "offer_ready", "offer_shown"] },
        offer_id: { type: "string", format: "uuid", description: "Only for offer_shown, from offer_ready" },
        days: {
          type: "integer",
          minimum: 1,
          maximum: ONBOARDING_LATER_MAX_DAYS,
          description: `later only; default ${ONBOARDING_LATER_DEFAULT_DAYS}`,
        },
      },
      required: ["answer"],
    },
  },
];

export async function onboardingAnswerHandler(
  deps: Pick<ToolDeps, "vaultPath"> & { vault: Pick<ToolDeps["vault"], "size"> },
  args: Record<string, unknown>
) {
  const { answer, days, offer_id: offerId } = OnboardingAnswerArgs.parse(args);
  if (answer !== "later" && days !== undefined) throw new Error("days applies only to answer later");
  if (answer === "offer_shown") {
    if (!offerId) throw new Error("offer_id is required for offer_shown");
    return { answer, recorded: await recordOnboardingOffer(deps.vaultPath, offerId) };
  }
  if (offerId) throw new Error("offer_id applies only to answer offer_shown");
  if (answer === "offer_ready") {
    const claim = await claimOnboardingOffer(deps.vaultPath, deps.vault.size());
    return { answer, offer: claim?.offer ?? null, ...(claim && { offer_id: claim.id }) };
  }
  if (answer === "later") {
    const { until } = await deferOnboarding(deps.vaultPath, days);
    return { answer, onboarding: "open", offered_again_after: until };
  }
  await markOnboardingDone(deps.vaultPath, answer === "skip" ? "session (skipped)" : "session");
  return { answer, onboarding: answer === "skip" ? "skipped" : "done" };
}
