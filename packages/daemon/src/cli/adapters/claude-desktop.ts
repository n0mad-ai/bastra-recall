import { CLAUDE_DESKTOP_CONFIG, CLAUDE_DESKTOP_DIR, SKILL_SOURCE_DIR, SKILL_TARGET_DIR } from "../paths.js";
import {
  SERVER_KEY,
  atomicWriteJson,
  backupConfig,
  blocksMatch,
  buildServerBlock,
  fileExists,
  getServersBlock,
  probeDaemon,
  readJsonConfig,
  resolveVault,
} from "../helpers.js";
import { copySkill, describeSkillInstall, inspectSkillInstall } from "../skill.js";
import { checkForwarderRegistration, ensureStableForwarder } from "../stable-runtime.js";
import type { Adapter, DoctorResult, InstallOpts, InstallResult, UninstallResult } from "../types.js";

/**
 * One-time autonomy setup, printed after install. Claude Desktop has no
 * hook system (no SessionStart/PreToolUse), so proactive recall/save rests
 * on three user-side switches; the personal-preferences prompt follows the
 * pattern the official MCP memory reference server canonizes ("begin every
 * chat by retrieving…"). The forwarder covers the rest automatically
 * (server instructions, read-only tool annotations, first-call session
 * context for hookless clients).
 */
const DESKTOP_AUTONOMY_NOTE =
  "make Desktop use memory ON ITS OWN (one-time, ~2 min):\n" +
  "    1. Settings → Connectors → bastra-recall → tool access: \"Always available\"\n" +
  "       (keeps the memory tools and their guidance always in Claude's context)\n" +
  "    2. On the first tool call pick \"Allow always\" — recall/load/find are read-only\n" +
  "    3. Settings → Profile → personal preferences (\"Instructions for Claude\") — paste:\n" +
  "       ┄┄┄\n" +
  "       Memory: I use bastra-recall (local MCP). Begin every conversation by silently\n" +
  "       retrieving context with its recall tool. Before answering anything about my past,\n" +
  "       projects, documents or preferences, search bastra-recall first (recall +\n" +
  "       find_document) — before any other lookup. When I state a durable preference,\n" +
  "       rule, decision or fact worth keeping, save it via save_memory without being\n" +
  "       asked, then confirm in one short line.\n" +
  "       ┄┄┄\n" +
  "       Full guide: https://github.com/n0mad-ai/bastra-recall/wiki/Claude-Desktop";

async function claudeDesktopInstall(opts: InstallOpts): Promise<InstallResult> {
  const configPath = CLAUDE_DESKTOP_CONFIG;
  const vault = await resolveVault(opts);
  if ("error" in vault) return { status: "error", message: vault.error, configPath };

  const fwd = await ensureStableForwarder({ dryRun: opts.dryRun });
  const block = buildServerBlock(vault.path, fwd.path);
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "error", message: read.error, configPath };

  const data = read.data;
  const servers = getServersBlock(data) ?? {};
  const mcpMatches = blocksMatch(servers[SERVER_KEY], block);

  // Claude Desktop reads skills from the same ~/.claude/skills/ path as
  // Claude Code, so we drop the Skill here too (idempotent). Hooks aren't
  // a Claude Desktop surface yet.
  const skillResult = await copySkill({ dryRun: opts.dryRun });
  if (skillResult.status === "error") return { status: "error", message: `skill: ${skillResult.detail}`, configPath };

  if (mcpMatches && skillResult.status === "already-installed") {
    return {
      status: "already-installed",
      message:
        "MCP server and skill both already in place\n" +
        "  · autonomy guide (make Desktop recall & save on its own): " +
        "https://github.com/n0mad-ai/bastra-recall/wiki/Claude-Desktop",
      configPath,
    };
  }

  if (opts.dryRun) {
    const steps: string[] = [];
    if (fwd.note) steps.push(`runtime: ${fwd.note}`);
    steps.push(mcpMatches ? "mcp: already matches" : `mcp: would register '${SERVER_KEY}' (vault=${vault.path})`);
    steps.push(`skill: ${skillResult.detail}`);
    return { status: "would-install", message: steps.join("\n  · "), configPath };
  }

  let backupPath: string | undefined;
  if (!mcpMatches) {
    backupPath = (await backupConfig(configPath)) ?? undefined;
    data.mcpServers = { ...servers, [SERVER_KEY]: block };
    await atomicWriteJson(configPath, data);
  }

  const lines: string[] = [];
  if (fwd.note) lines.push(`runtime: ${fwd.note}`);
  lines.push(mcpMatches ? "mcp: already matches" : `mcp: registered '${SERVER_KEY}'`);
  lines.push(`skill: ${skillResult.detail}`);
  lines.push("restart Claude Desktop to activate");
  lines.push(DESKTOP_AUTONOMY_NOTE);

  return {
    status: "installed",
    message: lines.join("\n  · "),
    configPath,
    backupPath,
  };
}

async function claudeDesktopUninstall(opts: { dryRun: boolean }): Promise<UninstallResult> {
  const configPath = CLAUDE_DESKTOP_CONFIG;
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "error", message: read.error, configPath };
  if (!read.existed) return { status: "not-present", message: "config file doesn't exist", configPath };

  const data = read.data;
  const servers = getServersBlock(data);
  if (!servers || !(SERVER_KEY in servers)) {
    return { status: "not-present", message: `'${SERVER_KEY}' not registered`, configPath };
  }

  if (opts.dryRun) {
    return { status: "would-remove", message: `would remove '${SERVER_KEY}' from mcpServers`, configPath };
  }

  const backupPath = await backupConfig(configPath);
  delete servers[SERVER_KEY];
  data.mcpServers = servers;
  await atomicWriteJson(configPath, data);

  return {
    status: "removed",
    message: `removed '${SERVER_KEY}' — restart Claude Desktop to drop the connection`,
    configPath,
    backupPath: backupPath ?? undefined,
  };
}

async function claudeDesktopDoctor(): Promise<DoctorResult> {
  const configPath = CLAUDE_DESKTOP_CONFIG;
  const details: Record<string, string> = {};

  // 1. Claude Desktop installed? (config dir is platform-specific — see paths.ts)
  details["claude-desktop-app"] = (await fileExists(CLAUDE_DESKTOP_DIR))
    ? `installed (${CLAUDE_DESKTOP_DIR} exists)`
    : "not detected";

  // 2. Config + registration
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "broken", message: read.error, details };
  details["config-file"] = read.existed ? "present" : "missing (created on first Desktop launch)";

  const servers = getServersBlock(read.data) ?? {};
  const registered = SERVER_KEY in servers;
  details["mcp-registration"] = registered ? "present" : "missing";

  let forwarderBroken = false;
  if (registered) {
    const block = servers[SERVER_KEY] as Record<string, unknown>;
    const args = Array.isArray(block?.args) ? block.args : [];
    const fwd = args[0];
    if (typeof fwd === "string") {
      const check = checkForwarderRegistration(fwd, await fileExists(fwd), "claude-desktop");
      details["forwarder-path"] = check.detail;
      forwarderBroken = check.broken;
    } else {
      details["forwarder-path"] = "no path in args[0]";
      forwarderBroken = true;
    }
    const env = block?.env as Record<string, unknown> | undefined;
    const vault = env?.BASTRA_VAULT_PATH;
    if (typeof vault === "string") {
      details["vault-path"] = (await fileExists(vault)) ? `${vault} (exists)` : `${vault} (MISSING)`;
    } else {
      details["vault-path"] = "not set in env";
    }
  }

  // 3. Skill (shared with Claude Code under ~/.claude/skills/)
  // #456: compared against the shipped bundle, not merely present.
  const skillState = await inspectSkillInstall(SKILL_SOURCE_DIR, SKILL_TARGET_DIR);
  details["skill"] = describeSkillInstall(skillState, SKILL_TARGET_DIR);

  // 4. Daemon reachable
  const probe = await probeDaemon();
  details["daemon-on-6723"] = probe.ok ? `reachable (${probe.detail})` : probe.detail;

  if (!registered) return { status: "missing", message: "not registered with Claude Desktop", details };
  const broken =
    forwarderBroken ||
    details["vault-path"]?.includes("MISSING") === true ||
    details["vault-path"]?.startsWith("not ") === true ||
    details["skill"] === "missing" ||
    details["skill"].startsWith("STALE");
  if (broken) return { status: "broken", message: "registered but skill or referenced paths need repair — re-run 'bastra install claude-desktop'", details };
  return { status: "ok", message: "registered with skill, looks healthy", details };
}

export const claudeDesktopAdapter: Adapter = {
  surface: "claude-desktop",
  description: "Claude Desktop App",
  configPath: CLAUDE_DESKTOP_CONFIG,
  install: claudeDesktopInstall,
  uninstall: claudeDesktopUninstall,
  doctor: claudeDesktopDoctor,
};
