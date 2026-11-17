/**
 * #1485 — Syncthing conflict copies are recognised by their documented name
 * plus the shared id, kept out of the index in favour of the original,
 * and listed for `bastra doctor`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { isConflictCopyName } from "../src/sync-conflict.js";

const note = (id: string, summary: string) =>
  `---\nid: ${id}\ntitle: Alpha\ntype: lesson\nsummary: ${summary}\nscope: demo\ntopic_path: [demo]\ntags: [demo]\nrecall_when: [checking alpha]\n---\n\n${summary}\n`;

async function vaultDir(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-1485-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("the documented Syncthing conflict name is recognised, guesses are not", () => {
  const original = "/v/memories/Alpha.md";
  assert.ok(isConflictCopyName("/v/memories/Alpha.sync-conflict-20261117-101500-ABCDEF1.md", original));
  // Undocumented service patterns are deliberately not guessed (#1485).
  for (const other of [
    "/v/memories/Alpha (1).md",
    "/v/memories/Alpha 2.md",
    "/v/memories/Alpha-MacBook-Pro.md",
    "/v/memories/Alpha (conflicted copy 2026-11-17 101500).md",
    "/v/memories/Alphabet.md",
    "/v/memories/Alpha.sync-conflict-2026-ABCDEF1.md",
    "/v/other/Alpha.sync-conflict-20261117-101500-ABCDEF1.md",
    "/v/memories/Alpha.sync-conflict-20261117-101500-ABCDEF1.txt",
    original,
  ]) {
    assert.ok(!isConflictCopyName(other, original), other);
  }
});

test("the original keeps the id and its conflict copy stays out", async (t) => {
  const dir = await vaultDir(t);
  await writeFile(join(dir, "Alpha.md"), note("alpha", "Corrected claim."));
  await writeFile(join(dir, "Alpha.sync-conflict-20261117-101500-ABCDEF1.md"), note("alpha", "Old claim."));
  const vault = new Vault(dir);
  const { skipped } = await vault.init();
  t.after(() => vault.stop());

  assert.equal(vault.get("alpha")?.filePath, join(dir, "Alpha.md"));
  assert.equal(vault.size(), 1, "indexed once");
  assert.deepEqual(vault.conflictCopies(), [
    { id: "alpha", copy: join(dir, "Alpha.sync-conflict-20261117-101500-ABCDEF1.md"), original: join(dir, "Alpha.md") },
  ]);
  assert.match(
    skipped.find((s) => s.path.endsWith("Alpha.sync-conflict-20261117-101500-ABCDEF1.md"))?.err ?? "",
    /duplicate id 'alpha'/
  );
});

test("an original arriving after its copy takes the id back as a change", async (t) => {
  const dir = await vaultDir(t);
  await writeFile(join(dir, "Alpha.sync-conflict-20261117-101500-ABCDEF1.md"), note("alpha", "Old claim."));
  const vault = new Vault(dir);
  await vault.init();
  t.after(() => vault.stop());
  const events: string[] = [];
  vault.on((e) => events.push(e.kind));

  await writeFile(join(dir, "Alpha.md"), note("alpha", "Corrected claim."));
  await vault.reindexFile(join(dir, "Alpha.md"));

  assert.equal(vault.get("alpha")?.filePath, join(dir, "Alpha.md"));
  assert.equal(vault.get("alpha")?.fm.summary, "Corrected claim.");
  assert.deepEqual(events, ["change"], "the id was already indexed — no second add");
  assert.equal(vault.conflictCopies()[0]?.copy, join(dir, "Alpha.sync-conflict-20261117-101500-ABCDEF1.md"));
});

test("two files with one id but unrelated names stay an ordinary duplicate", async (t) => {
  const dir = await vaultDir(t);
  await writeFile(join(dir, "Beta.md"), note("alpha", "One."));
  await writeFile(join(dir, "Gamma.md"), note("alpha", "Two."));
  const vault = new Vault(dir);
  await vault.init();
  t.after(() => vault.stop());
  assert.equal(vault.get("alpha")?.filePath, join(dir, "Beta.md"));
  assert.deepEqual(vault.conflictCopies(), []);
});

test("index precedence: a longer-named copy next to the original never wins at init", async (t) => {
  const dir = await vaultDir(t);
  await writeFile(join(dir, "Alpha.md"), note("alpha", "Corrected claim."));
  // Sorts before `Alpha.md` (" " < "."), which used to hand it the index.
  await writeFile(join(dir, "Alpha (1).md"), note("alpha", "Old claim."));
  const vault = new Vault(dir);
  const { skipped } = await vault.init();
  t.after(() => vault.stop());

  assert.equal(vault.get("alpha")?.filePath, join(dir, "Alpha.md"));
  assert.equal(vault.get("alpha")?.fm.summary, "Corrected claim.");
  assert.deepEqual(vault.pathsFor("alpha"), [join(dir, "Alpha.md"), join(dir, "Alpha (1).md")]);
  assert.match(skipped.find((s) => s.path.endsWith("Alpha (1).md"))?.err ?? "", /same id 'alpha' as Alpha\.md/);
  assert.deepEqual(vault.conflictCopies(), [], "only the documented Syncthing name is called a conflict copy");
});

test("index precedence: the original arriving after a longer-named copy takes the id back", async (t) => {
  const dir = await vaultDir(t);
  await writeFile(join(dir, "Alpha 2.md"), note("alpha", "Old claim."));
  const vault = new Vault(dir);
  await vault.init();
  t.after(() => vault.stop());
  const events: string[] = [];
  vault.on((e) => events.push(e.kind));

  await writeFile(join(dir, "Alpha.md"), note("alpha", "Corrected claim."));
  await vault.reindexFile(join(dir, "Alpha.md"));

  assert.equal(vault.get("alpha")?.filePath, join(dir, "Alpha.md"));
  assert.deepEqual(events, ["change"]);
});

test("index precedence: other folders keep the old first-path rule", async (t) => {
  const dir = await vaultDir(t);
  await mkdir(join(dir, "a"));
  await mkdir(join(dir, "b"));
  await writeFile(join(dir, "a", "Alpha (1).md"), note("alpha", "One."));
  await writeFile(join(dir, "b", "Alpha.md"), note("alpha", "Two."));
  const vault = new Vault(dir);
  await vault.init();
  t.after(() => vault.stop());
  assert.equal(vault.get("alpha")?.filePath, join(dir, "a", "Alpha (1).md"));
});
