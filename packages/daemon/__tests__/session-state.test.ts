/**
 * Unit tests for session-state.ts (#32).
 *
 * Covers:
 *   - roundtrip (save → load preserves shape)
 *   - corrupted/missing files yield empty state
 *   - shouldDropHit logic (count threshold, time window, loaded marker)
 *   - bumpShown counter / reset-on-stale
 *   - touchLoadedMarker / getLoadedMarkerMtime roundtrip
 */
import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDir = "";

before(async () => {
  testDir = await mkdtemp(join(tmpdir(), "bastra-hook-test-"));
  process.env.BASTRA_HOOK_STATE_DIR = testDir;
});

after(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true });
  delete process.env.BASTRA_HOOK_STATE_DIR;
});

// Import AFTER env override so sessionStateDir() picks up the test dir.
const ss = await import("../src/session-state.js");
// #542: `const ss = await import(...)` only binds `ss` as a value, not a
// type namespace — `ss.SessionState` in a type position doesn't resolve
// once the test tree is type-checked. These aliases give the same names
// back in type space without a second (and colliding) import.
type SessionState = import("../src/session-state.js").SessionState;
type ReadonlySessionState = import("../src/session-state.js").ReadonlySessionState;

test("loadSessionState: missing file → empty state", async () => {
  const s = await ss.loadSessionState("nonexistent-session-id");
  assert.deepEqual(s, { shown: {} });
});

test("loadSessionState: corrupted JSON → empty state", async () => {
  const sessionId = "session-corrupt";
  // Write garbage directly to the file
  const filePath = join(testDir, `${sessionId}.json`);
  await writeFile(filePath, "not-valid-json {", "utf8");
  const s = await ss.loadSessionState(sessionId);
  assert.deepEqual(s, { shown: {} });
});

test("saveSessionState + loadSessionState: roundtrip preserves shape", async () => {
  const sessionId = "session-roundtrip";
  const now = Date.now();
  const original: SessionState = {
    shown: {
      "mem-a": { count: 2, at: now - 1000 },
      "mem-b": { count: 1, at: now - 5000 },
    },
  };
  await ss.saveSessionState(sessionId, original);
  const loaded = await ss.loadSessionState(sessionId);
  assert.deepEqual(loaded, original);
});

test("saveSessionState: empty session id is a no-op (no throw, no file)", async () => {
  await ss.saveSessionState("", { shown: { x: { count: 1, at: Date.now() } } });
  const back = await ss.loadSessionState("");
  assert.deepEqual(back, { shown: {} });
});

test("shouldDropHit: no entry → never drop", () => {
  assert.equal(ss.shouldDropHit(undefined, null), false);
});

test("shouldDropHit: count below threshold → keep", () => {
  const entry = { count: ss.MAX_SHOW - 1, at: Date.now() };
  assert.equal(ss.shouldDropHit(entry, null), false);
});

test("shouldDropHit: count at threshold within window → drop", () => {
  const entry = { count: ss.MAX_SHOW, at: Date.now() };
  assert.equal(ss.shouldDropHit(entry, null), true);
});

test("shouldDropHit: count above threshold within window → drop", () => {
  const entry = { count: ss.MAX_SHOW + 5, at: Date.now() };
  assert.equal(ss.shouldDropHit(entry, null), true);
});

test("#354 shouldDropHit: an old entry still drops — no time window any more", () => {
  // Was the inverse assertion until #354: after RESET_WINDOW_MS the hit came
  // back. That expiry re-injected the same memory into a session that was
  // merely long-running, where its text still stood in the transcript — 17.9 %
  // of the measured context tax. Only a load marker or clearShown releases it.
  const entry = { count: ss.MAX_SHOW, at: Date.now() - ss.RESET_WINDOW_MS - 1000 };
  assert.equal(ss.shouldDropHit(entry, null), true);
});

test("shouldDropHit: loaded marker newer than entry.at → keep (reset clock)", () => {
  const now = Date.now();
  const entry = { count: ss.MAX_SHOW, at: now - 60_000 }; // shown 1 min ago
  const markerNewer = now - 30_000; // loaded 30s ago — newer than shown
  assert.equal(ss.shouldDropHit(entry, markerNewer, now), false);
});

test("shouldDropHit: loaded marker older than entry.at → drop (already shown after load)", () => {
  const now = Date.now();
  const entry = { count: ss.MAX_SHOW, at: now - 30_000 }; // shown 30s ago
  const markerOlder = now - 60_000; // loaded 1 min ago, before last show
  assert.equal(ss.shouldDropHit(entry, markerOlder, now), true);
});

test("bumpShown: first-time entry starts at count=1", () => {
  const state: SessionState = { shown: {} };
  const now = 1_000_000;
  ss.bumpShown(state, "mem-x", now);
  assert.deepEqual(state.shown["mem-x"], { count: 1, at: now });
});

test("bumpShown: within window increments", () => {
  const now = 1_000_000;
  const state: SessionState = { shown: { "mem-x": { count: 2, at: now - 1000 } } };
  ss.bumpShown(state, "mem-x", now);
  assert.equal(state.shown["mem-x"].count, 3);
  assert.equal(state.shown["mem-x"].at, now);
});

test("#354 bumpShown: an old entry keeps counting — the window no longer resets it", () => {
  const now = 1_000_000;
  const state: SessionState = {
    shown: { "mem-x": { count: 5, at: now - ss.RESET_WINDOW_MS - 1 } },
  };
  ss.bumpShown(state, "mem-x", now);
  assert.equal(state.shown["mem-x"].count, 6);
  assert.equal(state.shown["mem-x"].at, now);
});

test("#539/#542 pins the compiler guard: a lane's early snapshot cannot reach a mutator", async () => {
  // What loadSessionState hands a lane is ReadonlySessionState (aee643c) —
  // the write-back only ever applies mutateSessionState's own re-read, so a
  // mutation on THIS snapshot would be silently dropped. The `@ts-expect-error`
  // lines below are the compiler-enforced half of that guard: if either one
  // ever stops erroring, the guard has been widened back to a plain
  // SessionState and this test must fail to pin it back down.
  const snapshot: ReadonlySessionState = await ss.loadSessionState(`test-readonly-guard-${Date.now()}`);
  // @ts-expect-error — bumpShown takes SessionState (mutable), not the
  // read-only snapshot a lane gets from loadSessionState.
  ss.bumpShown(snapshot, "mem-x");
  // @ts-expect-error — same guard, recordSourceSuppressed's `state` parameter.
  ss.recordSourceSuppressed(snapshot, "some-source");
});

test("#354 clearShown: releases the counters, keeps the backoff state", async () => {
  const sid = `test-clear-${Date.now()}`;
  await ss.saveSessionState(sid, {
    shown: { "mem-a": { count: 3, at: Date.now() } },
    sources: { "write-edit": { streak: 4, at: Date.now(), ids: ["mem-a"], skipped: 2 } },
  });
  await ss.clearShown(sid);
  const after = await ss.loadSessionState(sid);
  assert.deepEqual(after.shown, {}, "compact/clear/resume rebuilt the transcript — every hint is eligible again");
  assert.equal(after.sources?.["write-edit"]?.streak, 4, "an empty streak describes retrieval, not the transcript");
});

test("#354 clearShown: unknown session and empty id are no-ops", async () => {
  await ss.clearShown("");
  await ss.clearShown(`test-absent-${Date.now()}`);
});

test("touchLoadedMarker + getLoadedMarkerMtime: roundtrip", async () => {
  const memId = "test-mem-touch";
  const before = await ss.getLoadedMarkerMtime(memId);
  assert.equal(before, null, "no marker before touch");
  await ss.touchLoadedMarker(memId);
  const after = await ss.getLoadedMarkerMtime(memId);
  assert.ok(after !== null, "marker exists after touch");
  assert.ok((after as number) > Date.now() - 5000, "marker mtime is recent");
});

test("end-to-end drop logic: write → read → shouldDrop after 3 shows", async () => {
  const sessionId = "session-e2e";
  const memId = "mem-noisy";
  const now = Date.now();
  // Show 3 times
  const state: SessionState = { shown: {} };
  ss.bumpShown(state, memId, now - 3000);
  ss.bumpShown(state, memId, now - 2000);
  ss.bumpShown(state, memId, now - 1000);
  assert.equal(state.shown[memId].count, 3);
  await ss.saveSessionState(sessionId, state);

  const reloaded = await ss.loadSessionState(sessionId);
  const entry = reloaded.shown[memId];
  // 4th hook call: should drop
  assert.equal(ss.shouldDropHit(entry, null, now), true);

  // Now agent calls load_memory(memId) → marker is touched
  await ss.touchLoadedMarker(memId);
  const marker = await ss.getLoadedMarkerMtime(memId);
  assert.ok(marker !== null);
  // Next hook call after the touch: dedup clock reset, should NOT drop
  assert.equal(ss.shouldDropHit(entry, marker, Date.now()), false);
});

// ─── #572: the parked task-boundary block ────────────────────────

test("takeParkedBoundary hands the block over once and empties the slot", async () => {
  const id = "boundary-once";
  await ss.mutateSessionState(id, (s) => {
    ss.parkBoundary(s, { note: "BLOCK", dedupeKey: "code-boundary:abc", files: 3 }, 1);
  });

  const taken = await ss.takeParkedBoundary(id);
  assert.equal(taken?.note, "BLOCK");
  // #579 measures the delivery by what it cost, so the count rides along.
  assert.equal(taken?.files, 3);
  assert.equal(await ss.takeParkedBoundary(id), null);
  const state = await ss.loadSessionState(id);
  assert.equal(state.boundary, undefined);
  assert.equal(state.shown["code-boundary:abc"]?.count, 1);
});

test("takeParkedBoundary drops a repeat of what the session was already told", async () => {
  const id = "boundary-repeat";
  await ss.mutateSessionState(id, (s) => {
    ss.bumpShown(s, "code-boundary:abc");
    ss.parkBoundary(s, { note: "BLOCK", dedupeKey: "code-boundary:abc", files: 3 }, 1);
  });

  const taken = await ss.takeParkedBoundary(id);
  // Nothing goes out — but the dedupe hit is still a row worth writing.
  assert.equal(taken?.note, null);
  // The slot empties either way — a stale repeat must not sit there forever.
  assert.equal((await ss.loadSessionState(id)).boundary, undefined);
});

test("takeParkedBoundary asks the caller's gate only when a block is parked", async () => {
  // #305: the gate behind this is an uncached settings read, and the trivial
  // prompt is the lane's cheapest path. Revert-check: ask the gate before the
  // parked-slot check and the first count goes to 1.
  const id = "boundary-gate";
  let asked = 0;
  const gate = async () => {
    asked += 1;
    return false;
  };

  assert.equal(await ss.takeParkedBoundary(id, gate), null);
  assert.equal(asked, 0, "nothing parked — the gate is not worth a file read");

  await ss.mutateSessionState(id, (s) => {
    ss.parkBoundary(s, { note: "BLOCK", dedupeKey: "code-boundary:gate", files: 3 }, 1);
  });

  assert.equal(await ss.takeParkedBoundary(id, gate), null);
  assert.equal(asked, 1);
  // A refused gate takes nothing: the block waits for a session that wants it.
  assert.notEqual((await ss.loadSessionState(id)).boundary, undefined);
  assert.equal((await ss.takeParkedBoundary(id, async () => true))?.note, "BLOCK");
});

test("takeBoundary takes and marks inside one mutation a lane already holds", async () => {
  // #305: the prompt lane folds the take into its own save. Revert-check: take
  // the block BEFORE the mutation and mark it inside, and the second half goes
  // red — the same block is handed over twice.
  const id = "boundary-folded";
  await ss.mutateSessionState(id, (s) => {
    ss.parkBoundary(s, { note: "BLOCK", dedupeKey: "code-boundary:folded", files: 3 }, 1);
  });

  let taken: { note: string | null; files: number } | null = null;
  await ss.mutateSessionState(id, (s) => {
    taken = ss.takeBoundary(s);
    ss.bumpShown(s, "some-memory");
  });

  assert.equal((taken as { note: string | null } | null)?.note, "BLOCK");
  const after = await ss.loadSessionState(id);
  assert.equal(after.boundary, undefined);
  assert.equal(after.shown["code-boundary:folded"]?.count, 1);
  // One write did both, so the unrelated delta of the same save survived it.
  assert.equal(after.shown["some-memory"]?.count, 1);
  await ss.mutateSessionState(id, (s) => {
    assert.equal(ss.takeBoundary(s), null);
  });
});

test("the accumulator survives another lane's save of the same file", async () => {
  const id = "boundary-survives";
  await ss.mutateSessionState(id, (s) => ss.recordTouched(s, "/r", "a.ts", null));
  await ss.mutateSessionState(id, (s) => ss.bumpShown(s, "some-memory"));

  assert.equal((await ss.loadSessionState(id)).touched?.get("/r")?.get("a.ts")?.unplaced, true);
});

test("a path named __proto__ is an ordinary key, not a prototype write", async () => {
  // CodeQL js/remote-property-injection: both table levels take their keys from
  // tool input. Revert-check: turn the Map in `recordTouched` back into an
  // object literal — `table["__proto__"] = entry` then writes the prototype
  // instead of the table and every assertion here goes red.
  const id = "boundary-proto";
  await ss.mutateSessionState(id, (s) => {
    ss.recordTouched(s, "__proto__", "a.ts", null);
    ss.recordTouched(s, "/r", "__proto__", null);
    // Booked, not refused: a Map key is a key. The denylist that came before
    // this could only drop the file, and a dropped file renders at the task
    // boundary exactly like a file nothing depends on.
    assert.equal(s.touched?.get("__proto__")?.get("a.ts")?.unplaced, true);
    assert.equal(s.touched?.get("/r")?.get("__proto__")?.unplaced, true);
    // And an ordinary object is untouched by any of it.
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
    assert.equal(({} as Record<string, unknown>).a, undefined);
  });

  await ss.mutateSessionState(id, (s) => ss.recordTouched(s, "/r", "b.ts", null));
  assert.equal((await ss.loadSessionState(id)).touched?.get("/r")?.get("b.ts")?.unplaced, true);
});

test("a state file holding a __proto__ key loads it like any other entry", async () => {
  // The disk boundary, exercised by the only input that can reach it: a state
  // file whose JSON really carries the key. Revert-check: rebuild the load
  // branch into an object literal instead of a Map and the first assertion
  // goes red — the entry lands on the prototype and is not in the table.
  const id = "boundary-proto-disk";
  await ss.mutateSessionState(id, (s) => ss.recordTouched(s, "/r", "a.ts", null));
  const file = join(testDir, `${id}.json`);
  // Written as text: `raw.touched["__proto__"] = …` on an ordinary object sets
  // that object's prototype and JSON.stringify never sees the key, so building
  // the fixture through assignment would write a perfectly clean file.
  const entry = '{"at":1,"last":1,"hits":[],"unplaced":true,"truncated":false}';
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const poisoned = JSON.stringify(raw).replace(
    '"touched":{',
    `"touched":{"__proto__":{"a.ts":${entry}},`,
  ).replace('"/r":{', `"/r":{"__proto__":${entry},`);
  assert.ok(poisoned.includes('"__proto__"'), "the fixture really carries the key");
  await writeFile(file, poisoned);

  const state = await ss.loadSessionState(id);
  assert.equal(state.touched?.get("__proto__")?.get("a.ts")?.unplaced, true, "a repo root named __proto__ loads");
  assert.equal(state.touched?.get("/r")?.get("__proto__")?.unplaced, true, "so does a file named __proto__");
  assert.equal(Object.getPrototypeOf({}), Object.prototype, "and nothing was polluted on the way");
  assert.equal(state.touched?.get("/r")?.get("a.ts")?.unplaced, true, "the ordinary entry survives");
});

test("the character budget counts a file's own registration, not only its hits", async () => {
  // 128 files with long paths and zero hits outspent MAX_TOUCHED_CHARS threefold
  // while `touchedOverflow` stayed false: the base cost was charged without
  // being checked. Revert-check: charge `base` unconditionally again in
  // recordTouched and this goes red.
  const id = "boundary-chars";
  // Four segments under the 255-byte limit each: a legal path, ~1 KB, so 128
  // of them outspend the 128 KiB budget on registration alone.
  const deep = ["src", "a".repeat(240), "b".repeat(240), "c".repeat(240), "d".repeat(240)].join("/") + "/";
  await ss.mutateSessionState(id, (s) => {
    for (let i = 0; i < ss.MAX_TOUCHED_FILES; i++) ss.recordTouched(s, "/r", `${deep}${i}.ts`, []);
    assert.equal(s.touchedOverflow, true, "the table says it stopped recording");
    assert.ok((s.touchedChars ?? 0) <= ss.MAX_TOUCHED_CHARS, "and it stopped inside the bound");
  });
});
