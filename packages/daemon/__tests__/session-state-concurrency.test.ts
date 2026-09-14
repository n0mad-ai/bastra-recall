/**
 * #539 — session state is a read-modify-write shared by five lanes.
 *
 * `loadSessionState` → lane work → `saveSessionState` is a transaction, and
 * five lanes (write, todo, bash-pre, bash-fail, prompt) run it against the
 * same session id. Without serialisation every lane reads the same old file
 * and the last writer wins: N lanes report success, one lane's bookkeeping
 * survives. `mutateSessionState` is the fix — the read-modify-write happens
 * inside a per-session lock, so each lane applies its delta to whatever is
 * on disk at that moment.
 *
 * The lock deliberately does NOT wrap the lane's own work (recall, search,
 * governor). Only the short mutation is serialised, so the hook path keeps
 * its latency — the budget test at the bottom pins that.
 */
import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDir = "";

before(async () => {
  testDir = await mkdtemp(join(tmpdir(), "bastra-539-test-"));
  process.env.BASTRA_HOOK_STATE_DIR = testDir;
});

after(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true });
  delete process.env.BASTRA_HOOK_STATE_DIR;
});

const ss = await import("../src/session-state.js");

async function persisted(sessionId: string): Promise<ss.SessionState> {
  return JSON.parse(await readFile(join(testDir, `${sessionId}.json`), "utf8")) as ss.SessionState;
}

test("#539: concurrent lane updates on one session id all survive", async () => {
  const sid = "sess-lanes";
  const ids = ["mem-a", "mem-b", "mem-c", "mem-d", "mem-e"];
  // Five lanes, each mutating the same session file at the same moment. The
  // `await` inside stands for the lane's own async work between its read and
  // its write — exactly the window the last-writer-wins loss lives in.
  await Promise.all(
    ids.map((id) =>
      ss.mutateSessionState(sid, (state) => {
        ss.bumpShown(state, id, 1_000);
      }),
    ),
  );
  const state = await persisted(sid);
  assert.deepEqual(Object.keys(state.shown).sort(), [...ids].sort());
});

test("#539: concurrent dedup bump and backoff emit keep both sections", async () => {
  const sid = "sess-mixed";
  // write-lane bumps `shown`, todo-lane records a backoff emit — two
  // different sections of the same file, written at the same moment.
  await Promise.all([
    ss.mutateSessionState(sid, (state) => ss.bumpShown(state, "mem-x", 1_000)),
    ss.mutateSessionState(sid, (state) =>
      ss.recordSourceEmit(state, "todo-lane", ["mem-y"], false, 2_000),
    ),
    ss.mutateSessionState(sid, (state) =>
      ss.recordSourceEmit(state, "bash-fail-lane", ["mem-z"], false, 3_000),
    ),
  ]);
  const state = await persisted(sid);
  assert.equal(state.shown["mem-x"]?.count, 1);
  assert.equal(state.sources?.["todo-lane"]?.ids[0], "mem-y");
  assert.equal(state.sources?.["bash-fail-lane"]?.ids[0], "mem-z");
});

test("#539: repeated bumps of the same id count every lane", async () => {
  const sid = "sess-counter";
  const lanes = 8;
  await Promise.all(
    Array.from({ length: lanes }, () =>
      ss.mutateSessionState(sid, (state) => ss.bumpShown(state, "mem-hot", 1_000)),
    ),
  );
  const state = await persisted(sid);
  assert.equal(state.shown["mem-hot"]?.count, lanes);
});

test("#539: a throwing mutation never poisons the next lane", async () => {
  const sid = "sess-throw";
  await assert.rejects(
    ss.mutateSessionState(sid, () => {
      throw new Error("lane blew up");
    }),
  );
  await ss.mutateSessionState(sid, (state) => ss.bumpShown(state, "mem-after", 1_000));
  const state = await persisted(sid);
  assert.equal(state.shown["mem-after"]?.count, 1);
});

test("#539: empty session id stays a no-op", async () => {
  let called = false;
  await ss.mutateSessionState("", () => {
    called = true;
  });
  assert.equal(called, false);
});

test("#539: the mutation stays cheap enough for the hook path", async () => {
  const sid = "sess-budget";
  // Warm the file so we measure the steady state, not the mkdir.
  await ss.mutateSessionState(sid, (state) => ss.bumpShown(state, "warm", 1_000));
  const rounds = 200;
  const t0 = performance.now();
  for (let i = 0; i < rounds; i++) {
    await ss.mutateSessionState(sid, (state) => ss.bumpShown(state, `m-${i}`, 1_000));
  }
  const perCall = (performance.now() - t0) / rounds;
  // A hook lane spends hundreds of ms in recall; the serialised mutation must
  // stay in the noise. Generous ceiling — it measures ~0.2ms locally and this
  // only has to catch an order-of-magnitude regression (e.g. a cross-process
  // lock file, or the lock accidentally wrapping the lane's own work).
  assert.ok(perCall < 10, `mutateSessionState took ${perCall.toFixed(3)}ms per call`);
});

/**
 * The other half of #539, found while measuring: the lock does not just have
 * to serialise the writes, the lane's delta has to BE in the callback. A
 * mutation made to the snapshot the lane read earlier is dropped silently —
 * `mutateSessionState` re-reads inside the lock and never sees it. This pins
 * both halves at once: a suppression booked as a delta survives even while
 * another lane writes the same file in the same moment.
 */
test("#539: a backoff suppression survives a concurrent write from another lane", async () => {
  const sid = "sess-suppressed";
  await ss.mutateSessionState(sid, (state) =>
    ss.recordSourceEmit(state, "prompt-lookup", ["mem-q"], false, 5_000),
  );
  await Promise.all([
    ss.mutateSessionState(sid, (state) => ss.recordSourceSuppressed(state, "prompt-lookup")),
    ss.mutateSessionState(sid, (state) => ss.bumpShown(state, "mem-other", 1_000)),
  ]);
  const state = await persisted(sid);
  assert.equal(state.sources?.["prompt-lookup"]?.skipped, 1, "suppression must be persisted");
  assert.equal(state.sources?.["prompt-lookup"]?.at, 5_000, "the emit stamp is untouched");
  assert.equal(state.shown["mem-other"]?.count, 1, "the other lane's write survives too");
});
