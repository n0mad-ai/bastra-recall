/**
 * #1603 (owner answer B): the setup interview is offered at most once a day
 * and three times in all, then only as one line; "later" defers it without
 * ending onboarding; "skip" and "done" end it. The answer arrives as a field
 * from the agent (onboarding_answer), never from the user's words.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/onboarding-offer.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimOnboardingOffer,
  previewOnboardingOffer,
  recordOnboardingOffer,
  deferOnboarding,
  localDay,
  ONBOARDING_OFFER_FILE,
  ONBOARDING_INTERVIEW_OFFERS,
} from "../src/onboarding-offer.js";
import { onboardingAnswerHandler } from "../src/onboarding-answer-handler.js";
import { isOnboardingDone } from "../src/onboarding.js";

const DAY = 24 * 60 * 60 * 1000;
/** Local noon on 1 March 2027: day arithmetic never crosses a DST switch here. */
const start = new Date(2027, 2, 1, 12, 0, 0).getTime();

async function vault(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-1603-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function deps(path: string) {
  return { vaultPath: path, vault: { size: () => 0 } };
}

async function displayOffer(path: string, size: number, now: number) {
  const claim = await claimOnboardingOffer(path, size, now);
  if (claim === null) return null;
  assert.equal(await recordOnboardingOffer(path, claim.id, now), true);
  return claim.offer;
}

test("#1603: at most one offer per local day — further session starts that day get nothing", () =>
  vault(async (path) => {
    assert.equal(await displayOffer(path, 0, start), "interview");
    assert.equal(await displayOffer(path, 0, start + 60_000), null);
    assert.equal(await displayOffer(path, 0, start + 11 * 60 * 60 * 1000), null, "23:00 the same day");
    assert.equal(await displayOffer(path, 0, start + 12 * 60 * 60 * 1000 + 1000), "interview", "after midnight");
  }));

test("#1603: three interviews in all, then only the one-line mention, still once a day", () =>
  vault(async (path) => {
    const offers = [];
    for (let day = 0; day < 5; day++) {
      offers.push(await displayOffer(path, 0, start + day * DAY));
      assert.equal(await displayOffer(path, 0, start + day * DAY + 1000), null);
    }
    assert.equal(ONBOARDING_INTERVIEW_OFFERS, 3);
    assert.deepEqual(offers, ["interview", "interview", "interview", "line", "line"]);
  }));

test("#1690: simultaneous sessions can prepare context but only one can claim the visible offer", () =>
  vault(async (path) => {
    assert.deepEqual(await Promise.all(Array.from({ length: 4 }, () => previewOnboardingOffer(path, 0, start))), [
      "interview",
      "interview",
      "interview",
      "interview",
    ]);
    await assert.rejects(readFile(join(path, ONBOARDING_OFFER_FILE), "utf8"), { code: "ENOENT" });
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimOnboardingOffer(path, 0, start)));
    const valid = claims.filter((claim) => claim !== null);
    assert.equal(valid.length, 1);
    assert.equal(await recordOnboardingOffer(path, valid[0].id, start), true);
    assert.equal(await recordOnboardingOffer(path, valid[0].id, start), false);
  }));

test("#1690: a lost reservation doesn't charge an interview and a later delivery can book it", () =>
  vault(async (path) => {
    const lost = await claimOnboardingOffer(path, 0, start);
    assert.ok(lost);
    const next = await claimOnboardingOffer(path, 0, start + 2 * 60_000);
    assert.ok(next);
    assert.equal(await recordOnboardingOffer(path, lost.id, start + 2 * 60_000), false);
    assert.equal(await recordOnboardingOffer(path, next.id, start + 2 * 60_000), true);
    assert.equal(JSON.parse(await readFile(join(path, ONBOARDING_OFFER_FILE), "utf8")).offers, 1);
  }));

test("#1690: a pending offer cannot spend a slot after skip and stale previews cannot start an offer", () =>
  vault(async (path) => {
    const claim = await onboardingAnswerHandler(deps(path), { answer: "offer_ready" });
    if (claim.answer !== "offer_ready") assert.fail("Unexpected onboarding answer");
    assert.equal(claim.offer, "interview");
    assert.ok(claim.offer_id);
    await onboardingAnswerHandler(deps(path), { answer: "skip" });
    assert.deepEqual(await onboardingAnswerHandler(deps(path), { answer: "offer_ready" }), {
      answer: "offer_ready",
      offer: null,
    });
    assert.deepEqual(await onboardingAnswerHandler(deps(path), { answer: "offer_shown", offer_id: claim.offer_id }), {
      answer: "offer_shown",
      recorded: false,
    });
  }));

test("#1690: an offer in a final reply can be acknowledged on the next user turn", () =>
  vault(async (path) => {
    const claim = await claimOnboardingOffer(path, 0, start);
    assert.ok(claim);
    // The user has taken longer than the claim window to answer.
    assert.equal(await recordOnboardingOffer(path, claim.id, start + DAY), true);
    const saved = JSON.parse(await readFile(join(path, ONBOARDING_OFFER_FILE), "utf8"));
    assert.deepEqual(saved, { offers: 1, last_day: localDay(start) });
    assert.equal(await recordOnboardingOffer(path, claim.id, start + DAY), false);
    assert.equal(await previewOnboardingOffer(path, 0, start + DAY), "interview");
  }));

test("#1603: later defers every offer, keeps onboarding open and asks again after the deferral", () =>
  vault(async (path) => {
    assert.equal(await displayOffer(path, 0, start), "interview");
    const result = await onboardingAnswerHandler(deps(path), { answer: "later", days: 7 });
    assert.equal(result.onboarding, "open");
    assert.equal(await isOnboardingDone(path), false, "later is not skip");
    // The handler's clock is the real one; defer again on the test clock.
    await deferOnboarding(path, 7, start);
    for (let day = 1; day < 7; day++) assert.equal(await displayOffer(path, 0, start + day * DAY), null);
    assert.equal(await displayOffer(path, 0, start + 7 * DAY + 1000), "interview");
  }));

test("#1603: skip and done end onboarding; nothing is offered afterwards", () =>
  vault(async (path) => {
    assert.deepEqual(await onboardingAnswerHandler(deps(path), { answer: "skip" }), {
      answer: "skip",
      onboarding: "skipped",
    });
    assert.equal(await isOnboardingDone(path), true);
    assert.equal(await displayOffer(path, 0, start), null);
  }));

test("#1603: the answer is a closed set of fields; days only goes with later", () =>
  vault(async (path) => {
    await assert.rejects(onboardingAnswerHandler(deps(path), { answer: "skip", days: 3 }), /days/);
    await assert.rejects(onboardingAnswerHandler(deps(path), { answer: "nicht jetzt" }));
    await assert.rejects(onboardingAnswerHandler(deps(path), { answer: "later", days: 0 }));
    assert.equal(await isOnboardingDone(path), false);
  }));

test("#1603: a damaged state file counts as never offered instead of blocking the session", () =>
  vault(async (path) => {
    await writeFile(join(path, ONBOARDING_OFFER_FILE), "{not json");
    assert.equal(await displayOffer(path, 0, start), "interview");
    const saved = JSON.parse(await readFile(join(path, ONBOARDING_OFFER_FILE), "utf8"));
    assert.deepEqual(saved, { offers: 1, last_day: localDay(start) });
  }));

test("#1603: a vault that is no longer fresh gets no offer and no state file", () =>
  vault(async (path) => {
    assert.equal(await displayOffer(path, 50, start), null);
    await assert.rejects(readFile(join(path, ONBOARDING_OFFER_FILE), "utf8"));
  }));
