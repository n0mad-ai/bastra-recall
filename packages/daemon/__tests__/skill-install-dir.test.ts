/**
 * Tests for the directory-shaped skill install (#232 prerequisite): copySkill
 * must carry SKILL.md *and* the reference files it points at, so a later split
 * of SKILL.md never leaves dangling pointers in ~/.claude/skills/.
 *
 * Source and target dirs are injected under a temp dir — nothing ever touches
 * the real HOME.
 *
 * Run: npx tsx --test packages/daemon/__tests__/skill-install-dir.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copySkill } from "../src/cli/skill.js";

async function withDirs<T>(
  fn: (io: { sourceDir: string; targetDir: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "bastra-skill-install-"));
  const sourceDir = join(root, "src");
  const targetDir = join(root, "dst");
  await mkdir(sourceDir, { recursive: true });
  try {
    return await fn({ sourceDir, targetDir });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** A skill source dir: SKILL.md, two reference files, plus the non-payload
 *  neighbours that live in packages/skill/ and must never be installed. */
async function seedSource(dir: string): Promise<void> {
  await writeFile(join(dir, "SKILL.md"), "# skill\nsee taxonomy.md\n", "utf8");
  await writeFile(join(dir, "taxonomy.md"), "# taxonomy\n", "utf8");
  await writeFile(join(dir, "intake.md"), "# intake\n", "utf8");
  await writeFile(join(dir, "install.sh"), "#!/usr/bin/env bash\n", "utf8");
  await writeFile(join(dir, "cursor-rules.mdc"), "cursor\n", "utf8");
}

test("install carries optional ChatGPT/Codex presentation metadata", async () => {
  await withDirs(async (io) => {
    await seedSource(io.sourceDir);
    await mkdir(join(io.sourceDir, "agents"), { recursive: true });
    await writeFile(join(io.sourceDir, "agents", "openai.yaml"), "interface:\n  display_name: Bastra Recall\n", "utf8");
    const result = await copySkill({ dryRun: false }, io);
    assert.equal(result.status, "installed");
    assert.equal(
      await readFile(join(io.targetDir, "agents", "openai.yaml"), "utf8"),
      "interface:\n  display_name: Bastra Recall\n",
    );
  });
});

test("install carries SKILL.md and every reference file", async () => {
  await withDirs(async (io) => {
    await seedSource(io.sourceDir);
    const result = await copySkill({ dryRun: false }, io);
    assert.equal(result.status, "installed");
    for (const name of ["SKILL.md", "taxonomy.md", "intake.md"]) {
      assert.equal(existsSync(join(io.targetDir, name)), true, `${name} missing in target`);
    }
    assert.equal(await readFile(join(io.targetDir, "taxonomy.md"), "utf8"), "# taxonomy\n");
  });
});

test("install leaves the non-skill neighbours behind", async () => {
  await withDirs(async (io) => {
    await seedSource(io.sourceDir);
    await copySkill({ dryRun: false }, io);
    for (const name of ["install.sh", "cursor-rules.mdc"]) {
      assert.equal(existsSync(join(io.targetDir, name)), false, `${name} leaked into the skill dir`);
    }
  });
});

test("a fully up-to-date target reports already-installed", async () => {
  await withDirs(async (io) => {
    await seedSource(io.sourceDir);
    await copySkill({ dryRun: false }, io);
    const again = await copySkill({ dryRun: false }, io);
    assert.equal(again.status, "already-installed");
    assert.match(again.detail, /3 files/);
  });
});

test("a stale reference file alone re-triggers the install", async () => {
  await withDirs(async (io) => {
    await seedSource(io.sourceDir);
    await copySkill({ dryRun: false }, io);
    await writeFile(join(io.sourceDir, "intake.md"), "# intake, revised\n", "utf8");
    const result = await copySkill({ dryRun: false }, io);
    assert.equal(result.status, "installed");
    assert.match(result.detail, /intake\.md/);
    assert.doesNotMatch(result.detail, /SKILL\.md \(/); // only the changed file was copied
    assert.equal(await readFile(join(io.targetDir, "intake.md"), "utf8"), "# intake, revised\n");
  });
});

test("a missing reference file alone re-triggers the install", async () => {
  await withDirs(async (io) => {
    await seedSource(io.sourceDir);
    await copySkill({ dryRun: false }, io);
    await rm(join(io.targetDir, "taxonomy.md"));
    const result = await copySkill({ dryRun: false }, io);
    assert.equal(result.status, "installed");
    assert.equal(existsSync(join(io.targetDir, "taxonomy.md")), true);
  });
});

test("dry-run names the outdated files and writes nothing", async () => {
  await withDirs(async (io) => {
    await seedSource(io.sourceDir);
    const result = await copySkill({ dryRun: true }, io);
    assert.equal(result.status, "would-install");
    assert.match(result.detail, /SKILL\.md/);
    assert.match(result.detail, /taxonomy\.md/);
    assert.equal(existsSync(io.targetDir), false);
  });
});

test("a source without SKILL.md is an error, not a partial install", async () => {
  await withDirs(async (io) => {
    await writeFile(join(io.sourceDir, "taxonomy.md"), "# taxonomy\n", "utf8");
    const result = await copySkill({ dryRun: false }, io);
    assert.equal(result.status, "error");
    assert.match(result.detail, /skill source missing/);
    assert.equal(existsSync(io.targetDir), false);
  });
});
