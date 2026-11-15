/**
 * Tests for the post-uninstall shared-skill sweep (#181): the pure decision
 * guard (shouldSweepSkill) and the fs step (sweepSharedSkill) that removes
 * ~/.claude/skills/bastra-recall once no surface registration references it.
 *
 * The step is exercised with an injected skill dir + config paths under a
 * temp dir, so nothing ever touches the real HOME.
 *
 * Run: npx tsx --test packages/daemon/__tests__/uninstall-skill-sweep.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { shouldSweepSkill, sweepSharedSkill, SKILL_SHARING_SURFACES } from "../src/cli/skill.js";
import { SERVER_KEY } from "../src/cli/helpers.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-skill-sweep-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** Lays out a fake HOME slice: skill dir (optional) + per-surface configs. */
async function setupHome(
  dir: string,
  opts: { skill: boolean; registered: string[] }
): Promise<{ skillDir: string; configPaths: Record<string, string> }> {
  const skillDir = join(dir, "skills", "bastra-recall");
  if (opts.skill) {
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# skill\n", "utf8");
  }
  const configPaths: Record<string, string> = {};
  for (const surface of SKILL_SHARING_SURFACES) {
    const path = join(dir, `${surface}.json`);
    configPaths[surface] = path;
    const servers = opts.registered.includes(surface) ? { [SERVER_KEY]: { command: "node" } } : {};
    await writeFile(path, JSON.stringify({ mcpServers: servers }), "utf8");
  }
  return { skillDir, configPaths };
}

// ─── decision matrix (pure) ──────────────────────────────────────────────────

test("sweep guard: 'all' with no remaining registration → sweep", () => {
  assert.equal(shouldSweepSkill({ surface: "all", remainingRegistrations: [] }), true);
});

test("sweep guard: any remaining registration always wins", () => {
  for (const surface of ["all", "claude-code", "claude-desktop"]) {
    assert.equal(
      shouldSweepSkill({ surface, remainingRegistrations: ["claude-desktop"] }),
      false,
      `surface=${surface}`
    );
  }
});

test("sweep guard: single skill-sharing surface with nothing else registered → sweep", () => {
  for (const surface of SKILL_SHARING_SURFACES) {
    assert.equal(shouldSweepSkill({ surface, remainingRegistrations: [] }), true, `surface=${surface}`);
  }
});

test("sweep guard: runs that never touch ~/.claude/skills don't sweep", () => {
  assert.equal(shouldSweepSkill({ surface: "cursor", remainingRegistrations: [] }), false);
  assert.equal(shouldSweepSkill({ surface: null, remainingRegistrations: [] }), false);
});

test("sweep guard: a covered surface whose uninstall FAILED counts as still registered", () => {
  // 'all' needs every skill-sharing surface to have succeeded …
  assert.equal(
    shouldSweepSkill({ surface: "all", remainingRegistrations: [], succeededSurfaces: ["claude-desktop"] }),
    false
  );
  assert.equal(
    shouldSweepSkill({
      surface: "all",
      remainingRegistrations: [],
      succeededSurfaces: ["claude-desktop", "claude-code"],
    }),
    true
  );
  // … but a failed cursor never blocks — it doesn't share the skill.
  assert.equal(
    shouldSweepSkill({
      surface: "all",
      remainingRegistrations: [],
      succeededSurfaces: ["claude-desktop", "claude-code"], // cursor errored
    }),
    true
  );
  // Single-surface run: that surface itself must have succeeded.
  assert.equal(shouldSweepSkill({ surface: "claude-code", remainingRegistrations: [], succeededSurfaces: [] }), false);
  assert.equal(
    shouldSweepSkill({ surface: "claude-code", remainingRegistrations: [], succeededSurfaces: ["claude-code"] }),
    true
  );
});

// ─── fs step (temp dir, injected paths) ──────────────────────────────────────

test("sweep step: 'all' with no registrations left removes the skill dir", async () => {
  await withTempDir(async (dir) => {
    const io = await setupHome(dir, { skill: true, registered: [] });
    const r = await sweepSharedSkill({ surface: "all", dryRun: false }, io);
    assert.equal(r.status, "removed");
    assert.match(r.detail, /no surface registration references it anymore/);
    assert.equal(existsSync(io.skillDir), false);
  });
});

test("sweep step: missing skill dir → not-present, nothing to do", async () => {
  await withTempDir(async (dir) => {
    const io = await setupHome(dir, { skill: false, registered: [] });
    const r = await sweepSharedSkill({ surface: "all", dryRun: false }, io);
    assert.equal(r.status, "not-present");
  });
});

test("sweep step: a surviving registration (e.g. errored surface uninstall) blocks the sweep", async () => {
  await withTempDir(async (dir) => {
    const io = await setupHome(dir, { skill: true, registered: ["claude-desktop"] });
    const r = await sweepSharedSkill({ surface: "all", dryRun: false }, io);
    assert.equal(r.status, "kept");
    assert.match(r.detail, /claude-desktop/);
    assert.equal(existsSync(io.skillDir), true);
  });
});

test("sweep step: single-surface uninstall keeps the skill while the other surface is registered", async () => {
  await withTempDir(async (dir) => {
    const io = await setupHome(dir, { skill: true, registered: ["claude-desktop"] });
    const r = await sweepSharedSkill({ surface: "claude-code", dryRun: false }, io);
    assert.equal(r.status, "kept");
    assert.equal(existsSync(io.skillDir), true);
  });
});

test("sweep step: single-surface uninstall sweeps when no other registration remains", async () => {
  await withTempDir(async (dir) => {
    const io = await setupHome(dir, { skill: true, registered: [] });
    const r = await sweepSharedSkill({ surface: "claude-code", dryRun: false }, io);
    assert.equal(r.status, "removed");
    assert.equal(existsSync(io.skillDir), false);
  });
});

test("sweep step: dry-run 'all' reports would-remove (covered registrations still on disk) and deletes nothing", async () => {
  await withTempDir(async (dir) => {
    const io = await setupHome(dir, { skill: true, registered: ["claude-desktop", "claude-code"] });
    const r = await sweepSharedSkill({ surface: "all", dryRun: true }, io);
    assert.equal(r.status, "would-remove");
    assert.match(r.detail, /no surface registration would remain/);
    assert.equal(existsSync(io.skillDir), true);
  });
});

test("sweep step: dry-run single surface only subtracts itself — the other registration keeps the skill", async () => {
  await withTempDir(async (dir) => {
    const io = await setupHome(dir, { skill: true, registered: ["claude-desktop", "claude-code"] });
    const r = await sweepSharedSkill({ surface: "claude-code", dryRun: true }, io);
    assert.equal(r.status, "kept");
    assert.equal(existsSync(io.skillDir), true);
  });
});

test("sweep step: dry-run 'all' with a FAILED surface never over-promises — its registration is not subtracted", async () => {
  await withTempDir(async (dir) => {
    const io = await setupHome(dir, { skill: true, registered: ["claude-desktop", "claude-code"] });
    // claude-code's uninstall reported an error (e.g. invalid settings JSON).
    const r = await sweepSharedSkill(
      { surface: "all", dryRun: true, succeededSurfaces: ["claude-desktop", "cursor"] },
      io
    );
    assert.equal(r.status, "kept");
    assert.match(r.detail, /claude-code/);
    assert.equal(existsSync(io.skillDir), true);
  });
});

test("sweep step: dry-run 'all' with every surface succeeded still reports would-remove", async () => {
  await withTempDir(async (dir) => {
    const io = await setupHome(dir, { skill: true, registered: ["claude-desktop", "claude-code"] });
    const r = await sweepSharedSkill(
      { surface: "all", dryRun: true, succeededSurfaces: ["claude-desktop", "claude-code", "cursor"] },
      io
    );
    assert.equal(r.status, "would-remove");
    assert.equal(existsSync(io.skillDir), true);
  });
});

test("sweep step: a FAILED surface blocks the wet sweep even when its registration is already gone", async () => {
  await withTempDir(async (dir) => {
    const io = await setupHome(dir, { skill: true, registered: [] });
    // claude-code errored mid-uninstall after its MCP entry was dropped.
    const r = await sweepSharedSkill({ surface: "all", dryRun: false, succeededSurfaces: ["claude-desktop"] }, io);
    assert.equal(r.status, "kept");
    assert.match(r.detail, /uninstall failed: claude-code/);
    assert.equal(existsSync(io.skillDir), true);
  });
});

test("sweep step: an unreadable config counts as registered — never delete on uncertainty", async () => {
  await withTempDir(async (dir) => {
    const io = await setupHome(dir, { skill: true, registered: [] });
    await writeFile(io.configPaths["claude-desktop"], "{ not json", "utf8");
    const r = await sweepSharedSkill({ surface: "all", dryRun: false }, io);
    assert.equal(r.status, "kept");
    assert.equal(existsSync(io.skillDir), true);
  });
});

test("sweep step: cursor-only uninstall never touches the skill dir", async () => {
  await withTempDir(async (dir) => {
    const io = await setupHome(dir, { skill: true, registered: [] });
    const r = await sweepSharedSkill({ surface: "cursor", dryRun: false }, io);
    assert.equal(r.status, "kept");
    assert.equal(existsSync(io.skillDir), true);
  });
});
