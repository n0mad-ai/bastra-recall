/**
 * Tests für den Salience-Shadow (#217): would-be-Reihenfolge unter dem
 * begrenzten Multiplikator, ohne die servierten Hits anzufassen. Default-
 * Modus ist `shadow`; `off`/`live` liefern kein Shadow-Feld.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/salience-shadow.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSalienceShadow } from "../src/salience-shadow.js";

const fmMap = (m: Record<string, Record<string, unknown>>) => (id: string) => m[id];

test("shadow: high-salience hit would outrank, live hits untouched", () => {
  const hits = [
    { id: "top", score: 100 },
    { id: "hot", score: 90 },
  ];
  const shadow = computeSalienceShadow(hits, fmMap({ hot: { salience: 1 } }), 0.25);
  assert.ok(shadow);
  // 90 * 1.25 = 112.5 > 100 → hot springt im Shadow auf Rang 1
  assert.equal(shadow.order_changed, true);
  assert.deepEqual(
    shadow.hits.map((h) => [h.id, h.rank, h.shadow_rank]),
    [
      ["top", 1, 2],
      ["hot", 2, 1],
    ]
  );
  assert.equal(shadow.cap, 0.25);
  // servierte Hits bleiben unangefasst
  assert.deepEqual(hits, [
    { id: "top", score: 100 },
    { id: "hot", score: 90 },
  ]);
});

test("shadow: absent without any positive salience", () => {
  const hits = [
    { id: "a", score: 50 },
    { id: "b", score: 40 },
  ];
  assert.equal(computeSalienceShadow(hits, fmMap({}), 0.25), undefined);
  assert.equal(computeSalienceShadow(hits, fmMap({ a: { salience: 0 } }), 0.25), undefined);
  assert.equal(computeSalienceShadow([], fmMap({}), 0.25), undefined);
  assert.equal(computeSalienceShadow(hits, fmMap({ a: { salience: 1 } }), 0), undefined);
});

test("shadow: order_changed false when the boost cannot flip ranks", () => {
  const hits = [
    { id: "far-ahead", score: 200 },
    { id: "hot", score: 50 },
  ];
  const shadow = computeSalienceShadow(hits, fmMap({ hot: { salience: 0.5 } }), 0.25);
  assert.ok(shadow);
  assert.equal(shadow.order_changed, false);
  assert.equal(shadow.hits[1].salience, 0.5);
});

test("shadow: modes off/live skip the computation", () => {
  const hits = [
    { id: "hot", score: 90 },
    { id: "top", score: 100 },
  ];
  const fm = fmMap({ hot: { salience: 1 } });
  for (const mode of ["off", "live"]) {
    process.env.BASTRA_SALIENCE_RANK = mode;
    try {
      assert.equal(computeSalienceShadow(hits, fm, 0.25), undefined, `mode ${mode}`);
    } finally {
      delete process.env.BASTRA_SALIENCE_RANK;
    }
  }
});
