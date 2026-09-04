/**
 * #160 — the trust multiplier's arithmetic and its shadow projection.
 *
 * Runner: `tsx --test __tests__/trust-shadow.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeTrustShadow,
  trustRankMode,
  trustScore,
  TRUST_CEILING,
  TRUST_FLOOR,
} from "../src/trust-shadow.js";
import type { UsageEntry } from "../src/usage-sidecar.js";

const entry = (surfaced: number, loaded: number, acted_on: number): UsageEntry => ({
  surfaced,
  loaded,
  acted_on,
});

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev = new Map(Object.keys(vars).map((k) => [k, process.env[k]] as const));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── the score ───────────────────────────────────────────────────────────────

test("#160: a memory with no history is neutral, not suspect", () => {
  // The whole reason the ceiling is the neutral value: everything saved this
  // week would otherwise carry a malus for being new.
  assert.equal(trustScore(undefined), TRUST_CEILING);
  assert.equal(trustScore(entry(0, 0, 0)), TRUST_CEILING);
});

test("#160: shown and never opened sinks; opening neutralises it", () => {
  const step = 0.02;
  // Ten times in front of the user, never opened: 10 × 2 × 0.02 off the top.
  assert.equal(trustScore(entry(10, 0, 0), step), 0.6);
  // Same exposure, but every hit was opened — nothing was ignored.
  assert.equal(trustScore(entry(10, 10, 0), step), TRUST_CEILING);
});

test("#469: acted_on does not move trust — the proxy has no gradient", () => {
  const step = 0.02;
  // Ignored five times: 5 × 0.04 down, whatever acted_on says.
  assert.equal(Number(trustScore(entry(5, 0, 0), step).toFixed(4)), 0.8);
  assert.equal(Number(trustScore(entry(5, 0, 4), step).toFixed(4)), 0.8);
  assert.equal(Number(trustScore(entry(5, 0, 400), step).toFixed(4)), 0.8);
});

test("#160: bounded on both ends", () => {
  assert.equal(trustScore(entry(10_000, 0, 0)), TRUST_FLOOR);
  assert.equal(trustScore(entry(0, 0, 10_000)), TRUST_CEILING);
});

test("#160: a direct load without a prior surface is not evidence against a memory", () => {
  // load_memory by id never surfaced first (#77). `surfaced - loaded` would go
  // negative and, unclamped, would hand out trust above the ceiling.
  assert.equal(trustScore(entry(0, 5, 0)), TRUST_CEILING);
  assert.equal(trustScore(entry(2, 9, 0)), TRUST_CEILING);
});

// ── the shadow projection ───────────────────────────────────────────────────

const usageOf =
  (map: Record<string, UsageEntry>) =>
  (id: string): UsageEntry | undefined =>
    map[id];

test("#160: shadow reports the reorder without touching the served hits", () => {
  withEnv({ BASTRA_TRUST_RANK: "shadow", BASTRA_TRUST_STEP: undefined }, () => {
    const hits = [
      { id: "ignored", score: 100 },
      { id: "solid", score: 95 },
    ];
    const shadow = computeTrustShadow(
      hits,
      usageOf({ ignored: entry(20, 0, 0), solid: entry(5, 5, 3) }),
    );
    assert.ok(shadow, "a hit below the ceiling must produce a shadow");
    assert.equal(shadow.order_changed, true);
    // 100 × 0.6 = 60 against 95 × 1.0 — the ignored memory drops behind.
    assert.deepEqual(
      shadow.hits.map((h) => [h.id, h.rank, h.shadow_rank]),
      [
        ["ignored", 1, 2],
        ["solid", 2, 1],
      ],
    );
    // The input list is untouched: shadow mode serves what it served.
    assert.deepEqual(hits.map((h) => h.id), ["ignored", "solid"]);
  });
});

test("#160: nothing to say when every hit is at the ceiling", () => {
  withEnv({ BASTRA_TRUST_RANK: "shadow" }, () => {
    const shadow = computeTrustShadow(
      [{ id: "a", score: 10 }],
      usageOf({ a: entry(3, 3, 1) }),
    );
    assert.equal(shadow, undefined, "logging identity is noise, not a measurement");
  });
});

test("#160: a demotion that does not reorder still logs, and says so", () => {
  withEnv({ BASTRA_TRUST_RANK: "shadow" }, () => {
    // The low-trust hit is last already — the multiplier confirms the order.
    const shadow = computeTrustShadow(
      [
        { id: "top", score: 100 },
        { id: "ignored", score: 10 },
      ],
      usageOf({ top: entry(2, 2, 0), ignored: entry(20, 0, 0) }),
    );
    assert.ok(shadow);
    assert.equal(shadow.order_changed, false);
  });
});

test("#160: off and live produce no shadow", () => {
  for (const mode of ["off", "live"]) {
    withEnv({ BASTRA_TRUST_RANK: mode }, () => {
      assert.equal(trustRankMode(), mode);
      assert.equal(
        computeTrustShadow([{ id: "a", score: 10 }], usageOf({ a: entry(20, 0, 0) })),
        undefined,
        `${mode} must not log a would-be order`,
      );
    });
  }
});

test("#160: shadow is the default, and a bad value falls back to it", () => {
  withEnv({ BASTRA_TRUST_RANK: undefined }, () => assert.equal(trustRankMode(), "shadow"));
  withEnv({ BASTRA_TRUST_RANK: "LIVE" }, () => assert.equal(trustRankMode(), "live"));
  withEnv({ BASTRA_TRUST_RANK: "nonsense" }, () => assert.equal(trustRankMode(), "shadow"));
});

test("#160: a zero step is the kill switch", () => {
  withEnv({ BASTRA_TRUST_RANK: "shadow", BASTRA_TRUST_STEP: "0" }, () => {
    assert.equal(trustScore(entry(50, 0, 0)), TRUST_CEILING);
    assert.equal(
      computeTrustShadow([{ id: "a", score: 10 }], usageOf({ a: entry(50, 0, 0) })),
      undefined,
    );
  });
});
