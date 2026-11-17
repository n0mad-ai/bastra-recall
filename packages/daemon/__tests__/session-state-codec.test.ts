/**
 * #1322 — characterization of the session-state codec before and after the
 * split of session-state.ts: a legacy state file carrying every section, plus
 * malformed entries per section, must decode to the same state and persist to
 * the same JSON (byte for byte, key order included).
 *
 * Runner: npm test (scripts/test-env.mjs keeps the telemetry out of the real log).
 */
import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDir = "";

before(async () => {
  testDir = await mkdtemp(join(tmpdir(), "bastra-1322-codec-"));
  process.env.BASTRA_HOOK_STATE_DIR = testDir;
});

after(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true });
  delete process.env.BASTRA_HOOK_STATE_DIR;
});

const ss = await import("../src/session-state.js");
const { readHookState } = await import("../src/hook-state-database.js");

/**
 * Legacy JSON is imported once, when a state directory's database is first
 * opened — so every fixture gets a directory of its own.
 */
async function legacyState(id: string, raw: string): Promise<string> {
  const dir = await mkdtemp(join(testDir, "case-"));
  process.env.BASTRA_HOOK_STATE_DIR = dir;
  await writeFile(join(dir, `${id}.json`), raw);
  return dir;
}

const FULL_LEGACY = {
  unknownKey: "dropped",
  shown: { m1: { count: 2, at: 10 } },
  githubAdvisory: { token: "tok", deadline: 99 },
  rulebookCheck: "check",
  executedVaultWrites: "writes",
  draftShown: ["d1", 7, "d2"],
  sources: { "write-edit": { streak: 3, at: 5, ids: ["a"], skipped: 1 } },
  touched: {
    "/repo": { "a.ts": { at: 1, last: 2, hits: [], unplaced: false, truncated: false } },
    "/bad": 5,
  },
  boundary: { note: "n", dedupeKey: "k" },
  touchedChars: 42,
  touchedOverflow: true,
  saveEvalDelivered: ["h1", null],
  constants: { taxonomy: "abc", bad: 3 },
  pendingMustLoad: [{ id: "p1", block: "b", at: 1 }, { id: "p2" }],
  deniedReflex: ["r1", 2],
  toolCalls: 4,
  claimedMustLoad: ["c1", {}],
  loadedConventions: [
    { id: "l1", revision: null, loadedAt: 3 },
    { id: "l2", revision: 5, loadedAt: 3 },
  ],
  userValidatorChannel: "email",
  activeConventions: [
    { id: "a1", revision: "r", setAt: 1, scope: "task" },
    { id: "a2", setAt: 1 },
  ],
  activeTask: { id: "t1", kind: "draft-for-review", since: 1, generation: 2 },
  receipts: [
    { taskId: "t1", generation: 2, hash: "h", receipt: "sha256:x", channel: "email", limit: 5, unit: "words", at: 1 },
    { taskId: "t1" },
  ],
  repairAttempts: { taskId: "t1", generation: 2, count: 1 },
  repairWindows: { actor: { scope: "s", length: 3, tail: "t" }, bad: { scope: 1 } },
  correspondenceContext: { at: 1, generation: 2, conventions: [{ id: "x", revision: null }, { id: 1 }] },
};

const EXPECTED_JSON =
  '{"shown":{"m1":{"count":2,"at":10}},"githubAdvisory":{"token":"tok","deadline":99},"rulebookCheck":"check",' +
  '"executedVaultWrites":"writes","draftShown":["d1","d2"],"sources":{"write-edit":{"streak":3,"at":5,"ids":["a"],"skipped":1}},' +
  '"touched":{"/repo":{"a.ts":{"at":1,"last":2,"hits":[],"unplaced":false,"truncated":false}}},"touchedOverflow":true,' +
  '"boundary":{"note":"n","dedupeKey":"k","builtFrom":0,"files":0},"touchedChars":42,"saveEvalDelivered":["h1"],' +
  '"constants":{"taxonomy":"abc"},"pendingMustLoad":[{"id":"p1","block":"b","at":1}],"deniedReflex":["r1"],"toolCalls":4,' +
  '"claimedMustLoad":["c1"],"loadedConventions":[{"id":"l1","revision":null,"loadedAt":3}],"userValidatorChannel":"email",' +
  '"activeConventions":[{"id":"a1","revision":"r","setAt":1,"scope":"task"}],' +
  '"activeTask":{"id":"t1","kind":"draft-for-review","since":1,"generation":2},' +
  '"receipts":[{"taskId":"t1","generation":2,"hash":"h","receipt":"sha256:x","channel":"email","limit":5,"unit":"words","at":1}],' +
  '"repairAttempts":{"taskId":"t1","generation":2,"count":1},"repairWindows":{"actor":{"scope":"s","length":3,"tail":"t"}},' +
  '"correspondenceContext":{"at":1,"generation":2,"conventions":[{"id":"x","revision":null}]}}';

test("#1322: a legacy state with every section decodes and re-persists byte-identically", async () => {
  const id = "codec-full";
  const dir = await legacyState(id, JSON.stringify(FULL_LEGACY));
  const loaded = await ss.loadSessionState(id);
  assert.equal(loaded.touched?.get("/repo")?.get("a.ts")?.last, 2);
  assert.equal(loaded.touched?.has("/bad"), false);
  // A no-op mutation writes the decoded state back through the codec.
  assert.equal(await ss.mutateSessionState(id, () => {}), true);
  assert.equal(await readHookState(dir, id), EXPECTED_JSON);
  // The decode seeds the in-process draft claims with the stored ids.
  assert.deepEqual(ss.availableDraftHints(id, ["d1", "d2", "d3"], []), ["d3"]);
});

test("#1322: a delivered advisory and a boundary with counts decode as stored", async () => {
  const id = "codec-variants";
  const dir = await legacyState(
    id,
    JSON.stringify({
      shown: {},
      githubAdvisory: { delivered: true, token: "ignored" },
      boundary: { note: "n", dedupeKey: "k", builtFrom: 7, files: 3 },
      activeTask: { kind: "none", since: 5, generation: 0, validatorChannel: "sms", approvalSource: "user-turn" },
      correspondenceContext: { at: 1, generation: 0 },
    })
  );
  assert.equal(await ss.mutateSessionState(id, () => {}), true);
  assert.equal(
    await readHookState(dir, id),
    '{"shown":{},"githubAdvisory":{"delivered":true},"boundary":{"note":"n","dedupeKey":"k","builtFrom":7,"files":3},' +
      '"activeTask":{"id":"none@5","kind":"none","since":5,"generation":0,"validatorChannel":"sms","approvalSource":"user-turn"},' +
      '"correspondenceContext":{"at":1,"generation":0}}'
  );
});

test("#1322: states without a shown section, or not an object, decode empty", async () => {
  for (const [id, raw] of [
    ["codec-no-shown", '{"toolCalls":3}'],
    ["codec-array", "[1,2]"],
    ["codec-null", "null"],
  ] as const) {
    await legacyState(id, raw);
    assert.deepEqual(await ss.loadSessionState(id), { shown: {} }, id);
  }
});

test("#1322: recordTouched keeps its bounds, dedupe and flags", () => {
  const state: import("../src/session-state.js").SessionState = { shown: {} };
  const hit = (i: number) => ({ file: `d${i}.ts`, location: "1", via: "import", relation: "imports" });
  ss.recordTouched(state, "/r", "a.ts", [hit(0), hit(0), hit(1)], false, 5);
  ss.recordTouched(state, "/r", "a.ts", null, true, 9);
  const a = state.touched?.get("/r")?.get("a.ts");
  assert.ok(a);
  assert.deepEqual(
    { at: a.at, last: a.last, hits: a.hits.map((h) => h.file), unplaced: a.unplaced, truncated: a.truncated },
    { at: 5, last: 9, hits: ["d0.ts", "d1.ts"], unplaced: true, truncated: true }
  );
  assert.equal(state.touchedChars, "/r".length + "a.ts".length + 64 + 2 * ("d0.ts".length + 1 + 6 + 7 + 64));

  const many = Array.from({ length: ss.MAX_TOUCHED_HITS + 5 }, (_, i) => hit(i));
  ss.recordTouched(state, "/r", "b.ts", many, false, 1);
  assert.equal(state.touched?.get("/r")?.get("b.ts")?.hits.length, ss.MAX_TOUCHED_HITS);
  assert.equal(state.touched?.get("/r")?.get("b.ts")?.truncated, true);
  assert.equal(state.touchedOverflow, undefined);

  for (let i = 0; ss.touchedCount(state) < ss.MAX_TOUCHED_FILES; i++) ss.recordTouched(state, "/s", `f${i}.ts`, []);
  ss.recordTouched(state, "/new-root", "x.ts", []);
  assert.equal(state.touchedOverflow, true);
  assert.equal(state.touched?.has("/new-root"), false, "an empty repository entry is not left behind");
  assert.equal(ss.touchedCount(state), ss.MAX_TOUCHED_FILES);
});
