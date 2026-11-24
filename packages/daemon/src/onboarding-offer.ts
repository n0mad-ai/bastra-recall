/**
 * #1603 (owner answer B): how often a fresh vault's setup interview is offered
 * across sessions. At most once per local calendar day and three times in
 * all; after that only a short one-line mention, also at most once a day.
 * "Later" only sets a deferral and leaves onboarding open; "skip" and "done"
 * still end it through the marker in onboarding.ts. The agent tells the two
 * apart from what the user said and reports it as a field — nothing here
 * reads user text.
 *
 * The state sits beside the marker at the vault root. Every offer is counted
 * where the session block is assembled, so a session that receives no block
 * (the same day, or inside a deferral) costs nothing.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { withPathLock } from "./path-lock.js";
import { isOnboardingNeeded } from "./onboarding.js";

export const ONBOARDING_OFFER_FILE = ".onboarding-offers.json";
/** Full interview offers before only the one-line mention remains. */
export const ONBOARDING_INTERVIEW_OFFERS = 3;
/** Deferral after "later" when the user names no time. */
export const ONBOARDING_LATER_DEFAULT_DAYS = 3;
export const ONBOARDING_LATER_MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What this session start gets: the interview, the one-line mention, or nothing. */
export type OnboardingOffer = "interview" | "line" | null;

interface OfferState {
  /** Offers delivered so far, interview and line alike. */
  offers: number;
  /** Local calendar day (YYYY-MM-DD) of the last offer. */
  last_day?: string;
  /** Epoch ms until which a "later" answer holds every offer back. */
  later_until?: number;
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
    return {
      offers,
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

/**
 * Decides this session start's offer and counts it in the same step. Two
 * session starts at once get one offer between them; the lock also covers an
 * answer recorded by a stdio MCP server, which is another process.
 */
export async function takeOnboardingOffer(
  vaultPath: string,
  vaultSize: number,
  now = Date.now()
): Promise<OnboardingOffer> {
  if (!(await isOnboardingNeeded(vaultPath, vaultSize))) return null;
  const path = statePath(vaultPath);
  return withPathLock(
    path,
    async () => {
      const state = await readState(path);
      const today = localDay(now);
      if (state.later_until !== undefined && now < state.later_until) return null;
      if (state.last_day === today) return null;
      const offer: OnboardingOffer = state.offers < ONBOARDING_INTERVIEW_OFFERS ? "interview" : "line";
      await writeState(path, { offers: state.offers + 1, last_day: today });
      return offer;
    },
    { crossProcess: true }
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
  await withPathLock(path, async () => writeState(path, { ...(await readState(path)), later_until: until }), {
    crossProcess: true,
  });
  return { until: new Date(until).toISOString() };
}
