import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Vault } from "../src/vault.js";
import { mutateMemoryFile } from "../src/memory-mutate.js";

function memoryMd(id: string, title = `Title ${id}`): string {
  return `---
id: ${id}
title: ${title}
type: lesson
summary: summary for ${id}
topic_path: [test]
tags: [test]
scope: test
recall_when: ["when ${id}"]
created: 2026-05-01
updated: 2026-05-01
---

Body of ${id}.
`;
}

async function freshVault(ids: string[]): Promise<{ dir: string; vault: Vault }> {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-vault-reconcile-"));
  for (const id of ids) await writeFile(path.join(dir, `${id}.md`), memoryMd(id), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  // No startWatching() — so external disk changes stay invisible until reconcile,
  // exactly the cloud-mount drift this method exists to fix.
  return { dir, vault };
}

test("reconcile: picks up a file added externally (watcher missed)", async () => {
  const { dir, vault } = await freshVault(["a", "b", "c"]);
  try {
    assert.equal(vault.size(), 3);
    await writeFile(path.join(dir, "d.md"), memoryMd("d"), "utf8"); // external add
    assert.equal(vault.size(), 3, "size still stale before reconcile");
    assert.equal(await vault.reconcile(), 4);
    assert.equal(vault.size(), 4);
    assert.ok(vault.get("d"), "newly added memory is now in the index");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("reconcile: drops an index entry whose file was deleted", async () => {
  const { dir, vault } = await freshVault(["a", "b", "c"]);
  try {
    await rm(path.join(dir, "b.md")); // external delete
    assert.equal(vault.size(), 3, "size still stale before reconcile");
    assert.equal(await vault.reconcile(), 2);
    assert.equal(vault.get("b"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("reconcile: ignores non-memory .md files", async () => {
  const { dir, vault } = await freshVault(["a", "b"]);
  try {
    await writeFile(path.join(dir, "note.md"), "# Just an Obsidian note\n\nno frontmatter.\n", "utf8");
    assert.equal(await vault.reconcile(), 2, "plain note is not counted");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("reconcile: heals an in-place edit from an external process (#199)", async () => {
  const { dir, vault } = await freshVault(["a", "b"]);
  try {
    // rewrite a.md at the watcher's back — retitled, like the 243-file repro
    await writeFile(path.join(dir, "a.md"), memoryMd("a", "Retitled externally"), "utf8");
    assert.equal(vault.get("a")?.fm.title, "Title a", "index still serves the stale title");
    assert.equal(await vault.reconcile(), 2, "count unchanged — same files, new content");
    assert.equal(vault.get("a")?.fm.title, "Retitled externally", "reconcile healed the drift");
    assert.equal(vault.get("b")?.fm.title, "Title b", "untouched file untouched");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("reconcile: in-place edit that changes the id remaps cleanly", async () => {
  const { dir, vault } = await freshVault(["a", "b"]);
  try {
    await writeFile(path.join(dir, "b.md"), memoryMd("b-renamed"), "utf8");
    assert.equal(await vault.reconcile(), 2);
    assert.equal(vault.get("b"), undefined, "old id dropped");
    assert.equal(vault.get("b-renamed")?.fm.title, "Title b-renamed");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/**
 * #341: an enrichment rewrite keeps the file's mtime, so `reconcile()`'s
 * stat-compare can no longer see it — and in the worst case the size is
 * unchanged too (one frontmatter value swapped for another of equal length).
 * The reindex must not depend on that comparison: the process that writes
 * updates the index itself (`reindexFile`, what both enrichers do), and a
 * later reconcile must leave that entry alone instead of reverting it.
 */
test("#341: eine mtime-erhaltende Anreicherung bleibt im Index — auch bei gleicher Dateigröße", async () => {
  const { dir, vault } = await freshVault(["a"]);
  try {
    const file = path.join(dir, "a.md");
    const enrich = (src: string) =>
      mutateMemoryFile(
        file,
        "a",
        {
          frontmatter: (fm) => ({ ...fm, recall_when_expanded_src: src }),
          authoredContent: (body) => body,
        },
        { vaultRoot: dir },
      );

    assert.equal((await enrich("aaaaaaaa")).kind, "written");
    await vault.reindexFile(file);
    const stamped = await stat(file);

    assert.equal((await enrich("bbbbbbbb")).kind, "written");
    await vault.reindexFile(file);
    const after = await stat(file);
    assert.equal(after.mtimeMs, stamped.mtimeMs, "mtime unverändert");
    assert.equal(after.size, stamped.size, "gleiche Dateigröße — der Randfall");
    assert.equal(vault.get("a")?.fm.recall_when_expanded_src, "bbbbbbbb");

    await vault.reconcile();
    assert.equal(
      vault.get("a")?.fm.recall_when_expanded_src,
      "bbbbbbbb",
      "reconcile lässt den selbst gesetzten Eintrag stehen",
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("reconcile: no changes → count stable", async () => {
  const { dir, vault } = await freshVault(["a", "b", "c"]);
  try {
    assert.equal(await vault.reconcile(), 3);
    assert.equal(await vault.reconcile(), 3, "idempotent");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
