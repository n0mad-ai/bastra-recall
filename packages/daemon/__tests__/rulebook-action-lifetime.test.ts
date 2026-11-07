/** #1372: an action's must-load obligation belongs to that action and ends with it. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beginRulebookRound, recordRulebookCheck, requireActionRules, rulebookBoundary } from "../src/rulebook-check.js";
import { loadSessionState } from "../src/session-state.js";
import type { KernelCandidates } from "../src/rulebook-catalog.js";

const ref = { id: "invented-issue-rule", revision: "r1" };
const entry = { ...ref, title: "Invented", group: "explicit" as const, updated: null, stale_status: "unknown" as const, body: "", rulebook: "on-demand" as const };
const actionCatalog: KernelCandidates = { entries: [entry], omitted: 0 };
const fullCatalog: KernelCandidates = { entries: [entry, { ...entry, id: "invented-other-rule" }], omitted: 0 };
const p = (session_id: string, agent_id?: string) => ({ session_id, ...(agent_id ? { agent_id } : {}), bastra_client: "claude-code" });
const denied = (out: string | undefined) => !!out && JSON.parse(out).hookSpecificOutput?.permissionDecision === "deny";
let root: string;
before(async () => { root = await mkdtemp(join(tmpdir(), "rulebook-action-lifetime-")); process.env.BASTRA_HOOK_STATE_DIR = root; process.env.BASTRA_TELEMETRY = "off"; });
after(() => rm(root, { recursive: true, force: true }));

for (const agent of [undefined, "worker"]) {
  test(`a GitHub write that passed leaves no obligation for the next round's save_memory (${agent ?? "main"})`, async () => {
    const sid = `passed-${agent ?? "main"}`, payload = p(sid, agent);
    await beginRulebookRound(payload, fullCatalog);
    // The GitHub action gets its rule first: two denials, then the bounded gate lets it pass.
    for (const expected of [true, true, false]) {
      await requireActionRules(payload, [ref]);
      assert.equal(denied(await rulebookBoundary(payload, actionCatalog, "action", { requiredOnly: true })), expected);
    }
    const a = JSON.parse((await loadSessionState(sid)).rulebookCheck!).actors.find((x: { key: string }) => x.key === (agent ? `agent:${agent}` : "main"));
    assert.deepEqual(a.required, []);
    await beginRulebookRound(payload, fullCatalog);
    assert.equal((await recordRulebookCheck(sid, { applicable: [], ...(agent ? { agent_id: agent } : {}) }, fullCatalog)).ok, true);
    assert.equal(await rulebookBoundary(payload, fullCatalog, "action"), "{}");
  });
}

test("a dropped GitHub write cannot block an unrelated tool, but its retry still gets the rule", async () => {
  const sid = "dropped", payload = p(sid);
  await beginRulebookRound(payload, fullCatalog);
  await requireActionRules(payload, [ref]);
  assert.equal(denied(await rulebookBoundary(payload, actionCatalog, "action", { requiredOnly: true })), true);
  await beginRulebookRound(payload, fullCatalog);
  assert.equal((await recordRulebookCheck(sid, { applicable: [] }, fullCatalog)).ok, true);
  assert.equal(await rulebookBoundary(payload, fullCatalog, "action"), "{}");
  await requireActionRules(payload, [ref]);
  const retry = await rulebookBoundary(payload, actionCatalog, "action", { requiredOnly: true });
  assert.equal(denied(retry), true);
  assert.match(JSON.parse(retry!).hookSpecificOutput.permissionDecisionReason, /MUST-LOAD.*invented-issue-rule/);
});
