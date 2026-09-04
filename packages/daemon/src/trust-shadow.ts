/**
 * #160 — usage-driven trust multiplier, SHADOW first (same discipline as the
 * salience lane in #217, which took its shape from this issue's plan).
 *
 * Computes how a per-memory trust factor WOULD have reordered a hit list,
 * without touching the hits that were served. The result rides along as an
 * optional `trust_shadow` field on the recall telemetry events and is judged
 * offline against recall_episodes — the issue's acceptance condition is
 * "shadow logs + eval comparison before any live ranking change".
 *
 * Modes via BASTRA_TRUST_RANK: `shadow` (default) | `off` | `live`.
 * `live` is not wired yet on purpose: it needs the usage aggregate inside the
 * recall path, and today nothing caches it there (`readUsage` is a file read,
 * called only by the curator and one UI endpoint). Shadow avoids the question
 * entirely by running after the response — see the call site.
 */
import { envFirst, envFloat } from "./env.js";
import { readUsage, type UsageAggregate, type UsageEntry } from "./usage-sidecar.js";

export type TrustRankMode = "off" | "shadow" | "live";

export interface TrustShadowHit {
  id: string;
  trust: number;
  rank: number;
  shadow_rank: number;
}

export interface TrustShadow {
  step: number;
  order_changed: boolean;
  hits: TrustShadowHit[];
}

export function trustRankMode(): TrustRankMode {
  const raw = (envFirst("BASTRA_TRUST_RANK") ?? "shadow").toLowerCase();
  return raw === "off" || raw === "live" ? raw : "shadow";
}

/** The step. One surfaced-but-never-loaded hit moves trust down by twice this
 *  much (see `trustScore`); since #469 nothing moves it up — `acted_on` was
 *  the up-step and is a token-overlap proxy without a gradient. */
export function trustStep(): number {
  return Math.max(0, envFloat("BASTRA_TRUST_STEP", 0.02));
}

export const TRUST_FLOOR = 0.5;
export const TRUST_CEILING = 1;

/**
 * Trust for one memory, bounded [0.5, 1.0].
 *
 * `surfaced` without a matching `loaded` nudges down at twice the step — dead
 * weight has to sink, or a memory that surfaces constantly and is never opened
 * keeps its place forever (#160). The up-step on `acted_on` is gone (#469):
 * the proxy fires on two shared tokens and closed three unrelated memories on
 * one Bash call, so the 21.08. shadow result (11 higher / 4 lower, p ≈ 0.12)
 * rested on it. Opening a hit already neutralises its "ignored" count; that
 * is the one engagement signal with a defined meaning.
 *
 * WHY THE CEILING IS THE NEUTRAL VALUE, not the middle: a memory with no
 * history at all scores exactly 1.0 and is therefore ranked exactly as it is
 * today. Starting everyone at 0.75 and letting engagement climb would penalise
 * every memory saved this week for the sin of being new — the multiplier would
 * encode age, not trust. So this factor can only ever demote. That also makes
 * the live-mode blast radius small enough to reason about: no memory can be
 * pushed above where the fusion already put it.
 *
 * `surfaced - loaded` is the "shown and ignored" count. It is clamped at zero
 * because loaded can exceed surfaced legitimately — a direct `load_memory` by
 * id never surfaced first (#77), and that is not evidence against the memory.
 */
export function trustScore(entry: UsageEntry | undefined, step: number = trustStep()): number {
  if (!entry) return TRUST_CEILING;
  const surfaced = entry.surfaced ?? 0;
  const loaded = entry.loaded ?? 0;
  const ignored = Math.max(0, surfaced - loaded);
  const raw = TRUST_CEILING - 2 * step * ignored;
  return Math.min(TRUST_CEILING, Math.max(TRUST_FLOOR, raw));
}

/**
 * The usage aggregate for shadow logging: read synchronously from a cache,
 * refreshed in the background.
 *
 * `readUsage` is a file read, and the recall path has no usage cache (its only
 * callers are the curator and one UI endpoint). Two shapes were possible and
 * the obvious one is wrong:
 *
 *   - `await readUsage()` inside the fire-and-forget. Costs the caller no
 *     latency, but the telemetry event is then written one file read LATER
 *     than it is today. In a long-lived daemon that is invisible; in a
 *     short-lived CLI process the event can lose the race with exit. A
 *     diagnostics lane must not make the record it writes less likely.
 *   - this one: the projection reads whatever is cached, synchronously, and
 *     kicks off a refresh that lands for the next recall. The logging stays
 *     exactly as immediate as before.
 *
 * The cost is that the shadow can lag one recall behind. For a projection
 * judged offline in aggregate that is not a defect worth a race for — and the
 * very first recall after start has no aggregate at all, which simply means no
 * shadow that once.
 *
 * Failure is silent and leaves the cache empty: an empty aggregate scores every
 * hit at the ceiling, and `computeTrustShadow` then logs nothing at all.
 */
let usageCache: { at: number; vaultPath: string; usage: UsageAggregate } | null = null;
let usageRefreshInFlight = false;
const USAGE_CACHE_MS = 10_000;

/** The cached aggregate, or an empty one when nothing has been read yet. */
export function usageForShadow(vaultPath: string, now: number = Date.now()): UsageAggregate {
  const fresh =
    usageCache !== null && usageCache.vaultPath === vaultPath && now - usageCache.at < USAGE_CACHE_MS;
  if (!fresh && !usageRefreshInFlight) {
    usageRefreshInFlight = true;
    void readUsage(vaultPath)
      .then((usage) => {
        usageCache = { at: Date.now(), vaultPath, usage };
      })
      .catch(() => {
        /* a diagnostics lane never breaks the call it observes */
      })
      .finally(() => {
        usageRefreshInFlight = false;
      });
  }
  return usageCache?.vaultPath === vaultPath ? usageCache.usage : {};
}

/** Test seam — drops the cached aggregate so a case can stage its own. */
export function resetUsageShadowCache(): void {
  usageCache = null;
  usageRefreshInFlight = false;
}

/** Test seam — installs an aggregate without touching the disk. */
export function primeUsageShadowCache(vaultPath: string, usage: UsageAggregate): void {
  usageCache = { at: Date.now(), vaultPath, usage };
}

/**
 * The would-be order under the trust multiplier, or `undefined` when there is
 * nothing to log: not in shadow mode, no hits, a zero step, or no hit carries
 * a trust below the ceiling (every-hit-at-1.0 would only ever log identity).
 *
 * Ties keep the live order — the sort is stable, so a shadow run that changes
 * nothing reports `order_changed: false` rather than shuffling equal scores.
 */
export function computeTrustShadow(
  hits: { id: string; score: number }[],
  resolveUsage: (id: string) => UsageEntry | undefined,
  step: number = trustStep(),
): TrustShadow | undefined {
  if (trustRankMode() !== "shadow") return undefined;
  if (hits.length === 0 || step <= 0) return undefined;

  const scored = hits.map((h, i) => {
    const trust = trustScore(resolveUsage(h.id), step);
    return { id: h.id, trust, rank: i + 1, shadow_score: h.score * trust };
  });
  if (!scored.some((h) => h.trust < TRUST_CEILING)) return undefined;

  const shadowRank = new Map(
    [...scored].sort((a, b) => b.shadow_score - a.shadow_score).map((h, i) => [h.id, i + 1] as const),
  );
  const out: TrustShadowHit[] = scored.map((h) => ({
    id: h.id,
    trust: Number(h.trust.toFixed(4)),
    rank: h.rank,
    shadow_rank: shadowRank.get(h.id) ?? h.rank,
  }));
  return {
    step,
    order_changed: out.some((h) => h.rank !== h.shadow_rank),
    hits: out,
  };
}
