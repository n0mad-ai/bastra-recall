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
  takeOnboardingOffer,
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

test("#1603: at most one offer per local day — further session starts that day get nothing", () =>
  vault(async (path) => {
    assert.equal(await takeOnboardingOffer(path, 0, start), "interview");
    assert.equal(await takeOnboardingOffer(path, 0, start + 60_000), null);
    assert.equal(await takeOnboardingOffer(path, 0, start + 11 * 60 * 60 * 1000), null, "23:00 the same day");
    assert.equal(await takeOnboardingOffer(path, 0, start + 12 * 60 * 60 * 1000 + 1000), "interview", "after midnight");
  }));

test("#1603: three interviews in all, then only the one-line mention, still once a day", () =>
  vault(async (path) => {
    const offers = [];
    for (let day = 0; day < 5; day++) {
      offers.push(await takeOnboardingOffer(path, 0, start + day * DAY));
      assert.equal(await takeOnboardingOffer(path, 0, start + day * DAY + 1000), null);
    }
    assert.equal(ONBOARDING_INTERVIEW_OFFERS, 3);
    assert.deepEqual(offers, ["interview", "interview", "interview", "line", "line"]);
  }));

test("#1603: simultaneous session starts share the one offer of the day", () =>
  vault(async (path) => {
    const offers = await Promise.all(Array.from({ length: 8 }, () => takeOnboardingOffer(path, 0, start)));
    assert.deepEqual(
      offers.filter((o) => o !== null),
      ["interview"]
    );
  }));

test("#1603: later defers every offer, keeps onboarding open and asks again after the deferral", () =>
  vault(async (path) => {
    assert.equal(await takeOnboardingOffer(path, 0, start), "interview");
    const result = await onboardingAnswerHandler({ vaultPath: path }, { answer: "later", days: 7 });
    assert.equal(result.onboarding, "open");
    assert.equal(await isOnboardingDone(path), false, "later is not skip");
    // The handler's clock is the real one; defer again on the test clock.
    await deferOnboarding(path, 7, start);
    for (let day = 1; day < 7; day++) assert.equal(await takeOnboardingOffer(path, 0, start + day * DAY), null);
    assert.equal(await takeOnboardingOffer(path, 0, start + 7 * DAY + 1000), "interview");
  }));

test("#1603: skip and done end onboarding; nothing is offered afterwards", () =>
  vault(async (path) => {
    assert.deepEqual(await onboardingAnswerHandler({ vaultPath: path }, { answer: "skip" }), {
      answer: "skip",
      onboarding: "skipped",
    });
    assert.equal(await isOnboardingDone(path), true);
    assert.equal(await takeOnboardingOffer(path, 0, start), null);
  }));

test("#1603: the answer is a closed set of fields; days only goes with later", () =>
  vault(async (path) => {
    await assert.rejects(onboardingAnswerHandler({ vaultPath: path }, { answer: "skip", days: 3 }), /days/);
    await assert.rejects(onboardingAnswerHandler({ vaultPath: path }, { answer: "nicht jetzt" }));
    await assert.rejects(onboardingAnswerHandler({ vaultPath: path }, { answer: "later", days: 0 }));
    assert.equal(await isOnboardingDone(path), false);
  }));

test("#1603: a damaged state file counts as never offered instead of blocking the session", () =>
  vault(async (path) => {
    await writeFile(join(path, ONBOARDING_OFFER_FILE), "{not json");
    assert.equal(await takeOnboardingOffer(path, 0, start), "interview");
    const saved = JSON.parse(await readFile(join(path, ONBOARDING_OFFER_FILE), "utf8"));
    assert.deepEqual(saved, { offers: 1, last_day: localDay(start) });
  }));

test("#1603: a vault that is no longer fresh gets no offer and no state file", () =>
  vault(async (path) => {
    assert.equal(await takeOnboardingOffer(path, 50, start), null);
    await assert.rejects(readFile(join(path, ONBOARDING_OFFER_FILE), "utf8"));
  }));
