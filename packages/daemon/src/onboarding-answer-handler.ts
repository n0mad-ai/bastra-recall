/**
 * #1603: the agent reports the user's answer to the setup interview offer.
 * The agent understands what the user said, in any language; Recall never
 * reads the user's words. A tool instead of `bastra onboard skip|done`, so
 * the answer needs no shell command the user would have to approve.
 */
import { z } from "zod";
import type { ToolDeps } from "./tool-deps.js";
import { markOnboardingDone } from "./onboarding.js";
import { deferOnboarding, ONBOARDING_LATER_DEFAULT_DAYS, ONBOARDING_LATER_MAX_DAYS } from "./onboarding-offer.js";

export const OnboardingAnswerArgs = z.strictObject({
  answer: z.enum(["later", "skip", "done"]),
  days: z.number().int().min(1).max(ONBOARDING_LATER_MAX_DAYS).optional(),
});

export const onboardingAnswerTools = [
  {
    name: "onboarding_answer",
    description:
      "The user's answer to the <vault-onboarding> offer, never your own: later (stays open, asked again after days), skip (declined), done (interview finished).",
    inputSchema: {
      type: "object" as const,
      properties: {
        answer: { type: "string", enum: ["later", "skip", "done"] },
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

export async function onboardingAnswerHandler(deps: Pick<ToolDeps, "vaultPath">, args: Record<string, unknown>) {
  const { answer, days } = OnboardingAnswerArgs.parse(args);
  if (answer === "later") {
    const { until } = await deferOnboarding(deps.vaultPath, days);
    return { answer, onboarding: "open", offered_again_after: until };
  }
  if (days !== undefined) throw new Error("days applies only to answer later");
  await markOnboardingDone(deps.vaultPath, answer === "skip" ? "session (skipped)" : "session");
  return { answer, onboarding: answer === "skip" ? "skipped" : "done" };
}
