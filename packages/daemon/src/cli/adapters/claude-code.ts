import { existsSync } from "node:fs";
import {
  CLAUDE_CODE_CONFIG,
  CLAUDE_CODE_SETTINGS,
  HOOK_STUB_BIN,
  STATUSLINE_BIN,
  SKILL_SOURCE_DIR,
  SKILL_TARGET_DIR,
} from "../paths.js";
import {
  SERVER_KEY,
  atomicWriteJson,
  backupConfig,
  blocksMatch,
  buildServerBlock,
  existingToolSurface,
  mcpEnvFeatures,
  serverBlockEndpoint,
  foreignEnv,
  fileExists,
  getServersBlock,
  probeDaemon,
  readJsonConfig,
  resolveVault,
} from "../helpers.js";
import { copySkill, describeSkillInstall, inspectSkillInstall } from "../skill.js";
import { checkForwarderRegistration, ensureStableForwarder, mapBinToStableRuntime } from "../stable-runtime.js";
import { archiveMode } from "../../bash-pre-patterns.js";
import { getArchiveEnabled } from "../../settings.js";
import type { Adapter, DoctorResult, InstallOpts, InstallResult, UninstallResult } from "../types.js";
import {
  CLIENT_MARKER,
  OUR_HOOK_FILES,
  REQUIRED_HOOK_FILES,
  checkHookPaths,
  missingRequiredHookRegistrations,
  patchClaudeCodeHooks,
  registeredHookBins,
  registeredHookCommands,
} from "./claude-code-hooks.js";

// #680: the hook helpers live in claude-code-hooks.ts; their public surface is
// re-exported from here unchanged.
export {
  hookDefinitions,
  stubSubcommandForFile,
  stubLaneCommandPath,
  hookCommandPath,
  checkHookPaths,
  registeredHookBins,
  registeredHookCommands,
  missingRequiredHookRegistrations,
  planHookEntries,
} from "./claude-code-hooks.js";
export type { HookDef, HookPlan } from "./claude-code-hooks.js";

// ─── Statusline helpers ──────────────────────────────────────────

// Matches Daniel's hand-configured block + the One-command default:
//   node <statusline>/dist/index.mjs --style=powerline
// The bin is a parameter (#180): under an active stable runtime it points into
// the ~/.bastra/runtime copy instead of the npx cache.
// #347 stage 2: same stub policy as the hook lanes (#344) — when the compiled
// stub exists on this host, register `bastra-hook statusline` for the fast
// start; plain npm installs keep the node client.
// #537: `stubPresent` is the selection made by the install step, not a disk
// probe — `--no-stub` has to move the statusLine back to the node client too,
// or the opt-out would be half taken.
export function statuslineCommand(bin: string, stubPresent: boolean = existsSync(HOOK_STUB_BIN)): string {
  return stubPresent
    ? `${HOOK_STUB_BIN} statusline --style=powerline`
    : `node ${bin} --style=powerline`;
}

function buildStatuslineBlock(command: string): Record<string, unknown> {
  return {
    type: "command",
    command,
    refreshInterval: 1,
    __bastraRecall: true,
  };
}

// Recognise our statusLine — by marker (our writes) or by command path
// (hand-configured ones that predate the marker).
function isOurStatusline(sl: unknown): boolean {
  if (typeof sl !== "object" || sl === null) return false;
  const s = sl as Record<string, unknown>;
  if (s.__bastraRecall === true || s.__nexusRecall === true) return true;
  const cmd = typeof s.command === "string" ? s.command : "";
  return (
    cmd.includes("bastra-statusline") ||
    cmd.includes("/statusline/dist/index.mjs") ||
    cmd.includes("/statusline/bin/claude-powerline") ||
    (cmd.includes("statusline") && cmd.includes("bastra"))
  );
}

function statuslineMatches(sl: unknown, command: string): boolean {
  if (typeof sl !== "object" || sl === null) return false;
  const s = sl as Record<string, unknown>;
  return (
    s.command === command &&
    s.type === "command" &&
    s.refreshInterval === 1
  );
}

type StatuslineStepStatus =
  | "installed" | "already-installed" | "would-install" | "foreign-kept"
  | "removed" | "not-present" | "would-remove" | "error";

async function patchClaudeCodeStatusline(
  action: "install" | "uninstall",
  opts: { dryRun: boolean; force: boolean; bin?: string; stubPresent?: boolean },
): Promise<{ status: StatuslineStepStatus; detail: string; backupPath?: string }> {
  // opts.bin: the path to REGISTER (stable-runtime copy when active, #180).
  // Build/existence is still checked against the source STATUSLINE_BIN — the
  // copy mirrors it and may not exist yet under dry-run.
  const command = statuslineCommand(opts.bin ?? STATUSLINE_BIN, opts.stubPresent);
  if (action === "install" && !(await fileExists(STATUSLINE_BIN))) {
    return { status: "error", detail: `statusline not built: ${STATUSLINE_BIN} — run 'npm run build'` };
  }

  const read = await readJsonConfig(CLAUDE_CODE_SETTINGS);
  if ("error" in read) return { status: "error", detail: read.error };
  const data = read.data;
  const existing = data.statusLine;
  const present = existing !== undefined && existing !== null;

  if (action === "install") {
    // A different statusLine is configured → never clobber it without --yes.
    if (present && !isOurStatusline(existing)) {
      if (!opts.force) {
        return { status: "foreign-kept", detail: "a different statusLine is configured — kept it (pass --yes to use bastra's)" };
      }
    } else if (statuslineMatches(existing, command)) {
      return { status: "already-installed", detail: "bastra statusLine already configured" };
    }

    if (opts.dryRun) {
      const verb = !present ? "would add" : isOurStatusline(existing) ? "would update" : "would replace foreign";
      return { status: "would-install", detail: `${verb} statusLine → ${command}` };
    }

    const backupPath = await backupConfig(CLAUDE_CODE_SETTINGS);
    data.statusLine = buildStatuslineBlock(command);
    await atomicWriteJson(CLAUDE_CODE_SETTINGS, data);
    const how = !present ? "powerline, refreshInterval 1s" : isOurStatusline(existing) ? "path updated" : "replaced foreign";
    return { status: "installed", detail: `statusLine registered (${how})`, backupPath: backupPath ?? undefined };
  }

  // uninstall — only remove our own statusLine, never a foreign one.
  if (!present || !isOurStatusline(existing)) {
    return { status: "not-present", detail: present ? "statusLine is not bastra's — kept" : "no statusLine present" };
  }
  if (opts.dryRun) return { status: "would-remove", detail: "would remove bastra statusLine" };

  const backupPath = await backupConfig(CLAUDE_CODE_SETTINGS);
  delete data.statusLine;
  await atomicWriteJson(CLAUDE_CODE_SETTINGS, data);
  return { status: "removed", detail: "bastra statusLine removed", backupPath: backupPath ?? undefined };
}

// ─── Adapter functions ───────────────────────────────────────────

async function claudeCodeInstall(opts: InstallOpts): Promise<InstallResult> {
  const configPath = CLAUDE_CODE_CONFIG;
  const vault = await resolveVault(opts);
  if ("error" in vault) return { status: "error", message: vault.error, configPath };

  const fwd = await ensureStableForwarder({ dryRun: opts.dryRun });
  // #180: hooks and statusline must survive npx-cache eviction like the
  // forwarder — register the stable-runtime copy of every bin when active.
  // On non-npx installs mapBin is the identity (byte-identical no-op).
  const mapBin = (bin: string) => mapBinToStableRuntime(bin, fwd);
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "error", message: read.error, configPath };

  const data = read.data;
  const servers = getServersBlock(data) ?? {};
  // #481: keep a surface the user set by hand instead of resetting it to the
  // install default on every reinstall.
  const block = buildServerBlock(
    vault.path,
    fwd.path,
    existingToolSurface(servers[SERVER_KEY]) ?? undefined,
    // #531: the configured endpoint, or the one this registration already
    // carries — a GUI client inherits no shell export.
    serverBlockEndpoint(servers[SERVER_KEY]),
    // #647: env keys the user added (BASTRA_FORWARDER_SPAWN=0, …) survive.
    foreignEnv(servers[SERVER_KEY]),
  );

  const mcpMatches = blocksMatch(servers[SERVER_KEY], block);
  const skillResult = await copySkill({ dryRun: opts.dryRun });
  const hookResult = await patchClaudeCodeHooks("install", {
    dryRun: opts.dryRun,
    includeStop: opts.withStopHook === true,
    mapBin,
    stubPresent: opts.useStub,
  });
  const statuslineResult = await patchClaudeCodeStatusline("install", {
    dryRun: opts.dryRun,
    force: opts.force === true,
    bin: mapBin(STATUSLINE_BIN),
    stubPresent: opts.useStub,
  });

  if (skillResult.status === "error") return { status: "error", message: `skill: ${skillResult.detail}`, configPath };
  if (hookResult.status === "error") return { status: "error", message: `hooks: ${hookResult.detail}`, configPath };
  if (statuslineResult.status === "error") return { status: "error", message: `statusline: ${statuslineResult.detail}`, configPath };

  // If everything is already in place: no MCP write, no Skill write, no Hook write.
  // A kept foreign statusLine counts as settled (nothing to write) — we just
  // surface the hint that --yes would switch it to bastra's.
  const statuslineSettled =
    statuslineResult.status === "already-installed" || statuslineResult.status === "foreign-kept";
  const allAlreadyInstalled =
    mcpMatches &&
    skillResult.status === "already-installed" &&
    hookResult.status === "already-installed" &&
    statuslineSettled;
  if (allAlreadyInstalled) {
    const msg = statuslineResult.status === "foreign-kept"
      ? "MCP, skill, hooks in place; statusLine: foreign one kept (pass --yes to use bastra's)"
      : "MCP server, skill, hooks, and statusLine all already in place";
    return { status: "already-installed", message: msg, configPath };
  }

  if (opts.dryRun) {
    const steps: string[] = [];
    if (fwd.note) steps.push(`runtime: ${fwd.note}`);
    if (!mcpMatches) steps.push(`mcp: would register '${SERVER_KEY}' in ${configPath}`);
    else steps.push("mcp: already matches");
    steps.push(`skill: ${skillResult.detail}`);
    steps.push(`hooks: ${hookResult.detail}`);
    steps.push(`statusline: ${statuslineResult.detail}`);
    return { status: "would-install", message: steps.join("\n  · "), configPath };
  }

  // Write MCP block (if changed)
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
  lines.push(`hooks: ${hookResult.detail}`);
  lines.push(`statusline: ${statuslineResult.detail}`);
  lines.push("restart Claude Code to activate");

  return {
    status: "installed",
    message: lines.join("\n  · "),
    configPath,
    backupPath: backupPath ?? statuslineResult.backupPath,
  };
}

async function claudeCodeUninstall(opts: { dryRun: boolean }): Promise<UninstallResult> {
  const configPath = CLAUDE_CODE_CONFIG;
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "error", message: read.error, configPath };

  const data = read.data;
  const servers = getServersBlock(data);
  const mcpPresent = !!(servers && SERVER_KEY in servers);

  // Skill is shared with Claude Desktop (~/.claude/skills/bastra-recall).
  // We don't remove it here — Claude Desktop might still need it. Once no
  // surface registration references it, cmdUninstall's final sweep removes
  // it (#181).
  const hookResult = await patchClaudeCodeHooks("uninstall", { dryRun: opts.dryRun });
  const statuslineResult = await patchClaudeCodeStatusline("uninstall", { dryRun: opts.dryRun, force: false });

  if (!mcpPresent && hookResult.status === "not-present" && statuslineResult.status === "not-present") {
    return { status: "not-present", message: "nothing to remove (skill: shared file — final sweep decides)", configPath };
  }

  if (opts.dryRun) {
    const steps: string[] = [];
    steps.push(mcpPresent ? `mcp: would remove '${SERVER_KEY}'` : "mcp: not present");
    steps.push(`hooks: ${hookResult.detail}`);
    steps.push(`statusline: ${statuslineResult.detail}`);
    steps.push("skill: shared file — final sweep decides");
    return { status: "would-remove", message: steps.join("\n  · "), configPath };
  }

  // Write MCP removal
  let backupPath: string | undefined;
  if (mcpPresent && servers) {
    backupPath = (await backupConfig(configPath)) ?? undefined;
    delete servers[SERVER_KEY];
    data.mcpServers = servers;
    await atomicWriteJson(configPath, data);
  }

  const lines: string[] = [];
  lines.push(mcpPresent ? `mcp: removed '${SERVER_KEY}'` : "mcp: not present");
  lines.push(`hooks: ${hookResult.detail}`);
  lines.push(`statusline: ${statuslineResult.detail}`);
  lines.push("skill: shared file — final sweep decides");
  lines.push("restart Claude Code to drop the connection");

  return {
    status: "removed",
    message: lines.join("\n  · "),
    configPath,
    backupPath: backupPath ?? statuslineResult.backupPath,
  };
}

async function claudeCodeDoctor(): Promise<DoctorResult> {
  const configPath = CLAUDE_CODE_CONFIG;
  const details: Record<string, string> = {};

  // MCP entry in ~/.claude.json
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "broken", message: read.error, details };
  details["claude-json"] = read.existed ? "present" : "missing";
  const servers = getServersBlock(read.data) ?? {};
  const registered = SERVER_KEY in servers;
  details["mcp-registration"] = registered ? "present" : "missing";

  let forwarderBroken = false;
  if (registered) {
    const block = servers[SERVER_KEY] as Record<string, unknown>;
    const args = Array.isArray(block?.args) ? block.args : [];
    const fwd = args[0];
    if (typeof fwd === "string") {
      const check = checkForwarderRegistration(fwd, await fileExists(fwd), "claude-code");
      details["forwarder-path"] = check.detail;
      forwarderBroken = check.broken;
    }
    const env = block?.env as Record<string, unknown> | undefined;
    const vault = env?.BASTRA_VAULT_PATH;
    if (typeof vault === "string") {
      details["vault-path"] = (await fileExists(vault)) ? `${vault} (exists)` : `${vault} (MISSING)`;
    }
  }

  // Skill — #456: compared against the shipped bundle, not merely present.
  const skillState = await inspectSkillInstall(SKILL_SOURCE_DIR, SKILL_TARGET_DIR);
  details["skill"] = describeSkillInstall(skillState, SKILL_TARGET_DIR);

  // Hooks. Stop is optional: some users intentionally disable autonomous
  // save-eval while keeping the rest of the reflex layer active.
  let requiredHooksMissing = false;
  let hookPathBroken = false;
  let stopHookRegistered = false;
  let hooksDisabledBy: string | undefined;
  const settingsRead = await readJsonConfig(CLAUDE_CODE_SETTINGS);
  if ("error" in settingsRead) {
    details["hooks"] = `settings.json broken: ${settingsRead.error}`;
    requiredHooksMissing = true;
  } else {
    const hooks = (settingsRead.data.hooks && typeof settingsRead.data.hooks === "object")
      ? settingsRead.data.hooks as Record<string, unknown>
      : {};
    const found = registeredHookBins(hooks);
    const registeredCommands = registeredHookCommands(hooks);
    const requiredMissing = REQUIRED_HOOK_FILES.filter((f) => !found.has(f));
    const registrationMissing = missingRequiredHookRegistrations(hooks);
    const optionalMissing = OUR_HOOK_FILES
      .filter((f) => !REQUIRED_HOOK_FILES.includes(f))
      .filter((f) => !found.has(f));
    requiredHooksMissing = requiredMissing.length > 0 || registrationMissing.length > 0;
    stopHookRegistered = found.has("stop-hook.js");
    // Claude Code's own off switch — user file only; a project file can override it.
    if (settingsRead.data.disableAllHooks === true) {
      hooksDisabledBy = `"disableAllHooks": true in ${CLAUDE_CODE_SETTINGS}`;
    }
    details["hooks"] = requiredHooksMissing
      ? `${found.size}/${OUR_HOOK_FILES.length} lanes registered (missing required: ${[
          ...requiredMissing,
          ...registrationMissing,
        ].join(", ")})`
      : optionalMissing.length > 0
        ? `${found.size}/${OUR_HOOK_FILES.length} registered (optional disabled: ${optionalMissing.join(", ")})`
        : `${OUR_HOOK_FILES.length}/${OUR_HOOK_FILES.length} registered`;

    // #650: the archive opt-in (its state is in the features block) acts
    // only on a Bash hook call that carries the Claude Code marker.
    const bashPre = registeredCommands.find(([f]) => f === "bash-pre-hook.js")?.[1];
    if (archiveMode(await getArchiveEnabled().catch(() => false)) !== "off" && bashPre !== undefined && !bashPre.includes(CLIENT_MARKER.trim())) {
      details["archive"] = "opted in, but the Bash hook carries no Claude Code marker, so nothing is rewritten — re-run 'bastra install claude-code'";
    }

    const hookPathProblems = await checkHookPaths(registeredCommands);
    hookPathBroken = hookPathProblems.length > 0;
    if (hookPathBroken) details["hook-paths"] = hookPathProblems.join("; ");

    // Statusline (optional/cosmetic — never marks the surface as broken).
    const sl = settingsRead.data.statusLine;
    details["statusline"] = sl === undefined || sl === null
      ? "missing (run 'bastra install' to add it)"
      : isOurStatusline(sl)
        ? "present (bastra)"
        : "present (foreign — run 'bastra install --yes' to replace it)";
  }

  // Daemon
  const probe = await probeDaemon();
  // #531: the key names the endpoint that was actually probed. It used to say
  // 6723 unconditionally while the probe went wherever the env pointed.
  details[`daemon-at-${probe.endpoint?.label ?? "?"}`] = probe.ok ? `reachable (${probe.detail})` : probe.detail;

  if (!registered) return { status: "missing", message: "MCP not registered with Claude Code", details };
  const features = {
    recallHooks: !requiredHooksMissing,
    stopHook: stopHookRegistered,
    skill: skillState.status !== "missing",
    ...(hooksDisabledBy ? { hooksDisabledBy } : {}),
    ...mcpEnvFeatures(servers[SERVER_KEY], configPath),
  };
  const broken =
    forwarderBroken ||
    details["vault-path"]?.includes("MISSING") === true ||
    requiredHooksMissing ||
    hookPathBroken ||
    (details["skill"] === "missing" || details["skill"].startsWith("STALE"));
  if (broken) return { status: "broken", message: "registered but some pieces need repair — re-run 'bastra install claude-code'", details, features };
  return { status: "ok", message: "MCP + skill + required hooks registered and healthy", details, features };
}

export const claudeCodeAdapter: Adapter = {
  surface: "claude-code",
  description: "Claude Code (MCP + Skill + Hooks)",
  configPath: CLAUDE_CODE_CONFIG,
  install: claudeCodeInstall,
  uninstall: claudeCodeUninstall,
  doctor: claudeCodeDoctor,
};
