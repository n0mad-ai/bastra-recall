/**
 * `bastra logs` (#11) — duration parsing and event rendering.
 *
 * These two carry the command: a --since the user has to guess at, or a line
 * that hides the one field they were looking for, makes the whole subcommand
 * pointless. The file walking is covered indirectly by log-retention.test.ts,
 * which owns the same directory layout.
 *
 * Runner: `tsx --test __tests__/cli-logs.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSince, formatEvent, humanizeMs } from "../src/cli/logs.js";

test("logs: --since speaks the units people actually type", () => {
  assert.equal(parseSince("30s"), 30_000);
  assert.equal(parseSince("90sec"), 90_000);
  assert.equal(parseSince("10min"), 600_000);
  assert.equal(parseSince("2h"), 7_200_000);
  assert.equal(parseSince("1d"), 86_400_000);
  assert.equal(parseSince("1day"), 86_400_000);
  // Whitespace and plurals are what a hand types, not what a grammar expects.
  assert.equal(parseSince(" 5 mins "), 300_000);
  assert.equal(parseSince("2 hrs"), 7_200_000);
  // A bare number means minutes — the unit people omit most often.
  assert.equal(parseSince("15"), 900_000);
});

test("logs: --since rejects what it cannot honour, rather than guessing", () => {
  assert.equal(parseSince("bogus"), null);
  assert.equal(parseSince(""), null);
  assert.equal(parseSince("-5m"), null);
  assert.equal(parseSince("5 weeks"), null);
});

test("logs: humanizeMs and parseSince agree on the same vocabulary", () => {
  for (const input of ["45s", "10min", "2h", "3d"]) {
    const ms = parseSince(input);
    assert.ok(ms !== null, `${input} must parse`);
    assert.equal(humanizeMs(ms), input, `${input} must survive the round trip`);
  }
});

test("logs: a recall line shows query, hits and score — the debugging triple", () => {
  const out = formatEvent({
    kind: "recall",
    ts: "2026-07-22T10:00:00.000Z",
    query: "typescript daemon",
    k: 3,
    hit_count: 6,
    top_score: 162.55,
    latency_ms: 42,
    // Noise that must NOT reach the line:
    recall_stages: { bm25_search_ms: 17, vector_ms: 200 },
    hits: [{ id: "a", score: 1 }],
  });
  assert.match(out, /^recall /);
  assert.match(out, /query="typescript daemon"/);
  assert.match(out, /k=3/);
  assert.match(out, /hits=6/);
  assert.match(out, /top=162\.6/);
  assert.match(out, /42ms/);
  assert.doesNotMatch(out, /bm25_search_ms/, "stage timings would drown the line");
});

test("logs: a long query is truncated, not wrapped over the terminal", () => {
  const out = formatEvent({ kind: "recall", ts: "x", query: "a".repeat(200) });
  assert.ok(out.length < 100, `line stayed long: ${out.length}`);
  assert.match(out, /…/);
});

test("logs: an unknown event kind still renders instead of vanishing", () => {
  // The formatter must not become a filter — a new event type added elsewhere
  // in the daemon would otherwise silently disappear from `bastra logs`.
  const out = formatEvent({ kind: "some_future_event", ts: "x", surface: "cursor", status: "ok" });
  assert.match(out, /^some_future_event/);
  assert.match(out, /surface=cursor/);
  assert.match(out, /status=ok/);
});

test("logs: an event with nothing to say still names itself", () => {
  assert.equal(formatEvent({ kind: "hook_act", ts: "x" }), "hook_act");
  assert.equal(formatEvent({ ts: "x" }), "event");
});

test("#565: a hook_reflex row with a near-miss trace still renders", () => {
  // Der Trace ist ein Array in einer Zeile, die der Formatter generisch
  // rendert — ein unbekanntes Feld darf die Ausgabe nicht sprengen.
  const out = formatEvent({
    kind: "hook_reflex",
    ts: "x",
    served: [],
    near_miss: [
      { id: "nachrichtenkonvention", phrase: "Antwort an zzalli", reason: "tokens-missing", matched_tokens: 1, phrase_tokens: 2, missing_tokens: ["antwort"] },
    ],
    latency_ms: 3,
  });
  assert.match(out, /^hook_reflex/);
  assert.match(out, /3ms/);
  assert.doesNotMatch(out, /\[object Object\]/, "no array is stringified into the line");
});
