/**
 * Tests für die "surfaced"-Notice (#221): recall UND hook_recall lassen ihre
 * servierten Treffer über den onRecalled-Hook aufleuchten — nicht nur das
 * seltene load_memory. Der Hook feuert VOR dem enabled-Gate (UI-Signal, nicht
 * Persistenz).
 *
 * Was "serviert" heißt, entscheidet das Band (BASTRA_RECALL_FLOOR /
 * BASTRA_MUST_LOAD_SCORE), nicht ein von Hand gesetztes Top-N: ein
 * `below_floor`-Treffer wurde dem Modell nie gezeigt, eine Notice dafür würde
 * der Karte etwas anzeigen, das der Turn nicht gesehen hat. Die Deckelung auf
 * drei bleibt als Obergrenze bestehen.
 *
 * Runner: `tsx --test __tests__/telemetry-surfaced-notice.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Telemetry } from "../src/telemetry.js";
import type { RecallBand } from "../src/telemetry.js";

const hit = (id: string, score: number) => ({ id, score, type: "memory" });
type Notice = { id: string; band: RecallBand };

test("onRecalled fires with the served recall hits, capped at three", async () => {
  const telemetry = new Telemetry();
  const seen: Notice[][] = [];
  telemetry.onRecalled = (hits) => seen.push(hits);

  await telemetry.logRecall({
    recall_id: "r1",
    query: "q",
    k: 5,
    scope: null,
    type: null,
    vault_size: 10,
    hit_count: 5,
    top_score: 90,
    hits: [hit("a", 90), hit("b", 80), hit("c", 70), hit("d", 60), hit("e", 50)],
    latency_ms: 1,
    recall_stages: undefined,
    dropped_below_floor: 0,
  });

  assert.deepEqual(
    seen,
    [[
      { id: "a", band: "optional" },
      { id: "b", band: "optional" },
      { id: "c", band: "optional" },
    ]],
    "only three light up, each carrying the band that served it",
  );
});

test("onRecalled fires on the hook_recall path too", async () => {
  const telemetry = new Telemetry();
  const seen: Notice[][] = [];
  telemetry.onRecalled = (hits) => seen.push(hits);

  // #542: HookRecallEvent grew several required fields unrelated to what
  // this test checks (onRecalled firing off surfaced hits) — neutral values.
  await telemetry.logHookRecall({
    recall_id: "h1",
    query: "q",
    topics: [],
    tool_name: null,
    project: null,
    k: 2,
    scope: null,
    type: null,
    vault_size: 0,
    hit_count: 2,
    top_score: 88,
    latency_ms_recall: 0,
    latency_ms_total: 0,
    hits: [hit("x", 88), hit("y", 77)],
  });

  assert.deepEqual(
    seen,
    [[
      { id: "x", band: "optional" },
      { id: "y", band: "optional" },
    ]],
    "hook_recall surfaces its hits (< 3 = all)",
  );
});

test("the band labels a notice, it never swallows one", async () => {
  const telemetry = new Telemetry();
  const seen: Notice[][] = [];
  telemetry.onRecalled = (hits) => seen.push(hits);

  await telemetry.logRecall({
    recall_id: "r3",
    query: "q",
    k: 3,
    scope: null,
    type: null,
    vault_size: 10,
    hit_count: 3,
    top_score: 140,
    // whatever sits in hits[] was already served — on this path behind the
    // caller's own min_score, which may legitimately sit under the global
    // floor. Re-cutting it here would hide something the turn did see.
    hits: [hit("must", 140), hit("maybe", 45), hit("faint", 3)],
    latency_ms: 1,
    recall_stages: undefined,
    dropped_below_floor: 0,
  });

  assert.deepEqual(
    seen,
    [[
      { id: "must", band: "required" },
      { id: "maybe", band: "optional" },
      { id: "faint", band: "below_floor" },
    ]],
    "every served hit lights up, each carrying the band it was served in",
  );
});

test("a throwing onRecalled never breaks the recall", async () => {
  const telemetry = new Telemetry();
  telemetry.onRecalled = () => {
    throw new Error("notice sink blew up");
  };
  await assert.doesNotReject(
    telemetry.logRecall({
      recall_id: "r2",
      query: "q",
      k: 1,
      scope: null,
      type: null,
      vault_size: 1,
      hit_count: 1,
      top_score: 90,
      hits: [hit("a", 90)],
      latency_ms: 1,
      recall_stages: undefined,
      dropped_below_floor: 0,
    }),
  );
});
