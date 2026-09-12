/**
 * #308 — the session onboarding block is an instruction, not an offer.
 *
 * Delivery was never the problem: `/hook/onboarding` answered `{"needed":true}`,
 * the hook was registered, and the full block arrived as `additionalContext`.
 * The interview still never ran, because the text asked the model to decide
 * whether now was "a natural moment" — a judgement it has no basis for, that
 * fails silently, and that nothing records.
 *
 * These tests pin the properties of the WORDING that the old text lacked. They
 * cannot (and do not claim to) prove that a given client acts on it — that is
 * the client's property, not ours. What they prove is that the block no longer
 * asks the model to make the call.
 *
 * Run: npx tsx --test packages/daemon/__tests__/session-onboarding-block.test.ts
 */
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
  assert.match(block, /FIRST thing you do in this session/);
  assert.match(block, /in your first response/i);
  assert.match(block, /before the user's request and before anything else/i);
  // The two escape hatches the old wording hid behind are named and closed.
  assert.match(block, /do not ask for permission first/i);
  assert.match(block, /do not wait for a better moment/i);
  assert.match(block, /do not re-evaluate whether now is a good moment/i);
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
