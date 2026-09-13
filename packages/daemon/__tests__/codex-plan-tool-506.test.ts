/**
 * #506 — `bastra install codex` must switch Codex's planning tool on.
 *
 * Codex disables `update_plan` by default (`rust-v0.152.0`), so the
 * `PreToolUse: ^update_plan$` hook the installer registers cannot fire on a
 * default installation — the seven-day zero the issue opened with. These tests
 * run against real TOML files in a temporary HOME (never `~/.codex`) and cover
 * the five lifecycle cases: fresh config, an existing `[tools]` block, a value
 * the user set to `false` on purpose, a second run, and uninstall.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLAN_TOOL_KEY,
  ensureCodexPlanTool,
  inspectPlanTool,
  planPlanToolEnable,
  planPlanToolRemoval,
} from "../src/cli/adapters/codex-plan-tool.js";

async function withConfig(
  initial: string | null,
  body: (configPath: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "bastra-506-codex-"));
  const configPath = join(home, ".codex", "config.toml");
  try {
    if (initial !== null) {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(configPath, initial, "utf8");
    }
    await body(configPath);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const headerCount = (text: string): number =>
  text.split("\n").filter((line) => line.trim() === "[tools.update_plan]").length;

test("#506 a fresh Codex install enables the plan tool and reports it", async () => {
  await withConfig(null, async (configPath) => {
    const result = await ensureCodexPlanTool("install", { dryRun: false, configPath });
    assert.equal(result.status, "enabled");
    assert.match(result.detail, /tools\.update_plan\.enabled = true/);
    const written = await readFile(configPath, "utf8");
    assert.equal(inspectPlanTool(written).state, "enabled");
    assert.equal(inspectPlanTool(written).managed, true);
    assert.equal(headerCount(written), 1);
  });
});

test("#506 install keeps an existing config byte-for-byte and only appends the plan key", async () => {
  const existing = [
    "# my own notes, keep them",
    'model = "gpt-5-codex"',
    "",
    "[tools]",
    "web_search = true",
    "",
    "[mcp_servers.other]",
    'command = "foreign"',
    "",
  ].join("\n");
  await withConfig(existing, async (configPath) => {
    const result = await ensureCodexPlanTool("install", { dryRun: false, configPath });
    assert.equal(result.status, "enabled");
    const written = await readFile(configPath, "utf8");
    assert.ok(written.startsWith(existing), "the user's config must survive unchanged at the front");
    assert.match(written, /# my own notes, keep them/);
    assert.match(written, /web_search = true/);
    assert.equal(inspectPlanTool(written).state, "enabled");
    assert.equal(headerCount(written), 1);
    assert.ok(result.backupPath, "an existing foreign config is backed up before the write");
  });
});

test("#506 install is idempotent — a second run writes nothing and says so", async () => {
  await withConfig('model = "gpt-5-codex"\n', async (configPath) => {
    await ensureCodexPlanTool("install", { dryRun: false, configPath });
    const afterFirst = await readFile(configPath, "utf8");
    const second = await ensureCodexPlanTool("install", { dryRun: false, configPath });
    assert.equal(second.status, "already-enabled");
    assert.equal(second.backupPath, undefined);
    assert.equal(await readFile(configPath, "utf8"), afterFirst);
  });
});

test("#506 a plan tool the user turned off on purpose is never overwritten", async () => {
  const opted_out = "[tools.update_plan]\nenabled = false\n";
  await withConfig(opted_out, async (configPath) => {
    const result = await ensureCodexPlanTool("install", { dryRun: false, configPath });
    assert.equal(result.status, "user-disabled");
    assert.match(result.detail, /left untouched/);
    assert.equal(await readFile(configPath, "utf8"), opted_out);
  });
});

test("#506 an existing [tools.update_plan] section gets the key inserted, not a duplicate header", () => {
  const source = "[tools.update_plan]\n# a comment of mine\n";
  const plan = planPlanToolEnable(source);
  assert.equal(plan.status, "enabled");
  assert.ok(plan.next);
  assert.equal(headerCount(plan.next), 1);
  assert.match(plan.next, /# a comment of mine/);
  assert.equal(inspectPlanTool(plan.next).state, "enabled");
});

test("#506 uninstall removes exactly the block bastra wrote", async () => {
  const existing = 'model = "gpt-5-codex"\n\n[tools]\nweb_search = true\n';
  await withConfig(existing, async (configPath) => {
    await ensureCodexPlanTool("install", { dryRun: false, configPath });
    const removed = await ensureCodexPlanTool("uninstall", { dryRun: false, configPath });
    assert.equal(removed.status, "removed");
    assert.equal(await readFile(configPath, "utf8"), existing);
  });
});

test("#506 uninstall keeps a plan tool setting the user made themselves", async () => {
  const own = "[tools.update_plan]\nenabled = true\n";
  await withConfig(own, async (configPath) => {
    const removed = await ensureCodexPlanTool("uninstall", { dryRun: false, configPath });
    assert.equal(removed.status, "kept");
    assert.equal(await readFile(configPath, "utf8"), own);
  });
});

test("#506 a hand-edited managed block is reported and left alone on uninstall", () => {
  const enabled = planPlanToolEnable("");
  assert.ok(enabled.next);
  const edited = enabled.next.replace("enabled = true", "enabled = true # mine now");
  const removal = planPlanToolRemoval(edited);
  assert.equal(removal.status, "kept");
  assert.equal(removal.next, undefined);
});

test("#506 dry runs never touch the config file", async () => {
  const existing = 'model = "gpt-5-codex"\n';
  await withConfig(existing, async (configPath) => {
    const planned = await ensureCodexPlanTool("install", { dryRun: true, configPath });
    assert.equal(planned.status, "would-enable");
    assert.equal(await readFile(configPath, "utf8"), existing);
    await ensureCodexPlanTool("install", { dryRun: false, configPath });
    const written = await readFile(configPath, "utf8");
    const plannedRemoval = await ensureCodexPlanTool("uninstall", { dryRun: true, configPath });
    assert.equal(plannedRemoval.status, "would-remove");
    assert.equal(await readFile(configPath, "utf8"), written);
  });
});

test("#506 config shapes bastra will not rewrite are reported instead of guessed at", () => {
  assert.equal(inspectPlanTool("[tools]\nupdate_plan = { enabled = true }\n").state, "unsupported");
  assert.equal(planPlanToolEnable("[tools]\nupdate_plan = { other = 1 }\n").status, "unsupported");
  assert.equal(inspectPlanTool('tools.update_plan.enabled = "yes"\n').state, "unsupported");
  assert.equal(inspectPlanTool("tools.update_plan.enabled = true\n").state, "enabled");
  assert.equal(inspectPlanTool('[tools.update_plan]\nenabled = false # off\n').state, "disabled");
});

test("#506 the Codex adapter wires the plan-tool opt-in into install, uninstall and doctor", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../src/cli/adapters/codex.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /ensureCodexPlanTool\("install", \{ dryRun: false/);
  assert.match(source, /ensureCodexPlanTool\("uninstall", \{ dryRun: false/);
  assert.match(source, /describePlanTool/);
  assert.match(source, /details\["plan-tool"\]/);
  // The trust gate: a changed hook command stops firing until re-approved.
  assert.match(source, /re-approve them in Codex with '\/hooks'/);
  assert.ok(PLAN_TOOL_KEY === "tools.update_plan.enabled");
});
