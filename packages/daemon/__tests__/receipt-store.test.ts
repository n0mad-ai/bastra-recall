/**
 * #1310 — per-session receipt store for validated artifacts.
 *
 * A passing `validate_artifact` call stores its receipt only in the calling
 * session (the forwarder's session header), bound to the running task id and
 * generation; without a session it stores nothing and writes one
 * `receipt_unattributed` line. Receipts expire when the task ends (kind none
 * or a new task) and when the generation rises; the `<active-conventions>`
 * block shows one receipt line while one is valid.
 *
 * Revert-check: drop `delete state.receipts` from bumpTaskGeneration — the
 * generation case goes red; drop `expireReceipts(s)` from prompt-task.ts — the
 * `none` case goes red.
 */
import { after, before, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCopyBlocks } from "@bastra-recall/core";
import { callerSessionStore } from "../src/caller-session.js";
import { formatActiveConventionsBlock } from "../src/prompt-format.js";
import {recordRulebookCheck} from "../src/rulebook-check.js";
import { runTaskStep } from "../src/prompt-task.js";
import { RECEIPTS_CAP, currentReceipt, findReceipt, storeReceipt } from "../src/receipt-store.js";
import { bumpTaskGeneration, loadSessionState, mutateSessionState, taskIdFor } from "../src/session-state.js";
import type { Telemetry } from "../src/telemetry.js";
import { validateArtifactHandler } from "../src/validate-artifact-handler.js";

const MESSAGE = "Hallo Sam,\n\ndas erfundene Paket kommt am Dienstag.\nBitte bestätige die Adresse.";
const ARGS = { text: MESSAGE, channel: "discord-dm", normalize: "none" as const };

let dir = "";
let previous: string | undefined;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "bastra-receipt-store-"));
  previous = process.env.BASTRA_HOOK_STATE_DIR;
  process.env.BASTRA_HOOK_STATE_DIR = dir;
});
after(async () => {
  if (previous === undefined) delete process.env.BASTRA_HOOK_STATE_DIR;
  else process.env.BASTRA_HOOK_STATE_DIR = previous;
  await rm(dir, { recursive: true, force: true });
});

async function seedTask(sid: string, kind: "draft-for-review" | "approved-copy" = "approved-copy", generation = 0): Promise<void> {
  await mutateSessionState(sid, (s) => {
    s.activeTask = { id: taskIdFor(kind, 1000), kind, since: 1000, generation };
  });
}

function fakeTelemetry(): { telemetry: Telemetry; lines: unknown[] } {
  const lines: unknown[] = [];
  const telemetry = { logReceiptUnattributed: async (p: unknown) => { lines.push(p); } } as unknown as Telemetry;
  return { telemetry, lines };
}

const passing = () => {
  const r = validateCopyBlocks(ARGS);
  return { ...r, receipt: r.receipt! };
};

test("a passing call with a session stores the receipt in that session, without text", async () => {
  await seedTask("rs-with");
  await seedTask("rs-other");
  const { telemetry, lines } = fakeTelemetry();
  const out = await callerSessionStore.run("rs-with", () => validateArtifactHandler(ARGS, { telemetry }));
  assert.equal(out.session_known, true);
  assert.equal(out.receipt_stored, true);
  const state = await loadSessionState("rs-with");
  assert.equal(state.receipts?.length, 1);
  const stored = state.receipts![0]!;
  assert.deepEqual(
    { ...stored, at: 0 },
    { taskId: "approved-copy@1000", generation: 0, hash: out.artifact_sha256, receipt: out.receipt, channel: "discord-dm", limit: 2000, unit: "max(codepoints,utf16)", at: 0 },
  );
  assert.ok(!JSON.stringify(state.receipts).includes("Paket"), "no artifact text in the store");
  assert.equal((await loadSessionState("rs-other")).receipts, undefined, "never written into another session");
  assert.deepEqual(lines, []);
});

test("without a session nothing is stored and one receipt_unattributed line is written", async () => {
  for (const [caller, transport] of [[undefined, "stdio"], [null, "forwarded"]] as const) {
    const { telemetry, lines } = fakeTelemetry();
    const run = () => validateArtifactHandler(ARGS, { telemetry });
    const out = caller === undefined ? await run() : await callerSessionStore.run(caller, run);
    assert.equal(out.session_known, false);
    assert.equal(out.receipt_stored, false);
    assert.match((out as { receipt_note?: string }).receipt_note ?? "", /no Claude Code session/);
    assert.ok(out.receipt, "the receipt itself is still returned");
    assert.deepEqual(lines, [{ channel: "discord-dm", transport }]);
  }
});

test("a failed validation stores nothing and writes no line", async () => {
  await seedTask("rs-failed");
  const { telemetry, lines } = fakeTelemetry();
  const out = await callerSessionStore.run("rs-failed", () => validateArtifactHandler({ ...ARGS, text: "> " + MESSAGE }, { telemetry }));
  assert.equal(out.receipt, null);
  assert.equal(out.receipt_stored, false);
  assert.equal((await loadSessionState("rs-failed")).receipts, undefined);
  assert.deepEqual(lines, []);
});

test("no task in progress or a stale task binding stores nothing", async () => {
  const none = await callerSessionStore.run("rs-no-task", () => validateArtifactHandler(ARGS));
  assert.equal(none.receipt_stored, false);
  assert.match((none as { receipt_note?: string }).receipt_note ?? "", /no correspondence task/);
  await seedTask("rs-stale", "approved-copy", 2);
  const stale = await callerSessionStore.run("rs-stale", () =>
    validateArtifactHandler({ ...ARGS, task: { kind: "approved-copy", generation: 1 } }));
  assert.equal(stale.receipt_stored, false);
  assert.equal((await loadSessionState("rs-stale")).receipts, undefined);
  const fresh = await callerSessionStore.run("rs-stale", () =>
    validateArtifactHandler({ ...ARGS, task: { kind: "approved-copy", generation: 2 } }));
  assert.equal(fresh.receipt_stored, true);
});

test(`the store keeps the newest ${RECEIPTS_CAP} receipts`, async () => {
  await seedTask("rs-cap");
  const r = passing();
  for (let i = 0; i < RECEIPTS_CAP + 5; i++) {
    assert.equal(await storeReceipt("rs-cap", { ...r, artifact_sha256: `h${i}` }, undefined, i), "stored");
  }
  const receipts = (await loadSessionState("rs-cap")).receipts ?? [];
  assert.equal(receipts.length, RECEIPTS_CAP);
  assert.equal(receipts[0]!.hash, "h5");
  assert.equal(receipts.at(-1)!.hash, `h${RECEIPTS_CAP + 4}`);
});

test("findReceipt matches only the given task id, generation and hash", async () => {
  await seedTask("rs-find");
  const r = passing();
  await storeReceipt("rs-find", r, undefined, 1);
  const state = await loadSessionState("rs-find");
  const taskId = "approved-copy@1000";
  assert.equal(findReceipt(state, { taskId, generation: 0 })?.receipt, r.receipt);
  assert.equal(findReceipt(state, { taskId, generation: 0, hash: r.artifact_sha256 })?.receipt, r.receipt);
  assert.equal(findReceipt(state, { taskId, generation: 0, hash: "other" }), null);
  assert.equal(findReceipt(state, { taskId, generation: 1 }), null);
  assert.equal(findReceipt(state, { taskId: "approved-copy@999", generation: 0 }), null);
  assert.equal(findReceipt(state, { taskId: "draft-for-review@1000", generation: 0 }), null);
});

test("a generation jump (compact/clear/fork) expires the receipts", async () => {
  await seedTask("rs-gen");
  await storeReceipt("rs-gen", passing(), undefined);
  assert.equal((await loadSessionState("rs-gen")).receipts?.length, 1);
  await bumpTaskGeneration("rs-gen");
  const state = await loadSessionState("rs-gen");
  assert.equal(state.activeTask?.generation, 1);
  assert.equal(state.activeTask?.id, "approved-copy@1000", "the task itself carries over");
  assert.equal(state.receipts, undefined);
  assert.equal(currentReceipt(state), null);
});

test("the task ending (kind none) expires the receipts", async () => {
  await seedTask("rs-none", "draft-for-review");
  await storeReceipt("rs-none", passing(), undefined);
  await recordRulebookCheck("rs-none",{applicable:[],task:"none"},{entries:[],omitted:0});
  const state = await loadSessionState("rs-none");
  assert.equal(state.activeTask?.kind, "none");
  assert.equal(state.receipts, undefined);
});

test("the active-conventions block shows the receipt line while it is valid", async () => {
  await seedTask("rs-block");
  const r = passing();
  await storeReceipt("rs-block", r, undefined);
  const step = async () => runTaskStep({
    sessionId: "rs-block", snapshot: await loadSessionState("rs-block"), surface: "claude-code",
  });
  const short = r.receipt.slice("sha256:".length, "sha256:".length + 12);
  const shown = await step();
  assert.ok(shown?.includes(`receipt: ${short} (discord-dm, 2000 max(codepoints,utf16))`), shown ?? "null");
  await bumpTaskGeneration("rs-block");
  const gone = await step();
  assert.ok(gone !== null && !gone.includes("receipt:"), gone ?? "null");
  // Pure formatter: no receipt, no line.
  const block = formatActiveConventionsBlock({ task: "approved-copy", generation: 0, conventions: [], changed: [] });
  assert.ok(block !== null && !block.includes("receipt:"));
});
