import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Vault } from "../src/vault.js";

function memoryMd(id: string, title: string): string {
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

async function setupVault(count: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-vault-init-"));
  // Spread Memories über ein paar Sub-Folder, damit walkDir gefordert wird.
  for (let i = 0; i < count; i++) {
    const sub = path.join(dir, `folder-${i % 5}`);
    await mkdir(sub, { recursive: true });
    const id = `mem-${String(i).padStart(4, "0")}`;
    await writeFile(path.join(sub, `${id}.md`), memoryMd(id, `Memory ${i}`));
  }
  return dir;
}

test("vault.init loads 100 memories in parallel", async () => {
  const dir = await setupVault(100);
  try {
    const vault = new Vault(dir);
    const t0 = performance.now();
    const result = await vault.init();
    const dt = performance.now() - t0;
    assert.equal(result.loaded, 100);
    assert.equal(result.skipped.length, 0);
    assert.equal(vault.size(), 100);
    // Smoke-bound: parallel-load von 100 trivialen MDs sollte < 1s sein.
    assert.ok(dt < 5000, `init took ${dt.toFixed(0)}ms (expected < 5000)`);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("vault.init order is deterministic (sorted by path)", async () => {
  const dir = await setupVault(50);
  try {
    // Zweimal laden, beide Iterationsordnungen vergleichen.
    const v1 = new Vault(dir);
    await v1.init();
    const ids1 = v1.list().map((m) => m.fm.id);

    const v2 = new Vault(dir);
    await v2.init();
    const ids2 = v2.list().map((m) => m.fm.id);

    assert.deepEqual(ids1, ids2, "iteration order must be stable across init()");
    assert.equal(ids1.length, 50);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("vault.init repairs a malformed file instead of dropping it (#222), and still ignores plain notes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-vault-malformed-"));
  try {
    await writeFile(path.join(dir, "good.md"), memoryMd("good", "Good"));
    // Frontmatter with a type but nothing else. This used to land in
    // skipped[] and vanish from the index — the silent loss #222 is about.
    // It now loads with a `damaged` marker, because a note the user can still
    // see in Obsidian must not be invisible to recall.
    await writeFile(
      path.join(dir, "broken.md"),
      `---
type: lesson
id: broken
---

no title, no summary, no topic_path → repaired, not dropped.
`
    );
    // Plain Obsidian note without a memory `type:` → silent skip, unchanged:
    // structural strictness is what keeps the vault scan from swallowing
    // ordinary notes, and #222 does not touch it.
    await writeFile(path.join(dir, "note.md"), "# Plain note\n\nNot a memory.\n");

    const vault = new Vault(dir);
    const r = await vault.init();
    assert.equal(r.loaded, 2, "both the healthy and the repaired memory must be in the index");
    assert.equal(r.skipped.length, 0, "a repairable file is no longer a skip");

    const repaired = vault.get("broken");
    assert.ok(repaired, "the repaired memory must be retrievable by its id");
    assert.ok(repaired!.damaged && repaired!.damaged.length > 0, "the repair must be flagged, not silent");
    assert.ok(
      repaired!.damaged!.some((d) => d.field === "title"),
      `expected the missing title to be named, got ${JSON.stringify(repaired!.damaged)}`
    );

    const healthy = vault.get("good");
    assert.ok(healthy);
    assert.equal(healthy!.damaged, undefined, "a healthy memory must carry no marker");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
