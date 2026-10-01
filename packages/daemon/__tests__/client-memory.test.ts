/**
 * #674: notes in Claude Code's and Codex's own memory folders are found,
 * reported with how many are not in the vault yet, and imported through the
 * folder import — after which they no longer count as pending.
 *
 * Run: node --import tsx --test packages/daemon/__tests__/client-memory.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientMemoryLines, findClientMemoryDirs } from "../src/cli/client-memory.js";
import { importVault, IMPORT_ROOT } from "../src/import-vault.js";

const CC_NOTE = `---
name: No silent removals
description: Adding a feature never removes an existing one
type: feedback
---
Adding a feature means extending, never removing what exists.
`;

async function fixture(): Promise<{ root: string; home: string; vault: string }> {
  const root = await mkdtemp(join(tmpdir(), "bastra-client-memory-"));
  const home = join(root, "home");
  const vault = join(root, "vault");
  await mkdir(join(vault, "memories"), { recursive: true });
  const ccMem = join(home, ".claude", "projects", `${home.replace(/[^a-zA-Z0-9]/g, "-")}-Projects-shop`, "memory");
  await mkdir(ccMem, { recursive: true });
  await writeFile(join(ccMem, "feedback_no_silent_removals.md"), CC_NOTE);
  await writeFile(join(ccMem, "MEMORY.md"), "- [No silent removals](feedback_no_silent_removals.md)\n");
  // A project folder with an empty memory dir is not reported.
  await mkdir(join(home, ".claude", "projects", "-empty", "memory"), { recursive: true });
  await mkdir(join(home, ".codex", "memories"), { recursive: true });
  await writeFile(join(home, ".codex", "memories", "deploy.md"), "# Deploy\n\nReleases are cut from main only.\n");
  return { root, home, vault };
}

test("#674 — finds the Claude Code and Codex folders that hold notes, MEMORY.md not counted", async () => {
  const { root, home, vault } = await fixture();
  try {
    const dirs = await findClientMemoryDirs(vault, { home });
    assert.deepEqual(
      dirs.map((d) => [d.client, d.label, d.notes, d.pending]),
      [
        ["claude-code", "claude-code-projects-shop", 1, 1],
        ["codex", "codex", 1, 1],
      ],
    );
    const lines = clientMemoryLines(dirs);
    assert.match(lines[0], /claude-code: .* 1 note\(s\), 1 not in the vault yet/);
    assert.match(lines.at(-1) ?? "", /bastra import clients/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#674 — after the import the notes are no longer pending; a newer note is", async () => {
  const { root, home, vault } = await fixture();
  try {
    for (const d of await findClientMemoryDirs(vault, { home })) {
      const r = await importVault(vault, d.dir, { label: d.label });
      assert.equal(r.skipped.length, 0);
    }
    assert.ok(existsSync(join(vault, IMPORT_ROOT, "claude-code-projects-shop", ".bastra-imported")));
    let dirs = await findClientMemoryDirs(vault, { home });
    assert.deepEqual(dirs.map((d) => d.pending), [0, 0]);
    assert.deepEqual(clientMemoryLines(dirs).filter((l) => l.includes("import clients")), []);

    const later = new Date(Date.now() + 60_000);
    const fresh = join(home, ".codex", "memories", "new.md");
    await writeFile(fresh, "# New\n\nA note written after the import.\n");
    await utimes(fresh, later, later);
    dirs = await findClientMemoryDirs(vault, { home });
    assert.deepEqual(dirs.map((d) => [d.label, d.pending]), [["claude-code-projects-shop", 0], ["codex", 1]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#674 — CLAUDE_CONFIG_DIR / CODEX_HOME move the folders; nothing found means no doctor lines", async () => {
  const { root, home, vault } = await fixture();
  try {
    const dirs = await findClientMemoryDirs(vault, {
      home,
      claudeConfigDir: join(root, "nowhere"),
      codexHome: join(root, "nowhere"),
    });
    assert.deepEqual(dirs, []);
    assert.deepEqual(clientMemoryLines(dirs), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Revert-check: put the flat `readdir` back in describe() (client-memory.ts) →
// all three assertions are red: the folder is not found, the count is 1 not 4,
// and a subfolder edit is not pending.
test("#674 — doctor walks the folder the way the import does: subfolder notes are found, counted, and pending", async () => {
  const { root, home, vault } = await fixture();
  try {
    const ccMem = join(home, ".claude", "projects", `${home.replace(/[^a-zA-Z0-9]/g, "-")}-Projects-nested`, "memory");
    await mkdir(join(ccMem, "feedback"), { recursive: true });
    await mkdir(join(ccMem, ".hidden"), { recursive: true });
    await writeFile(join(ccMem, "MEMORY.md"), "- [b](feedback/b.md)\n");
    for (const n of ["b", "c", "d"]) await writeFile(join(ccMem, "feedback", `${n}.md`), CC_NOTE);
    await writeFile(join(ccMem, ".hidden", "x.md"), CC_NOTE); // the import skips dotdirs
    const find = async () => (await findClientMemoryDirs(vault, { home })).find((d) => d.label === "claude-code-projects-nested")!;

    let d = await find();
    assert.ok(d, "a folder whose notes all sit in subfolders is found");
    const dry = await importVault(vault, d.dir, { label: d.label, dryRun: true });
    assert.equal(d.notes, 3);
    assert.equal(d.notes, dry.scanned, "doctor counts what the import scans");

    await importVault(vault, d.dir, { label: d.label });
    assert.equal((await find()).pending, 0);
    const later = new Date(Date.now() + 60_000);
    await writeFile(join(ccMem, "feedback", "b.md"), CC_NOTE + "edited\n");
    await utimes(join(ccMem, "feedback", "b.md"), later, later);
    assert.equal((await find()).pending, 1, "a subfolder edit after the import is pending");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project opened in the home directory itself is labelled without the OS user name", async () => {
  const root = await mkdtemp(join(tmpdir(), "bastra-client-memory-"));
  try {
    const home = join(root, "Users", "alice");
    const slug = home.replace(/[^a-zA-Z0-9]/g, "-");
    for (const project of [slug, `${slug}-Projects-shop`]) {
      const mem = join(home, ".claude", "projects", project, "memory");
      await mkdir(mem, { recursive: true });
      await writeFile(join(mem, "feedback_no_silent_removals.md"), CC_NOTE);
    }
    const labels = (await findClientMemoryDirs(null, { home })).map((d) => d.label);
    assert.deepEqual(labels, ["claude-code-home", "claude-code-projects-shop"]);
    assert.ok(labels.every((l) => !l.includes("alice")), labels.join(", "));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
