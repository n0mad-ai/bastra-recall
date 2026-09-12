/**
 * The `<vault-onboarding>` part of the session-start block (#308).
 *
 * Split out of `session-lane.ts` (file-size convention): the assembly of this
 * one part is a self-contained piece of instruction text with its own
 * reasoning and its own regression tests, and the lane only needs to know
 * whether onboarding is pending.
 *
 * ─── Why the wording is what it is ────────────────────────────────────────
 *
 * The block used to say: "Offer it ONCE at a natural moment (e.g. after the
 * first task, or right away if the user seems to be exploring)."
 *
 * Measured on a fresh vault in the test VM, every delivery step was correct —
 * `/hook/onboarding` answered `{"needed":true}`, the SessionStart hook was
 * registered, and feeding it directly returned the full block, which then
 * arrived as `additionalContext`. The interview still never happened: the user
 * typed "moin", got "Moin! Was steht an?", and that was the end of it.
 *
 * The wording was the bug. It handed the model a judgement call it has no
 * basis for — what counts as a natural moment, whether a greeting means the
 * user is "exploring", whether now is too early. The model decided no, and
 * nothing records a decline, so there is no second chance either.
 *
 * Neither half of the condition is actually a judgement call. A session is
 * starting, and this vault has never been onboarded. Both facts are settled
 * before the model sees a single token. So the instruction names the action
 * and the moment instead of asking for a verdict on them — the same shape as
 * the import-review part of the block ("tell the user in your FIRST response
 * of this session"), which is the one standing instruction here that is
 * observably carried out.
 *
 * The user can still decline, and `bastra onboard skip` is still the way out.
 * What is removed is the model's licence to decline on the user's behalf.
 *
 * ─── The honest limit ─────────────────────────────────────────────────────
 *
 * This is the strongest form the INSTRUCTION can take, and that is all it is.
 * Whether a client acts on injected context is a property of the client, not
 * of this text, and no wording makes it deterministic. On the hookless path
 * (Claude Desktop, Cursor) the block does not even reach the model until the
 * session's first bastra tool call — if the session never calls one, nothing
 * was ever delivered to ignore.
 *
 * What IS deterministic, and is measured: delivery. The session telemetry
 * records `hint_tokens_by_part.onboarding`, which is non-zero exactly when
 * this block went out.
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
    `already established — do not re-evaluate whether now is a good moment. RUN THE ONBOARDING ` +
    `INTERVIEW NOW: make it the FIRST thing you do in this session, in your first response, ` +
    `before the user's request and before anything else. Open with one sentence saying the ` +
    `memory is empty and that ~5 minutes of questions will seed it, then ask question (1) in ` +
    `the same response — do not ask for permission first and do not wait for a better moment. ` +
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
