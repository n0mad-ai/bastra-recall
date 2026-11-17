/**
 * Claude Desktop adapter contract (#1566, follow-up of #1452).
 *
 * Install writes the MCP registration and the skill; a second install changes
 * nothing. The adapter resolves its paths from HOME at import time, so HOME is
 * pointed at a temp dir BEFORE the adapter is imported — the real Claude
 * Desktop config and ~/.claude/skills are never touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "bastra-claude-desktop-"));
const savedHome = process.env.HOME;
process.env.HOME = home;
const { claudeDesktopAdapter } = await import("../src/cli/adapters/claude-desktop.js");
const { CLAUDE_DESKTOP_CONFIG, SKILL_TARGET_DIR } = await import("../src/cli/paths.js");
const { hostCapabilities } = await import("../src/host-capabilities.js");
process.env.HOME = savedHome;

test.after(async () => {
  await rm(home, { recursive: true, force: true });
});

const vault = join(home, "vault");
const opts = { dryRun: false, vaultPath: vault };
const foreign = { command: "node", args: ["/elsewhere/other-server.js"] };

async function backups(): Promise<string[]> {
  const dir = dirname(CLAUDE_DESKTOP_CONFIG);
  return (await readdir(dir)).filter((name) => name.includes(".bak-"));
}

test("the adapter only ever writes inside the temp HOME", () => {
  assert.ok(CLAUDE_DESKTOP_CONFIG.startsWith(home), CLAUDE_DESKTOP_CONFIG);
  assert.ok(SKILL_TARGET_DIR.startsWith(home), SKILL_TARGET_DIR);
});

test("install writes the MCP registration and the skill, keeping foreign servers", async () => {
  await mkdir(vault, { recursive: true });
  await mkdir(dirname(CLAUDE_DESKTOP_CONFIG), { recursive: true });
  await writeFile(
    CLAUDE_DESKTOP_CONFIG,
    JSON.stringify({ globalShortcut: "Alt+Space", mcpServers: { other: foreign } }, null, 2)
  );

  const result = await claudeDesktopAdapter.install(opts);
  assert.equal(result.status, "installed", result.message);
  assert.ok(result.backupPath, "an existing config is backed up before it is rewritten");

  const config = JSON.parse(await readFile(CLAUDE_DESKTOP_CONFIG, "utf8"));
  const block = config.mcpServers["bastra-recall"];
  assert.ok(block, "bastra-recall is registered");
  assert.equal(block.env.BASTRA_VAULT_PATH, vault);
  assert.match(String(block.args[0]), /mcp-forwarder\.js$/);
  assert.deepEqual(config.mcpServers.other, foreign);
  // Claude Desktop has no hook surface (host-capabilities ledger): the install
  // adds the MCP block and nothing else to the config.
  assert.deepEqual(Object.keys(config).sort(), ["globalShortcut", "mcpServers"]);
  assert.equal(config.globalShortcut, "Alt+Space");

  assert.ok((await readdir(SKILL_TARGET_DIR)).includes("SKILL.md"), "the skill is installed");
});

test("a second install changes nothing", async () => {
  const before = await readFile(CLAUDE_DESKTOP_CONFIG, "utf8");
  const backupsBefore = await backups();

  const result = await claudeDesktopAdapter.install(opts);
  assert.equal(result.status, "already-installed", result.message);
  assert.equal(await readFile(CLAUDE_DESKTOP_CONFIG, "utf8"), before);
  assert.deepEqual(await backups(), backupsBefore, "no new backup for an unchanged config");
});

test("uninstall removes only the bastra-recall registration", async () => {
  const result = await claudeDesktopAdapter.uninstall({ dryRun: false });
  assert.equal(result.status, "removed", result.message);
  const config = JSON.parse(await readFile(CLAUDE_DESKTOP_CONFIG, "utf8"));
  assert.deepEqual(config.mcpServers, { other: foreign });
});

test("the evidence ledger matches the tested adapter: installable, MCP only, no hooks", () => {
  const row = hostCapabilities("claude-desktop");
  assert.equal(row.installable, true);
  assert.equal(claudeDesktopAdapter.surface, row.surface);
  for (const key of ["prompt_hook", "pre_tool_deny", "stop_block", "must_load_gate", "rulebook_gate"] as const) {
    assert.equal(row.capabilities[key].bastra, "unsupported", key);
  }
  assert.deepEqual(row.pre_tool_coverage.runtimeVerified, []);
});
