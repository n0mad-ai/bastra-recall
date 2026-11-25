/**
 * #1696: a rule whose note is gone from the index leaves the "Conventions in
 * force" block. A source that cannot be judged (read error, index not ready,
 * vault not reachable, unreadable files) keeps it with `revision=unknown`.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  await block(sessionId, vaultConventionOf(vault));
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
  await f.vault.reconcile();
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
  const cases: [string, Parameters<typeof vaultConventionOf>[0]][] = [
    ["index empty", new Vault(join(f.vault.root, "empty"))],
    [
      "unreadable files",
      { get: () => undefined, indexRootIdentity: () => f.vault.indexRootIdentity(), confirmsAbsent: async () => false },
    ],
    ["vault not mounted", new Vault(join(f.vault.root, "missing"))],
  ];
  for (const [label, vault] of cases) {
    const out = await block(f.sessionId, vaultConventionOf(vault));
    assert.match(out ?? "", /- doomed-rule revision=unknown/, label);
    assert.deepEqual(await ids(f.sessionId), ["doomed-rule", "kept-rule"], label);
  }
});

test("a watcher unlink before the matching add keeps the moved rule in force", async () => {
  const f = await fixture("move");
  const path = join(f.vault.root, "renamed-rule.md");
  await rename(f.files["doomed-rule"], path);
  f.vault.forgetFile(f.files["doomed-rule"]);
  const out = await block(f.sessionId, vaultConventionOf(f.vault));
  assert.match(out ?? "", /- doomed-rule revision=unknown/);
  await f.vault.reconcile();
  await block(f.sessionId, vaultConventionOf(f.vault));
  assert.deepEqual(await ids(f.sessionId), ["doomed-rule", "kept-rule"]);
  assert.equal(f.vault.get("doomed-rule")?.filePath, path);
});

test("a populated index in another vault cannot confirm the original rule was removed", async () => {
  const original = await fixture("first-profile");
  const other = await fixture("second-profile");
  await unlink(other.files["doomed-rule"]);
  await other.vault.reconcile();
  await other.vault.reconcile();
  assert.equal(await other.vault.confirmsAbsent("doomed-rule"), true);
  await block(original.sessionId, vaultConventionOf(other.vault));
  assert.deepEqual(await ids(original.sessionId), ["doomed-rule", "kept-rule"]);
});

test("a different directory mounted at the vault path cannot confirm a removal", async () => {
  const f = await fixture("replaced-root");
  const displaced = `${f.vault.root}-displaced`;
  await rename(f.vault.root, displaced);
  after(() => rm(displaced, { recursive: true, force: true }));
  await mkdir(dirname(f.files["kept-rule"]), { recursive: true });
  await copyFile(join(displaced, f.files["kept-rule"].slice(f.vault.root.length + 1)), f.files["kept-rule"]);
  f.vault.forgetFile(f.files["doomed-rule"]);
  await f.vault.reconcile();
  const out = await block(f.sessionId, vaultConventionOf(f.vault));
  assert.match(out ?? "", /- doomed-rule revision=unknown/);
  assert.deepEqual(await ids(f.sessionId), ["doomed-rule", "kept-rule"]);
});

test("a source removed while the daemon was stopped can be retired after reopening the same vault", async () => {
  const f = await fixture("restart");
  await unlink(f.files["doomed-rule"]);
  const reopened = new Vault(f.vault.root);
  await reopened.init();
  await block(f.sessionId, vaultConventionOf(reopened));
  assert.deepEqual(await ids(f.sessionId), ["kept-rule"]);
});
