import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGateLane } from "../src/gate-lane.js";
import { beginRulebookRound, recordRulebookCheck, requireActionRules, rulebookBoundary, recordRulebookLoad, roundCorrespondence } from "../src/rulebook-check.js";
import { clearShown, loadSessionState, mutateSessionState } from "../src/session-state.js";
import type { KernelCandidates } from "../src/rulebook-catalog.js";
import type { Memory } from "@bastra-recall/core";

const ref = { id: "audit-copy", revision: "r1" };
const catalog: KernelCandidates = { entries: [{ ...ref, title: "Fixture", group: "explicit", updated: null, stale_status: "unknown", body: "Fixture", rulebook: "on-demand", applies_when: "Fixture", rule_categories: ["correspondence"], validator: { tool: "validate_artifact", channel: "discord-dm", unit: "utf16", limit: 2000 } }], omitted: 0 };
const p = (session_id: string, agent_id?: string) => ({ session_id, ...(agent_id ? { agent_id } : {}), bastra_client: "claude-code", hook_event_name: "PreToolUse", tool_name: "fixture_send_message", tool_input: {} });
const denied = (out: string | undefined) => out && JSON.parse(out).hookSpecificOutput?.permissionDecision === "deny";
const reflex = { fm: { id: "audit-reflex", title: "Fixture", summary: "Fixture", type: "workflow", scope: "all-projects", recall_mode: "reflex", write_origin: "user-directed", salience: 0.9, recall_when: ["fixture_send_message"] }, body: "Fixture reflex body." } as Memory;
let root: string;
before(async () => { root = await mkdtemp(join(tmpdir(), "rulebook-lifecycle-audit-")); process.env.BASTRA_HOOK_STATE_DIR = root; process.env.BASTRA_TELEMETRY = "off"; });
after(() => rm(root, { recursive: true, force: true }));

test("audit 6: clearShown rearms real reflex denial after context loss", async () => {
  const sid = "reflex-context", deps = { reflexPool: () => [reflex] };
  assert.equal(denied(await runGateLane(p(sid), deps)), true);
  assert.equal(await runGateLane(p(sid), deps), "{}");
  await mutateSessionState(sid, s => { s.shown = { fixture: { count: 1, at: Date.now() } }; });
  await clearShown(sid);
  assert.equal(denied(await runGateLane(p(sid), deps)), true);
});

test("audit 6: deniedReflex alone prevents clearShown early return", async () => {
  const sid = "reflex-only";
  await mutateSessionState(sid, s => { s.deniedReflex = ["audit-reflex"]; });
  await clearShown(sid);
  assert.equal((await loadSessionState(sid)).deniedReflex, undefined);
});

test("audit 7: exact action exception expires next round for main and worker", async () => {
  for (const agent of [undefined, "worker"]) {
    const sid = `dismiss-${agent ?? "main"}`, payload = p(sid, agent);
    await beginRulebookRound(payload, catalog);
    await requireActionRules(payload, [ref]);
    assert.equal((await recordRulebookCheck(sid, { applicable: [], agent_id: agent, not_applicable: [{ id: ref.id, reason: "This round has no copy action." }] }, catalog)).ok, true);
    await requireActionRules(payload, [ref]);
    assert.equal(await rulebookBoundary(payload, catalog, "action", { requiredOnly: true }), "{}");
    await beginRulebookRound(payload, catalog);
    await requireActionRules(payload, [ref]);
    assert.equal(denied(await rulebookBoundary(payload, catalog, "action", { requiredOnly: true })), true);
  }
});

test("audit 7: pending obligations and actual loads survive round reset without worker leakage", async () => {
  const sid = "pending-actors", main = p(sid), worker = p(sid, "worker");
  await requireActionRules(main, [ref]);
  await requireActionRules(worker, [ref]);
  await recordRulebookLoad(sid, ref.id, undefined, { revision: ref.revision, rulebookMetadata: { rulebook: "on-demand" } } as any);
  await beginRulebookRound(main, catalog);
  await requireActionRules(main, [ref]);
  assert.equal(await rulebookBoundary(main, catalog, "action", { requiredOnly: true }), "{}");
  assert.equal(denied(await rulebookBoundary(worker, catalog, "action", { requiredOnly: true })), true);
});

test("new round decisions can dismiss inherited task rules without changing stage", async () => {
  const sid = "ongoing-task";
  await recordRulebookCheck(sid, { applicable: [ref.id], task: "draft-for-review" }, catalog);
  await beginRulebookRound(p(sid), catalog);
  const result = await recordRulebookCheck(sid, { applicable: [], not_applicable: [{ id: ref.id, reason: "This new round has no copy artifact." }] }, catalog);
  assert.equal(result.ok, true);
  assert.equal((await loadSessionState(sid)).activeTask?.kind, "draft-for-review");
  assert.ok(!roundCorrespondence(await loadSessionState(sid), p(sid)).rules.some(r => r.id === ref.id));
  await recordRulebookCheck(sid, {applicable:[ref.id]}, catalog);
  assert.equal((await recordRulebookCheck(sid, {applicable:[],not_applicable:[{id:ref.id,reason:"Attempt to dismiss this round declaration"}]},catalog)).ok,false);
  assert.ok(roundCorrespondence(await loadSessionState(sid), p(sid)).rules.some(r => r.id === ref.id));
});
