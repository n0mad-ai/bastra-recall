/**
 * Fresh-vault onboarding instructions (#308, #1411).
 * Concrete user work takes priority; without active work the interview starts
 * immediately. The agent interprets task intent, without matching user wording.
 * Deferral leaves onboarding pending and does not alter rule delivery.
 * #1595: started at most once per session, and the opening sentence claims
 * only what the daemon knows (a new vault, not necessarily an empty one).
 * #1603: offered at most once a day and three times in all (onboarding-offer.ts),
 * then only the one-line mention below. The agent reports the user's answer
 * through onboarding_answer — "later" defers, "skip" ends it — without a shell
 * command to approve. Written for the model, so English (onboarding-words.ts).
 * These instructions and their delivery telemetry do not certify host behavior.
 */

/** The XML-ish tag the block is wrapped in — shared with the token accounting
 *  and the tests, so a rename cannot silently drift apart from them. */
export const ONBOARDING_BLOCK_TAG = "vault-onboarding";

/** #1690: an offer only counts once presented to the user. */
export const ONBOARDING_DELIVERY_TEXT =
  `If no concrete user task is active, first call onboarding_answer(answer:"offer_ready"). ` +
  `If it returns no offer or a different kind, do not present this unsolicited offer. ` +
  `After you actually present it in your reply, call onboarding_answer(answer:"offer_shown", offer_id:"<returned id>").`;

/** #1603: what remains after three interview offers — no question, one line. */
export const ONBOARDING_LINE_TEXT =
  `This vault is new and its setup interview is still open; it has been offered three times. ` +
  `Do not ask about it or start it yourself. At most once, add one short line to your first ` +
  `response that a ~5-minute setup is available whenever the user wants it. ${ONBOARDING_DELIVERY_TEXT} If the user asks ` +
  `for it, interview them one question at a time (what the memory will hold, how to address ` +
  `them, hard always/never rules, follow-ups), save each answer via save_memory with ` +
  `write_origin "user-directed", then call onboarding_answer(answer:"done"); if they decline ` +
  `it, call onboarding_answer(answer:"skip").`;

/**
 * The block, or `""` when this session gets no offer: the vault is onboarded
 * (or too large to count as fresh), or #1603 holds the offer back today.
 * `line` is the one-line mention after three interview offers. The leading
 * newline is framing, matching every other part of the session block.
 */
export function buildOnboardingBlock(onboardingNeeded: boolean, line = false): string {
  if (line) return `\n<${ONBOARDING_BLOCK_TAG}>\n${ONBOARDING_LINE_TEXT}\n</${ONBOARDING_BLOCK_TAG}>`;
  if (!onboardingNeeded) return "";
  return (
    `\n<${ONBOARDING_BLOCK_TAG}>\n` +
    `This vault is fresh and the onboarding interview has never run for it. Both facts are ` +
    `already established. If the user has given you a concrete task, complete that task ` +
    `without onboarding questions, offers or reminders in the task response. Defer the ` +
    `interview to a later turn with no active task. Deferral is not a decline: do not call ` +
    `onboarding_answer for it. ` +
    `When there is no active task, RUN THE ONBOARDING INTERVIEW NOW in your first response: ` +
    `open with one sentence saying the memory is new and that ~5 minutes of questions ` +
    `will seed it, then ask question (1) in the same response — do not ask for permission ` +
    `first and do not wait for a better moment. ${ONBOARDING_DELIVERY_TEXT} ` +
    `Start it at most once per session: if the user does not take it up, do not ask, offer ` +
    `or remind again in this session unless the user raises it. ` +
    `If the user declines or wants to do it later, accept that immediately and carry on with ` +
    `their request. Later is not never: for later call onboarding_answer(answer:"later"), with ` +
    `days:<N> when they name a time, and Recall asks again after it; for a decline call ` +
    `onboarding_answer(answer:"skip"). Declining is THEIR decision to ` +
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
    `(2-letter ISO code) so future memories get authored in it. When finished call ` +
    `onboarding_answer(answer:"done"); after a decline never bring it up again. Also mention ` +
    `\`bastra import\` if they have memories in other AI tools.\n` +
    `</${ONBOARDING_BLOCK_TAG}>`
  );
}
