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
