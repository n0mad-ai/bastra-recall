/** #308/#1411: instruction and delivery regression controls, not host behavior certification. */
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { buildOnboardingBlock, ONBOARDING_BLOCK_TAG } from "../src/session-onboarding-block.js";
import { SESSION_CONTEXT_PARTS, tokensByPart } from "../src/session-lane.js";

const block = buildOnboardingBlock(true);

test("#308: an onboarded vault gets no block at all", () => {
  assert.equal(buildOnboardingBlock(false), "");
});

test("#308: a fresh vault gets the block, wrapped and framed like every other part", () => {
  assert.ok(block.startsWith(`\n<${ONBOARDING_BLOCK_TAG}>\n`), "leading newline is the part separator");
  assert.ok(block.endsWith(`</${ONBOARDING_BLOCK_TAG}>`));
});

test("#308: the judgement call that made it fail is gone", () => {
  // The exact phrasing measured as ignored in the test VM. If any of this
  // comes back, the model is being asked to decide again.
  assert.doesNotMatch(block, /natural moment/i);
  assert.doesNotMatch(block, /seems to be exploring/i);
  assert.doesNotMatch(block, /after the first task/i);
  assert.doesNotMatch(block, /Offer it ONCE/i);
});

test("#308: the block states the action and the moment instead of asking for a verdict", () => {
  assert.match(block, /RUN THE ONBOARDING INTERVIEW NOW/);
  assert.match(block, /When there is no active task, RUN THE ONBOARDING INTERVIEW NOW in your first response/);
  // The two escape hatches the old wording hid behind are named and closed.
  assert.match(block, /do not ask for permission first/i);
  assert.match(block, /do not wait for a better moment/i);
});

test("#308: the user can still decline — only the model's licence to decline for them is removed", () => {
  assert.match(block, /If the user declines or wants to do it later, accept that immediately/i);
  assert.match(block, /Declining is THEIR decision to make, not yours to make for them/);
  assert.match(block, /bastra onboard skip/);
});

test("#308: the interview itself is unchanged — nothing of substance was traded for the mandate", () => {
  // The seven questions, in order.
  for (const marker of ["(1)", "(2)", "(3)", "(4-6)", "(7)"]) {
    assert.ok(block.includes(marker), `question marker ${marker} survived`);
  }
  for (const persona of ["developer:", "business:", "personal:", "mixed:"]) {
    assert.ok(block.includes(persona), `persona follow-up ${persona} survived`);
  }
  // The side effects that make onboarding worth running at all.
  assert.match(block, /save_memory/);
  assert.match(block, /write_origin: "user-directed"/);
  assert.match(block, /bastra config set size\.guide <N>/);
  assert.match(block, /bastra config set language\.primary <code>/);
  assert.match(block, /bastra onboard done/);
  assert.match(block, /bastra import/);
});

test("#308: delivery stays measurable — the block is its own telemetry column", () => {
  // Nothing anywhere recorded that the block went out, which is why this class
  // of failure was only found by hand. `hint_tokens_by_part.onboarding` is the
  // record: non-zero exactly when the block was injected.
  assert.ok(SESSION_CONTEXT_PARTS.includes("onboarding"));
  assert.equal(tokensByPart({}).onboarding, 0);
  assert.equal(
    tokensByPart({ onboarding: block }).onboarding,
    Math.ceil(block.trimStart().length / 4),
  );
  assert.ok(tokensByPart({ onboarding: block }).onboarding > 0);
});

test("#1411: explicit work defers onboarding without adding questions to its deliverable", () => {
  assert.match(block, /If the user has given you a concrete task, complete that task without onboarding questions, offers or reminders in the task response/);
  assert.match(block, /Defer the interview to a later turn with no active task/);
  assert.match(block, /Deferral is not a decline: do not run `bastra onboard skip` or `bastra onboard done` for it/);
  assert.doesNotMatch(block, /before the user's request and before anything else/);
});

test("#1411: first use without active work still starts the interview immediately", () => {
  assert.match(block, /When there is no active task, RUN THE ONBOARDING INTERVIEW NOW in your first response/);
  assert.match(block, /then ask question \(1\) in the same response/);
});
