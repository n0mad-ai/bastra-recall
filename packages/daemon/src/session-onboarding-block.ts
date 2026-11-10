/**
 * Fresh-vault onboarding instructions (#308, #1411).
 * Concrete user work takes priority; without active work the interview starts
 * immediately. The agent interprets task intent, without matching user wording.
 * Deferral leaves onboarding pending and does not alter rule delivery.
 * These instructions and their delivery telemetry do not certify host behavior.
 */

/** The XML-ish tag the block is wrapped in — shared with the token accounting
 *  and the tests, so a rename cannot silently drift apart from them. */
export const ONBOARDING_BLOCK_TAG = "vault-onboarding";

/**
 * The block, or `""` when this vault has already been onboarded (or is too
 * large to count as fresh). The leading newline is framing, matching every
 * other part of the session block.
 */
export function buildOnboardingBlock(onboardingNeeded: boolean): string {
  if (!onboardingNeeded) return "";
  return (
    `\n<${ONBOARDING_BLOCK_TAG}>\n` +
    `This vault is fresh and the onboarding interview has never run for it. Both facts are ` +
    `already established. If the user has given you a concrete task, complete that task ` +
    `without onboarding questions, offers or reminders in the task response. Defer the ` +
    `interview to a later turn with no active task. Deferral is not a decline: do not run ` +
    `\`bastra onboard skip\` or \`bastra onboard done\` for it. ` +
    `When there is no active task, RUN THE ONBOARDING INTERVIEW NOW in your first response: ` +
    `open with one sentence saying the memory is empty and that ~5 minutes of questions ` +
    `will seed it, then ask question (1) in the same response — do not ask for permission ` +
    `first and do not wait for a better moment. ` +
    `If the user declines or wants to do it later, accept that immediately, run ` +
    `\`bastra onboard skip\`, and carry on with their request. Declining is THEIR decision to ` +
    `make, not yours to make for them. Interview ` +
    `adaptively — one question at a time, follow up where an answer is thin, let them skip ` +
    `anything: (1) what the memory will mainly hold — code & projects / company & decisions / ` +
    `personal life & knowledge / a mix; (2) how to address them — name, language, tone; ` +
    `(3) hard always/never rules; (4-6) persona follow-ups (developer: stack, active projects, ` +
    `workflow, coding conventions — file-size guide value in lines + which folder holds what · ` +
    `business: company & role, key people, what to prepare or watch · personal: ` +
    `day-to-day world, never-forget items, current goals · mixed: stack, role, world); ` +
    `(7) anything else, freeform. Save each answer immediately via save_memory — the user ` +
    `answered in person, so write_origin: "user-directed", concrete recall_when triggers ` +
    `including an ask-trigger in the user's own words. If they name a file-size guide value, ` +
    `ALSO run \`bastra config set size.guide <N>\` — the PreToolUse hook then enforces it ` +
    `deterministically. If you can tell the user's primary language (from how they answer, or ` +
    `an explicit "in <language>"), ALSO run \`bastra config set language.primary <code>\` ` +
    `(2-letter ISO code) so future memories get authored in it. When finished run \`bastra onboard done\`; ` +
    `if the user declines run \`bastra onboard skip\` and never bring it up again. Also mention ` +
    `\`bastra import\` if they have memories in other AI tools.\n` +
    `</${ONBOARDING_BLOCK_TAG}>`
  );
}
