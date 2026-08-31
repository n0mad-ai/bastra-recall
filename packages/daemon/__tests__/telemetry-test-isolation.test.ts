/**
 * A test run must not write into the developer's own telemetry log.
 *
 * Telemetry resolves its log dir once, in the constructor: BASTRA_LOG_PATH, else
 * ~/.bastra/logs. 22 test files construct one without redirecting it, so `npm test`
 * appended 114 events per run to the real log — including two recall_episode rows
 * carrying the fixture memory id "m1", with acted_on=true.
 *
 * The log is an INPUT, not just a record. `bastra bridges mint` joins recall to
 * recall_episode and mints bridges from every acted-on reach it finds, writing them
 * into the Commons clone for contribution; `bastra logs --stats` reports over the
 * same file. Fixture rows there mean fixture bridges and contaminated statistics,
 * and neither failure announces itself.
 *
 * scripts/test-env.mjs fills in a throwaway BASTRA_LOG_PATH for any test process
 * that did not pick one. This pins that guard: it asserts the property (writes land
 * somewhere disposable) rather than the mechanism, so it still holds if the guard is
 * reimplemented.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/telemetry-test-isolation.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Telemetry } from "../src/telemetry.js";

/** Where a Telemetry built under the current env would write. */
const REAL_LOG_DIR = resolve(join(homedir(), ".bastra", "logs"));

/** The probe's identity, used both to write it and to recognise it again (#374). */
const PROBE_MEMORY_ID = "isolation-probe";
const PROBE_RECALL_ID = "iso-recall";

/**
 * Probe events this run could have written — the guard's actual predicate (#374).
 *
 * It used to be `doesNotMatch(realRows, /isolation-probe/)`, a substring sweep
 * over the whole day's file, and that was red for two reasons that are not
 * contamination by the current run. One stale line from an earlier run without
 * the isolation kept it red until midnight. And so did a legitimate `hook_recall`
 * whose logged prompt merely DISCUSSED this test — talking about the failure
 * reproduced it. A guard that cannot tell those from a real leak gets muted.
 *
 * Two narrowings, both from the issue: the id has to sit in a FIELD that carries
 * an identity, not anywhere in the line; and the event has to be newer than the
 * moment this run began.
 */
export function probeEventsSince(rows: string, startedAt: string): Record<string, unknown>[] {
  return rows
    .split("\n")
    .filter(Boolean)
    .map((line): Record<string, unknown> | null => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null; // a half-written line is not evidence of anything
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null)
    .filter((e) => e.memory_id === PROBE_MEMORY_ID || e.recall_id === PROBE_RECALL_ID)
    .filter((e) => typeof e.ts === "string" && e.ts >= startedAt);
}

test("the ambient log dir under test is never the developer's real one", () => {
  const configured = process.env.BASTRA_LOG_PATH;
  assert.ok(
    configured,
    "BASTRA_LOG_PATH must be set for a test process — scripts/test-env.mjs does this via --import in the root test script",
  );
  assert.notEqual(
    resolve(configured),
    REAL_LOG_DIR,
    "a test run pointed at ~/.bastra/logs would mint fixture bridges and skew `bastra logs --stats`",
  );
  assert.ok(
    resolve(configured).startsWith(resolve(tmpdir())),
    `the test log dir should be disposable, got ${configured}`,
  );
});

test("a default-constructed Telemetry writes an acted-on episode to the throwaway dir, not to $HOME", async () => {
  // Taken BEFORE anything is written, so the check at the end can separate what
  // this run produced from what was already in the file (#374).
  const startedAt = new Date().toISOString();

  // Exactly the shape hook-act.test.ts produced: a loaded memory, then an edit
  // that mentions two of its distinctive tokens.
  const t = new Telemetry();
  t.rotateTurn("iso-session");
  t.recordLoadedMemory({
    memory_id: PROBE_MEMORY_ID,
    distinctive_tokens: ["zirconflux", "pallasgate"],
    hook_hint: { recall_id: PROBE_RECALL_ID, score: 90 },
    session_id: "iso-session",
  });
  const episodes = t.matchLoadedMemories({
    tool_name: "Bash",
    tool_input_excerpt: "zirconflux pallasgate rollout",
    session_id: "iso-session",
  });
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].acted_on, true, "this is the row that used to leak");
  await t.logRecallEpisode(episodes[0]);
  await t.flushNow();

  const today = new Date().toISOString().slice(0, 10);
  const written = await readdir(process.env.BASTRA_LOG_PATH as string);
  assert.ok(
    written.includes(`events-${today}.jsonl`),
    `the episode should be in the throwaway dir, found ${JSON.stringify(written)}`,
  );

  // And the real dir must not have grown a row for this probe. Reading it is safe:
  // if it does not exist, there is nothing to contaminate.
  // The predicate lives in `probeEventsSince` (#374) and is unit-tested below.
  let realRows = "";
  try {
    const { readFile } = await import("node:fs/promises");
    realRows = await readFile(join(REAL_LOG_DIR, `events-${today}.jsonl`), "utf8");
  } catch {
    /* no real log on this machine — the property holds trivially */
  }
  const leaked = probeEventsSince(realRows, startedAt);

  assert.deepEqual(
    leaked,
    [],
    `this run wrote ${leaked.length} probe event(s) into the developer's real telemetry log`,
  );
});

test("the guard reports only probe events this run could have written (#374)", () => {
  const startedAt = "2026-08-29T10:00:00.000Z";
  const rows = [
    // 1. Contamination from an earlier run, already in the file. Real, but not
    //    ours — under the old substring sweep it kept the suite red all day.
    { ts: "2026-08-29T06:23:00.000Z", kind: "recall_episode", memory_id: PROBE_MEMORY_ID, recall_id: PROBE_RECALL_ID },
    // 2. Legitimate telemetry that merely QUOTES the string: a hook recall whose
    //    prompt discussed this very test failure. Talking about it reproduced it.
    { ts: "2026-08-29T11:00:00.000Z", kind: "hook_recall", query: `why does ${PROBE_MEMORY_ID} keep failing`, memory_id: "some-other-memory" },
    // 3. A half-written line — a torn write is not evidence of anything.
    "{not json",
  ]
    .map((r) => (typeof r === "string" ? r : JSON.stringify(r)))
    .join("\n");

  assert.deepEqual(probeEventsSince(rows, startedAt), [], "neither an old row nor a mention is contamination by this run");

  // What the guard must still catch: a probe event written after this run began.
  const fresh = { ts: "2026-08-29T10:00:01.000Z", kind: "recall_episode", memory_id: PROBE_MEMORY_ID, acted_on: true };
  const withLeak = `${rows}\n${JSON.stringify(fresh)}`;
  assert.deepEqual(probeEventsSince(withLeak, startedAt), [fresh], "a real leak is still reported");

  // And the recall_id alone identifies it too, for events that carry no memory_id.
  const byRecallId = { ts: "2026-08-29T10:00:02.000Z", kind: "recall", recall_id: PROBE_RECALL_ID };
  assert.deepEqual(probeEventsSince(JSON.stringify(byRecallId), startedAt), [byRecallId]);
});
