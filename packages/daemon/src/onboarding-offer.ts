/**
 * #1603 (owner answer B): how often a fresh vault's setup interview is offered
 * across sessions. At most once per local calendar day and three times in
 * all; after that only a short one-line mention, also at most once a day.
 * "Later" only sets a deferral and leaves onboarding open; "skip" and "done"
 * still end it through the marker in onboarding.ts. The agent tells the two
 * apart from what the user said and reports it as a field — nothing here
 * reads user text.
 *
 * Session context only previews eligibility. A session with no task waiting
 * reserves an offer just before presenting it, then records its delivery.
 * A missing response or a skipped offer spends no slot.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { withPathLock } from "./path-lock.js";
import { isOnboardingDone, isOnboardingNeeded, ONBOARDING_OFFER_FILE } from "./onboarding.js";

export { ONBOARDING_OFFER_FILE } from "./onboarding.js";
/** Full interview offers before only the one-line mention remains. */
export const ONBOARDING_INTERVIEW_OFFERS = 3;
/** Deferral after "later" when the user names no time. */
export const ONBOARDING_LATER_DEFAULT_DAYS = 3;
export const ONBOARDING_LATER_MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
// Bound an interrupted presentation without spending its daily offer.
const OFFER_CLAIM_MS = 2 * 60_000;
const OFFER_LOCK = { crossProcess: true, requireLock: true } as const;

/** What this session start gets: the interview, the one-line mention, or nothing. */
export type OnboardingOffer = "interview" | "line" | null;

interface OfferState {
  /** Offers delivered so far, interview and line alike. */
  offers: number;
  /** Local calendar day (YYYY-MM-DD) of the last offer. */
  last_day?: string;
  /** Epoch ms until which a "later" answer holds every offer back. */
  later_until?: number;
  pending?: { id: string; until: number };
}

/** The user's day, not UTC: "once a day" ends at their midnight. */
export function localDay(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function statePath(vaultPath: string): string {
  return join(vaultPath, ONBOARDING_OFFER_FILE);
}

/** The file is in the user's vault and may be edited or damaged: anything
 *  unreadable counts as "never offered" rather than blocking the session. */
async function readState(path: string): Promise<OfferState> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const offers = Number.isSafeInteger(raw.offers) && (raw.offers as number) > 0 ? (raw.offers as number) : 0;
    const pending = raw.pending as { id?: unknown; until?: unknown } | undefined;
    return {
      offers,
      ...(pending &&
      typeof pending.id === "string" &&
      typeof pending.until === "number" &&
      Number.isFinite(pending.until)
        ? { pending: { id: pending.id, until: pending.until } }
        : {}),
      ...(typeof raw.last_day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.last_day)
        ? { last_day: raw.last_day }
        : {}),
      ...(Number.isFinite(raw.later_until) ? { later_until: raw.later_until as number } : {}),
    };
  } catch {
    return { offers: 0 };
  }
}

/** tmp + rename: a crash mid-write leaves the old state, never a torn file. */
async function writeState(path: string, state: OfferState): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(state) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

function eligibleOffer(state: OfferState, now: number): OnboardingOffer {
  if ((state.later_until ?? 0) > now || state.last_day === localDay(now) || (state.pending?.until ?? 0) > now)
    return null;
  return state.offers < ONBOARDING_INTERVIEW_OFFERS ? "interview" : "line";
}

/** Preparing a context has no effect on the offer counter. */
export async function previewOnboardingOffer(
  vaultPath: string,
  size: number,
  now = Date.now()
): Promise<OnboardingOffer> {
  if (!(await isOnboardingNeeded(vaultPath, size))) return null;
  return eligibleOffer(await readState(statePath(vaultPath)), now);
}

export async function claimOnboardingOffer(vaultPath: string, size: number, now = Date.now()) {
  const path = statePath(vaultPath);
  return withPathLock(
    path,
    async () => {
      if (!(await isOnboardingNeeded(vaultPath, size))) return null;
      const state = await readState(path);
      const offer = eligibleOffer(state, now);
      if (offer === null) return null;
      const id = randomUUID();
      await writeState(path, { ...state, pending: { id, until: now + OFFER_CLAIM_MS } });
      return { offer, id };
    },
    OFFER_LOCK
  );
}

/** A receipt can arrive on the next user turn, after the reservation's
 * short exclusivity window. Charge the day of the offer, once, and accept
 * only the last reservation so an older client cannot override a newer one. */
export async function recordOnboardingOffer(vaultPath: string, id: string, now = Date.now()): Promise<boolean> {
  const path = statePath(vaultPath);
  return withPathLock(
    path,
    async () => {
      if (await isOnboardingDone(vaultPath)) return false;
      const { pending, ...state } = await readState(path);
      if (pending?.id !== id) return false;
      const offerDay = localDay(Math.min(now, pending.until - OFFER_CLAIM_MS));
      if (state.last_day && state.last_day >= offerDay) return false;
      await writeState(path, { ...state, offers: state.offers + 1, last_day: offerDay });
      return true;
    },
    OFFER_LOCK
  );
}

/** "Later": hold every offer back for `days` (whole days, 1 to 90). Onboarding
 *  stays open, and the count of offers made so far is kept. */
export async function deferOnboarding(
  vaultPath: string,
  days = ONBOARDING_LATER_DEFAULT_DAYS,
  now = Date.now()
): Promise<{ until: string }> {
  if (!Number.isInteger(days) || days < 1 || days > ONBOARDING_LATER_MAX_DAYS)
    throw new Error(`days must be a whole number from 1 to ${ONBOARDING_LATER_MAX_DAYS}`);
  const path = statePath(vaultPath);
  const until = now + days * DAY_MS;
  await withPathLock(
    path,
    async () => {
      const state = await readState(path);
      delete state.pending;
      await writeState(path, { ...state, later_until: until });
    },
    OFFER_LOCK
  );
  return { until: new Date(until).toISOString() };
}
