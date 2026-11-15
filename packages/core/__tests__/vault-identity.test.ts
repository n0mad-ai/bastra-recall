/**
 * #240/A2 — the vault's identity events must keep every downstream index
 * (BM25, vectors) in step with the map.
 *
 * Three ways the index used to drift and never recover, not even through
 * reconcile() — only a daemon restart healed them:
 *  1. an in-place `id:` change emitted only `change(new)`, so the old id
 *     lived on in SearchIndex as a hit that load_memory could not resolve.
 *  2. a file that stopped parsing (plain note, or YAML broken during an
 *     Obsidian edit) left the LAST VALID node in the index, so recall served
 *     pre-edit content as current.
 *  3. two files carrying one id both pointed at the same map entry; removing
 *     the shadowed one deleted the winner while its file sat on disk.
 *  4. reconcile() treated the quarantined path as new, overwrote the winner
 *     in the map, and MiniSearch threw `duplicate ID` on the add — recall
 *     and load_memory then disagreed about which body the id held.
 *  5. an id edited onto an already-claimed id was skipped before the old
 *     mapping was released, so the file's previous id lived on as a ghost
 *     with the pre-edit body.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, unlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Vault } from "../src/vault.js";
import { SearchIndex } from "../src/search.js";

function memoryMd(id: string, marker: string): string {
  return `---
id: ${id}
title: Title ${id}
summary: summary ${marker}
type: lesson
topic_path: [test]
tags: [test]
scope: test
recall_when: ["when ${marker}"]
created: 2026-05-01
updated: 2026-05-01
---

Body ${marker}.
`;
}

async function indexed(t: { after: (fn: () => unknown) => void }, files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-identity-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, "utf8");
  }
  const vault = new Vault(dir);
  const init = await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { dir, vault, search, init };
}

test("an in-place id change leaves no ghost in the search index", async (t) => {
  const { dir, vault, search } = await indexed(t, {
    "note.md": memoryMd("old-id", "ZEPPELINWORD"),
  });
  assert.equal(search.recall("ZEPPELINWORD", { k: 5 })[0]?.id, "old-id");

  await writeFile(path.join(dir, "note.md"), memoryMd("new-id", "KRAKENWORD"), "utf8");
  await vault.reindexFile(path.join(dir, "note.md"));

  assert.equal(vault.get("old-id"), undefined, "the old id is gone from the vault");
  assert.equal(search.recall("KRAKENWORD", { k: 5 })[0]?.id, "new-id");
  assert.deepEqual(
    search.recall("ZEPPELINWORD", { k: 5 }).map((h) => h.id),
    [],
    "the old id must not survive as a dangling search hit"
  );
});

test("a file that stops parsing drops out of the index instead of going stale", async (t) => {
  const { dir, vault, search } = await indexed(t, {
    "note.md": memoryMd("mem-a", "OBELISKWORD"),
  });
  assert.equal(search.recall("OBELISKWORD", { k: 5 })[0]?.id, "mem-a");

  // The classic Obsidian accident: an unquoted colon breaks the YAML.
  await writeFile(path.join(dir, "note.md"), "just a plain note now\n", "utf8");
  await vault.reindexFile(path.join(dir, "note.md"));

  assert.equal(vault.get("mem-a"), undefined, "the stale node must be dropped");
  assert.deepEqual(
    search.recall("OBELISKWORD", { k: 5 }).map((h) => h.id),
    [],
    "pre-edit content must not be served as current"
  );
});

test("a transient read failure keeps the last-known-good node", async (t) => {
  // The regression the A2.2 fix introduced: read() bundled I/O and parsing,
  // so an ENOENT/EIO/EACCES — or an unmaterialised cloud placeholder, which
  // is the everyday case on the GoogleDrive/iCloud mounts this repo targets —
  // was treated as "no longer a memory" and evicted a perfectly good node.
  const { dir, vault, search } = await indexed(t, {
    "note.md": memoryMd("cloud-valid", "PLACEHOLDERWORD"),
  });
  const file = path.join(dir, "note.md");
  const stashed = path.join(dir, "note.md.stashed");

  await rename(file, stashed); // file momentarily unreadable at its path
  await vault.reindexFile(file);

  assert.equal(vault.get("cloud-valid")?.fm.id, "cloud-valid", "an unreadable file must not evict the indexed version");
  assert.equal(search.recall("PLACEHOLDERWORD", { k: 5 })[0]?.id, "cloud-valid");

  // …and a real deletion still removes it, through the unlink path.
  await rename(stashed, file);
  await unlink(file);
  await vault.reconcile();
  assert.equal(vault.get("cloud-valid"), undefined, "a real delete still drops the node");
});

test("a file that becomes valid again is indexed again", async (t) => {
  const { dir, vault } = await indexed(t, { "note.md": memoryMd("mem-a", "OBELISKWORD") });

  await writeFile(path.join(dir, "note.md"), "broken\n", "utf8");
  await vault.reindexFile(path.join(dir, "note.md"));
  assert.equal(vault.get("mem-a"), undefined);

  await writeFile(path.join(dir, "note.md"), memoryMd("mem-a", "REPAIREDWORD"), "utf8");
  await vault.reindexFile(path.join(dir, "note.md"));
  assert.equal(vault.get("mem-a")?.fm.id, "mem-a", "dropping is temporary, not permanent");
});

test("duplicate ids are reported and quarantined, not silently merged", async (t) => {
  const { init } = await indexed(t, {
    "a-first.md": memoryMd("dup-id", "AAAWORD"),
    "z-second.md": memoryMd("dup-id", "ZZZWORD"),
  });

  assert.equal(init.loaded, 1, "only one file may claim the id");
  assert.equal(init.skipped.length, 1, "the other must be reported, not swallowed");
  assert.match(init.skipped[0].err, /duplicate id 'dup-id'/);
  assert.ok(init.skipped[0].path.endsWith("z-second.md"), "first path wins deterministically");
});

test("removing a shadowed duplicate does not delete the winner", async (t) => {
  const { dir, vault, search } = await indexed(t, {
    "a-first.md": memoryMd("dup-id", "AAAWORD"),
    "z-second.md": memoryMd("dup-id", "ZZZWORD"),
  });
  assert.equal(vault.size(), 1);

  // Cleaning up the cloud-sync conflict copy must not take the original.
  await unlink(path.join(dir, "z-second.md"));
  await vault.reconcile();

  assert.equal(vault.size(), 1, "the winner must survive its shadow being deleted");
  assert.equal(vault.get("dup-id")?.filePath, path.join(dir, "a-first.md"));
  assert.equal(search.recall("AAAWORD", { k: 5 })[0]?.id, "dup-id");
});

test("reconcile does not promote a quarantined duplicate into the index", async (t) => {
  const { dir, vault, search } = await indexed(t, {
    "a-first.md": memoryMd("dup-id", "AAAWORD"),
    "z-second.md": memoryMd("dup-id", "ZZZWORD"),
  });
  assert.equal(vault.get("dup-id")?.filePath, path.join(dir, "a-first.md"));
  assert.match(vault.get("dup-id")?.body ?? "", /AAAWORD/);

  await vault.reconcile();

  assert.equal(vault.size(), 1, "the shadow must stay out of the map");
  assert.equal(
    vault.get("dup-id")?.filePath,
    path.join(dir, "a-first.md"),
    "first path keeps the claim — load_memory must not start serving the copy"
  );
  assert.match(vault.get("dup-id")?.body ?? "", /AAAWORD/);
  assert.equal(search.recall("AAAWORD", { k: 5 })[0]?.id, "dup-id");
  assert.deepEqual(
    search.recall("ZZZWORD", { k: 5 }).map((h) => h.id),
    [],
    "the copy's body must not enter BM25 either"
  );
});

test("when the winner vanishes, reconcile lets the remaining duplicate claim the id", async (t) => {
  const { dir, vault, search } = await indexed(t, {
    "a-first.md": memoryMd("dup-id", "AAAWORD"),
    "z-second.md": memoryMd("dup-id", "ZZZWORD"),
  });

  await unlink(path.join(dir, "a-first.md"));
  await vault.reconcile();

  assert.equal(vault.size(), 1, "the leftover copy becomes the memory");
  assert.equal(vault.get("dup-id")?.filePath, path.join(dir, "z-second.md"));
  assert.match(vault.get("dup-id")?.body ?? "", /ZZZWORD/);
  assert.equal(search.recall("ZZZWORD", { k: 5 })[0]?.id, "dup-id");
});

test("an id edited onto a claimed id releases the file's old id instead of leaving a ghost", async (t) => {
  const { dir, vault, search } = await indexed(t, {
    "note.md": memoryMd("foo", "FOOWORD"),
    "other.md": memoryMd("bar", "BARWORD"),
  });
  assert.equal(search.recall("FOOWORD", { k: 5 })[0]?.id, "foo");

  // The edit turns note.md into a second claimant of `bar`. The skip is
  // right — other.md keeps the claim — but `foo` must not survive it.
  await writeFile(path.join(dir, "note.md"), memoryMd("bar", "FOOWORD"), "utf8");
  await vault.reindexFile(path.join(dir, "note.md"));

  assert.equal(vault.size(), 1);
  assert.equal(vault.get("foo"), undefined, "the old id must not outlive the edit");
  assert.deepEqual(
    search.recall("FOOWORD", { k: 5 }).map((h) => h.id),
    [],
    "the pre-edit body must leave BM25 with the old id"
  );
  assert.equal(vault.get("bar")?.filePath, path.join(dir, "other.md"), "the claim stays with the first path");

  // Once the winner is gone, the edited file is a free claimant again.
  await unlink(path.join(dir, "other.md"));
  await vault.reconcile();
  assert.equal(vault.get("bar")?.filePath, path.join(dir, "note.md"));
  assert.equal(search.recall("FOOWORD", { k: 5 })[0]?.id, "bar");
});
