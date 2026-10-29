import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JoinState } from "../src/telemetry-join-state.js";
import type { EventSink } from "../src/telemetry-sink.js";
import { validateArtifactHandler } from "../src/validate-artifact-handler.js";
import { callerSessionStore } from "../src/caller-session.js";
import { mutateSessionState } from "../src/session-state.js";
import { Telemetry } from "../src/telemetry.js";
import { readEvents } from "../src/cli/log-stats.js";

test("hook joins preserve legacy access while isolating session slots across persistence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-convention-joins-"));
  const path = join(dir, "join.json");
  const events: Record<string, unknown>[] = [];
  const sink = { write: async (e: Record<string, unknown>) => { events.push(e); } } as unknown as EventSink;
  const create = () => new JoinState({ enabled: true, sessionId: "daemon", joinStatePath: path, sink });
  try {
    const state = create();
    state.recordHookHints("recall-a", [{ id: "m", score: 100 }], "a");
    state.recordHookHints("recall-b", [{ id: "m", score: 50 }], "b");
    assert.equal(state.findHookHintFor("m")?.recall_id, "recall-b");
    assert.equal(state.findHookHintFor("m", "a")?.recall_id, "recall-a");
    assert.equal(state.findHookHintFor("m", "b")?.recall_id, "recall-b");
    assert.equal(state.findHookHintFor("m", "other"), null); assert.equal(state.findHookHintFor("m", null), null);
    await state.flushNow();
    const restored = create(); restored.restoreFromDisk();
    assert.equal(restored.findHookHintFor("m", "a")?.recall_id, "recall-a");
    // Shown evidence exists even before rotateTurn or for an unknown session;
    // neither opens a cross-session token-overlap window.
    restored.recordSurfacedHints([{ memory_id: "m", distinctive_tokens: [] }], "a");
    restored.recordSurfacedHints([{ memory_id: "m", distinctive_tokens: [] }], null);
    assert.equal(events[0].kind, "convention_shown"); assert.equal(events[0].session_id, "a");
    assert.equal(events[1].session_known, false);
    restored.rotateTurn("a");
    restored.recordLoadedMemory({ memory_id: "m", distinctive_tokens: ["deployment", "database"], hook_hint: null, session_id: "a" });
    assert.deepEqual(restored.matchLoadedMemories({ tool_name: "Edit", tool_input_excerpt: "deployment database", session_id: "b" }), []);
    assert.equal(restored.matchLoadedMemories({ tool_name: "Edit", tool_input_excerpt: "deployment database", session_id: "a" }).length, 1);
    await restored.flushNow();
    // Version-one snapshots with only the historical global Map still load.
    await writeFile(path, JSON.stringify({ version: 1, hookHints: [["old", { recall_id: "old-recall", rank: 1, score: null, ts: Date.now() }]] }));
    const legacy = create(); legacy.restoreFromDisk();
    assert.equal(legacy.findHookHintFor("old")?.recall_id, "old-recall");
    assert.equal(legacy.findHookHintFor("old", "a"), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("validator logs passing, failed and unattributed attempts without raw artifact text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-convention-validator-"));
  const old = process.env.BASTRA_HOOK_STATE_DIR;
  process.env.BASTRA_HOOK_STATE_DIR = dir;
  try {
    const telemetry = new Telemetry({ logDir: dir });
    await mutateSessionState("validator-session", s => { s.activeTask = { id: "approved-copy@1", kind: "approved-copy", since: 1, generation: 2 }; });
    const args = { text: "Private synthetic content never belongs in telemetry", channel: "discord-dm", normalize: "none", task: { kind: "approved-copy", generation: 2 }, rule: { id: "rule", revision: "rev" } };
    await callerSessionStore.run("validator-session", () => validateArtifactHandler(args, { telemetry }));
    await callerSessionStore.run("validator-session", () => validateArtifactHandler({ ...args, text: "> invalid quote" }, { telemetry }));
    await validateArtifactHandler(args, { telemetry });
    const rows = (await readEvents(dir, 0)).filter(e => e.kind === "convention_validation");
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(e => [e.result, e.session_known, e.receipt_stored]), [["pass", true, true], ["fail", true, false], ["pass", false, false]]);
    assert.equal(rows[0].caller_session, "validator-session"); assert.equal(rows[0].task_kind, "approved-copy");
    assert.equal(rows[0].rule_revision, "rev"); assert.equal(rows[0].generation, 2);
    assert.equal(rows[2].caller_session, null);
    assert.ok(!JSON.stringify(rows).includes(args.text)); assert.ok(!JSON.stringify(rows).includes("invalid quote"));
  } finally {
    if (old === undefined) delete process.env.BASTRA_HOOK_STATE_DIR; else process.env.BASTRA_HOOK_STATE_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});
