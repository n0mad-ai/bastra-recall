import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { saveMemoryHandler, type SaveMemoryResult } from "../src/save-memory-handler.js";
import type { ToolDeps } from "../src/tool-deps.js";

const base = { title: "Invented write status", summary: "Invented fixture summary", body: "Keep invented artifacts complete.",
  topic_path: ["fixture"], tags: ["fixture"], scope: "all-projects" };

async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<ToolDeps> {
  const root = await mkdtemp(join(tmpdir(), "bastra-rulebook-write-status-"));
  const stateDir = process.env.BASTRA_HOOK_STATE_DIR;
  process.env.BASTRA_HOOK_STATE_DIR = join(root, "state");
  const vault = new Vault(root); await vault.init(); const search = new SearchIndex(vault); search.start();
  t.after(async () => { search.stop(); await vault.stop();
    if (stateDir === undefined) delete process.env.BASTRA_HOOK_STATE_DIR; else process.env.BASTRA_HOOK_STATE_DIR = stateDir;
    await rm(root, { recursive: true, force: true }); });
  return { vault, search, telemetry: new Telemetry(), vaultPath: root };
}

test("#1384: every save_memory response names the delivery tier; a user-directed behavioural note without rulebook says it is no rule", async (t) => {
  const deps = await fixture(t);
  const save = async (args: Record<string, unknown>) => (await saveMemoryHandler(deps, { ...base, recall_when: [`invented ${args.id}`], ...args })) as SaveMemoryResult;

  const note = await save({ id: "user-lesson", type: "lesson", write_origin: "user-directed" });
  assert.match(note.delivery ?? "", /^note only/);
  assert.match(note.delivery ?? "", /not a rule/);
  assert.match(note.delivery ?? "", /rulebook \+ applies_when/);

  const agentNote = await save({ id: "agent-lesson", type: "lesson" });
  assert.match(agentNote.delivery ?? "", /^note only/);
  assert.doesNotMatch(agentNote.delivery ?? "", /rulebook \+ applies_when/);

  const always = await save({ id: "user-rule", type: "lesson", write_origin: "user-directed", rulebook: "always", applies_when: "When writing fixtures" });
  assert.match(always.delivery ?? "", /^rule \(always\): active now/);

  const onDemand = await save({ id: "user-on-demand", type: "lesson", write_origin: "user-directed", rulebook: "on-demand", applies_when: "When writing fixtures" });
  assert.match(onDemand.delivery ?? "", /^rule \(on-demand\): active now/);

  const proposal = await save({ id: "agent-proposal", type: "lesson", rulebook: "always", applies_when: "When writing fixtures" });
  assert.match(proposal.delivery ?? "", /^proposal \(not active\)/);

  // Legacy membership: a user-directed workflow is an on-demand rule even without rulebook.
  const legacy = await save({ id: "user-workflow", type: "workflow", write_origin: "user-directed" });
  assert.match(legacy.delivery ?? "", /^rule \(on-demand\): active now/);
  assert.match(legacy.delivery ?? "", /applies_when/);
});
