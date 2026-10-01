/**
 * scripts/prepare-package-assets.mjs stages packages/skill/ into
 * packages/daemon/skill/, which package.json ships whole.
 *
 * The copy step only added files and took every `*.md` including dotfiles. On
 * a local `npm pack` or `build:mcpb:local`, a reference file deleted from
 * packages/skill/ — or a stray `.handover-notes.md` — stayed in the staged
 * directory and shipped.
 *
 * The script resolves everything from its own location, so it is copied into a
 * throwaway tree (with a no-op projection builder) instead of being run
 * against the real package.
 *
 * Run: npx tsx --test packages/daemon/__tests__/prepare-package-assets.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "prepare-package-assets.mjs");

function stagedTree(): { root: string; skill: string; staged: string; run: () => ReturnType<typeof spawnSync> } {
  const root = mkdtempSync(join(tmpdir(), "bastra-prepare-assets-"));
  const daemonScripts = join(root, "packages", "daemon", "scripts");
  const skill = join(root, "packages", "skill");
  mkdirSync(daemonScripts, { recursive: true });
  mkdirSync(join(skill, "agents"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(daemonScripts, "prepare-package-assets.mjs"));
  writeFileSync(join(root, "scripts", "build-skill-projections.mjs"), "export async function buildSkillProjections() {}\n");
  writeFileSync(join(skill, "SKILL.md"), "skill\n");
  writeFileSync(join(skill, "intake.md"), "intake\n");
  writeFileSync(join(skill, "cursor-rules.mdc"), "rules\n");
  writeFileSync(join(skill, "agents", "openai.yaml"), "name: x\n");
  const run = () =>
    spawnSync(process.execPath, [join(daemonScripts, "prepare-package-assets.mjs")], { encoding: "utf8", timeout: 60_000 });
  return { root, skill, staged: join(root, "packages", "daemon", "skill"), run };
}

test("a reference file deleted from packages/skill/ does not linger in the staged copy", () => {
  const t = stagedTree();
  try {
    assert.equal(t.run().status, 0);
    assert.ok(existsSync(join(t.staged, "intake.md")));
    rmSync(join(t.skill, "intake.md"));
    assert.equal(t.run().status, 0);
    assert.deepEqual(readdirSync(t.staged).filter((n) => n.endsWith(".md")), ["SKILL.md"]);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("dotfiles in packages/skill/ are not staged, and an older stray one is removed", () => {
  const t = stagedTree();
  try {
    writeFileSync(join(t.skill, ".handover-notes.md"), "scratch\n");
    mkdirSync(t.staged, { recursive: true });
    writeFileSync(join(t.staged, ".old-scratch.md"), "left by an older build\n");
    assert.equal(t.run().status, 0);
    assert.deepEqual(readdirSync(t.staged).filter((n) => n.startsWith(".")), []);
    assert.ok(existsSync(join(t.staged, "cursor-rules.mdc")));
    assert.ok(existsSync(join(t.staged, "agents", "openai.yaml")));
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});
