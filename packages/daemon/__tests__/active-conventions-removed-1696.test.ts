/**
 * #1696: a rule whose note is gone from the index leaves the "Conventions in
 * force" block. A source that cannot be judged (read error, index not ready,
 * vault not reachable, unreadable files) keeps it with `revision=unknown`.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, saveMemory } from "@bastra-recall/core";
import { vaultConventionOf } from "../src/convention-source.js";
import { runTaskStep } from "../src/prompt-task.js";
import { loadSessionState, mutateSessionState } from "../src/session-state.js";

const stateDir = await mkdtemp(join(tmpdir(), "removed-1696-state-"));
process.env.BASTRA_HOOK_STATE_DIR = stateDir;
after(() => rm(stateDir, { recursive: true, force: true }));

async function fixture(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `removed-1696-${name}-`));
  const vault = new Vault(dir);
  after(async () => {
    await vault.stop();
    await rm(dir, { recursive: true, force: true });
  });
  await vault.init();
  const files: Record<string, string> = {};
  for (const id of ["doomed-rule", "kept-rule"]) {
    const m = await saveMemory(vault.root, {
      id,
      title: "Invented rule",
      summary: "Invented scope",
      body: "Invented body",
      type: "workflow",
      scope: "all-projects",
      write_origin: "user-directed",
      rulebook: "on-demand",
      applies_when: "For invented output",
      tags: ["fixture"],
      topic_path: ["fixture"],
      recall_when: ["invented-trigger"],
    });
    await vault.reindexFile(m.file_path);
    files[id] = m.file_path;
  }
  const sessionId = `removed-1696-${name}`;
  await mutateSessionState(sessionId, (s) => {
    s.activeConventions = ["doomed-rule", "kept-rule"].map((id) => ({
      id,
      revision: vault.get(id)?.revision ?? null,
      setAt: 1,
    }));
  });
  return { vault, files, sessionId };
}

async function block(sessionId: string, conventionOf: Parameters<typeof runTaskStep>[0]["conventionOf"]) {
  return runTaskStep({ sessionId, snapshot: await loadSessionState(sessionId), conventionOf, surface: "claude-code" });
}
const ids = async (sessionId: string) => (await loadSessionState(sessionId)).activeConventions?.map((c) => c.id);

test("a note removed from a ready index leaves the active-conventions block", async () => {
  const f = await fixture("removed");
  await unlink(f.files["doomed-rule"]);
  f.vault.forgetFile(f.files["doomed-rule"]);
  const out = await block(f.sessionId, vaultConventionOf(f.vault));
  assert.doesNotMatch(out ?? "", /doomed-rule/);
  assert.match(out ?? "", /- kept-rule revision=/);
  assert.deepEqual(await ids(f.sessionId), ["kept-rule"]);
});

test("a source read error keeps the id with revision=unknown", async () => {
  const f = await fixture("error");
  const out = await block(f.sessionId, async (id) => {
    if (id === "doomed-rule") throw new Error("source unavailable");
    return vaultConventionOf(f.vault)(id);
  });
  assert.match(out ?? "", /- doomed-rule revision=unknown/);
  assert.deepEqual(await ids(f.sessionId), ["doomed-rule", "kept-rule"]);
});

test("an index that cannot be trusted keeps the id", async () => {
  const f = await fixture("untrusted");
  const gone = { get: () => undefined };
  const cases: [string, Parameters<typeof vaultConventionOf>[0]][] = [
    ["index empty", { ...gone, size: () => 0, scanBlindSpots: () => [], root: f.vault.root }],
    ["unreadable files", { ...gone, size: () => 5, scanBlindSpots: () => ["/cloud-only.md"], root: f.vault.root }],
    ["vault not mounted", { ...gone, size: () => 5, scanBlindSpots: () => [], root: join(f.vault.root, "missing") }],
  ];
  for (const [label, vault] of cases) {
    const out = await block(f.sessionId, vaultConventionOf(vault));
    assert.match(out ?? "", /- doomed-rule revision=unknown/, label);
    assert.deepEqual(await ids(f.sessionId), ["doomed-rule", "kept-rule"], label);
  }
});
