/**
 * Codex + ChatGPT desktop adapter (#15).
 *
 * Codex CLI, its IDE integration and ChatGPT desktop share ~/.codex on the
 * same host. MCP mutations intentionally go through the official `codex mcp`
 * command (Codex owns TOML serialization); hooks and the cross-client skill
 * use their documented JSON/directory surfaces. All writes are idempotent,
 * preserve foreign entries and back up user configuration before mutation.
 */
import { copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  BASH_FAIL_HOOK_BIN,
  BASH_PRE_HOOK_BIN,
  CODEX_CONFIG,
  CODEX_HOOKS,
  CODEX_SKILL_TARGET_DIR,
  HOOK_STUB_BIN,
  PRE_TOOL_HOOK_BIN,
  PROMPT_HOOK_BIN,
  SESSION_HOOK_BIN,
  STOP_HOOK_BIN,
  TODO_HOOK_BIN,
  SKILL_SOURCE_DIR,
} from "../paths.js";
import {
  SERVER_KEY,
  atomicWriteJson,
  backupConfig,
  buildServerBlock,
  fileExists,
  probeDaemon,
  readJsonConfig,
  resolveVault,
} from "../helpers.js";
import { copySkill, describeSkillInstall, inspectSkillInstall } from "../skill.js";
import { findCodexExecutable, codexMcpGet, codexServerMatches } from "../codex-cli.js";
import { runCaptured } from "../exec.js";
import { checkForwarderRegistration, ensureStableForwarder, mapBinToStableRuntime } from "../stable-runtime.js";
import type { Adapter, DoctorResult, InstallOpts, InstallResult, UninstallResult } from "../types.js";

type HookEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";

interface CodexHookDef {
  event: HookEvent;
  matcher?: string;
  bin: string;
  timeout: number;
  label: string;
  stubSubcommand: string;
}

const STOP_DEF: CodexHookDef = {
  event: "Stop",
  bin: STOP_HOOK_BIN,
  timeout: 3,
  label: "evaluating memory save",
  stubSubcommand: "stop",
};

function codexHookDefinitions(includeStop: boolean): CodexHookDef[] {
  const defs: CodexHookDef[] = [
    { event: "SessionStart", matcher: "startup|resume|clear|compact", bin: SESSION_HOOK_BIN, timeout: 3, label: "loading context", stubSubcommand: "session" },
    { event: "UserPromptSubmit", bin: PROMPT_HOOK_BIN, timeout: 2, label: "recalling for prompt", stubSubcommand: "prompt" },
    { event: "PreToolUse", matcher: "^apply_patch$", bin: PRE_TOOL_HOOK_BIN, timeout: 2, label: "recalling for patch", stubSubcommand: "write" },
    { event: "PreToolUse", matcher: "^update_plan$", bin: TODO_HOOK_BIN, timeout: 2, label: "recalling for plan", stubSubcommand: "todo" },
    { event: "PreToolUse", matcher: "^Bash$", bin: BASH_PRE_HOOK_BIN, timeout: 2, label: "checking shell command", stubSubcommand: "bash-pre" },
    { event: "PostToolUse", matcher: "^Bash$", bin: BASH_FAIL_HOOK_BIN, timeout: 2, label: "learning from shell result", stubSubcommand: "bash-fail" },
  ];
  if (includeStop) defs.push(STOP_DEF);
  return defs;
}

const HOOK_EVENTS: HookEvent[] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
const OUR_HOOK_FILES = [
  "hook.js",
  "session-hook.js",
  "prompt-hook.js",
  "todo-hook.js",
  "bash-pre-hook.js",
  "bash-fail-hook.js",
  "stop-hook.js",
];
const REQUIRED_HOOK_FILES = OUR_HOOK_FILES.filter((file) => file !== "stop-hook.js");

function shellToken(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hookEntry(def: CodexHookDef, stubPresent = existsSync(HOOK_STUB_BIN)): Record<string, unknown> {
  const runner = stubPresent
    ? `${shellToken(HOOK_STUB_BIN)} ${def.stubSubcommand}`
    : `node ${shellToken(def.bin)}`;
  const entry: Record<string, unknown> = {};
  if (def.matcher) entry.matcher = def.matcher;
  entry.hooks = [{
    type: "command",
    command: `BASTRA_HOOK_CLIENT=codex ${runner}`,
    timeout: def.timeout,
    statusMessage: `Bastra Recall · ${def.label}`,
  }];
  return entry;
}

function isOurHookEntry(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const hooks = (value as Record<string, unknown>).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((hook) => {
    if (!hook || typeof hook !== "object") return false;
    const record = hook as Record<string, unknown>;
    if (typeof record.statusMessage === "string" &&
        (record.statusMessage.startsWith("bastra-recall:") || record.statusMessage.startsWith("Bastra Recall ·"))) return true;
    const command = typeof record.command === "string" ? record.command : "";
    return command.includes("BASTRA_HOOK_CLIENT=codex") &&
      (command.includes("bastra-hook") || OUR_HOOK_FILES.some((file) => command.includes(`/${file}`)));
  });
}

export interface CodexHookPlan {
  before: Record<HookEvent, unknown[]>;
  after: Record<HookEvent, unknown[]>;
  stopPreserved: boolean;
}

/** Pure merge planner: foreign hook entries pass through byte-for-byte. */
export function planCodexHooks(
  action: "install" | "uninstall",
  hooks: Record<string, unknown>,
  opts: { includeStop: boolean; mapBin?: (bin: string) => string; stubPresent?: boolean },
): CodexHookPlan {
  const map = (def: CodexHookDef): CodexHookDef =>
    opts.mapBin ? { ...def, bin: opts.mapBin(def.bin) } : def;
  const defs = codexHookDefinitions(opts.includeStop).map(map);
  const stopDef = map(STOP_DEF);
  const stubPresent = opts.stubPresent ?? existsSync(HOOK_STUB_BIN);
  const before = {} as Record<HookEvent, unknown[]>;
  const after = {} as Record<HookEvent, unknown[]>;
  let stopPreserved = false;

  for (const event of HOOK_EVENTS) {
    const current = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    before[event] = current;
    if (action === "install" && !opts.includeStop && event === "Stop") {
      stopPreserved = current.some(isOurHookEntry);
      after[event] = current.map((entry) => isOurHookEntry(entry) ? hookEntry(stopDef, stubPresent) : entry);
    } else {
      after[event] = current.filter((entry) => !isOurHookEntry(entry));
    }
  }
  if (action === "install") {
    for (const def of defs) after[def.event].push(hookEntry(def, stubPresent));
  }
  return { before, after, stopPreserved };
}

type HookStepStatus = "installed" | "already-installed" | "would-install" | "removed" | "not-present" | "would-remove" | "error";

export async function patchCodexHooks(
  action: "install" | "uninstall",
  opts: {
    dryRun: boolean;
    includeStop?: boolean;
    mapBin?: (bin: string) => string;
    hooksPath?: string;
    stubPresent?: boolean;
    exists?: (path: string) => Promise<boolean>;
  },
): Promise<{ status: HookStepStatus; detail: string; backupPath?: string }> {
  const hooksPath = opts.hooksPath ?? CODEX_HOOKS;
  const exists = opts.exists ?? fileExists;
  const sourceDefs = codexHookDefinitions(opts.includeStop === true);
  if (action === "install") {
    for (const def of sourceDefs) {
      if (!(await exists(def.bin))) {
        return { status: "error", detail: `hook binary missing: ${def.bin} — run 'npm run build'` };
      }
    }
  }

  const read = await readJsonConfig(hooksPath);
  if ("error" in read) return { status: "error", detail: read.error };
  const data = read.data;
  const hooks = data.hooks && typeof data.hooks === "object" && !Array.isArray(data.hooks)
    ? data.hooks as Record<string, unknown>
    : {};
  const plan = planCodexHooks(action, hooks, {
    includeStop: opts.includeStop === true,
    mapBin: opts.mapBin,
    stubPresent: opts.stubPresent,
  });
  const unchanged = HOOK_EVENTS.every(
    (event) => JSON.stringify(plan.before[event]) === JSON.stringify(plan.after[event]),
  );
  if (unchanged) {
    return action === "install"
      ? { status: "already-installed", detail: `${sourceDefs.length} Codex hooks already match` }
      : { status: "not-present", detail: "no bastra-recall Codex hooks present" };
  }
  if (opts.dryRun) {
    return action === "install"
      ? { status: "would-install", detail: `would register ${sourceDefs.length} Codex hooks${plan.stopPreserved ? " (existing Stop hook retained)" : ""}` }
      : { status: "would-remove", detail: "would remove bastra-recall Codex hooks" };
  }

  for (const event of HOOK_EVENTS) {
    if (plan.after[event].length > 0) hooks[event] = plan.after[event];
    else delete hooks[event];
  }
  if (Object.keys(hooks).length > 0) data.hooks = hooks;
  else delete data.hooks;
  const backupPath = await backupConfig(hooksPath);
  await atomicWriteJson(hooksPath, data);
  return action === "install"
    ? { status: "installed", detail: `${sourceDefs.length} Codex hooks registered`, backupPath: backupPath ?? undefined }
    : { status: "removed", detail: "bastra-recall Codex hooks removed", backupPath: backupPath ?? undefined };
}

function mcpMissing(detail: string): boolean {
  return /No MCP server named/.test(detail);
}

async function replaceMcpRegistration(
  bin: string,
  target: ReturnType<typeof buildServerBlock>,
  existing: boolean,
): Promise<{ ok: boolean; detail: string; backupPath?: string }> {
  const backupPath = await backupConfig(CODEX_CONFIG);
  if (existing) {
    const removed = runCaptured(bin, ["mcp", "remove", SERVER_KEY], { timeoutMs: 10_000 });
    if (!removed.ok) return { ok: false, detail: `cannot replace MCP registration: ${removed.detail}`, backupPath: backupPath ?? undefined };
  }
  const added = runCaptured(
    bin,
    ["mcp", "add", SERVER_KEY, "--env", `BASTRA_VAULT_PATH=${target.env.BASTRA_VAULT_PATH}`, "--", target.command, ...target.args],
    { timeoutMs: 15_000 },
  );
  if (added.ok) return { ok: true, detail: `registered '${SERVER_KEY}'`, backupPath: backupPath ?? undefined };

  // Restore the exact pre-install TOML when a replacement failed. If this was
  // a new registration, remove any partial entry best-effort.
  if (backupPath) await copyFile(backupPath, CODEX_CONFIG);
  else runCaptured(bin, ["mcp", "remove", SERVER_KEY], { timeoutMs: 10_000 });
  return { ok: false, detail: `MCP registration failed and previous config was restored: ${added.detail}`, backupPath: backupPath ?? undefined };
}

async function codexInstall(opts: InstallOpts): Promise<InstallResult> {
  const configPath = CODEX_CONFIG;
  const bin = findCodexExecutable();
  if (!bin) return { status: "error", message: "Codex/ChatGPT desktop executable not found", configPath };
  const vault = await resolveVault(opts);
  if ("error" in vault) return { status: "error", message: vault.error, configPath };

  const runtime = await ensureStableForwarder({ dryRun: opts.dryRun });
  const mapBin = (path: string) => mapBinToStableRuntime(path, runtime);
  const target = buildServerBlock(vault.path, runtime.path);
  const current = codexMcpGet(bin);
  if (!current.result.ok && !mcpMissing(current.result.detail)) {
    return { status: "error", message: `cannot inspect Codex MCP config: ${current.result.detail}`, configPath };
  }
  const mcpMatches = codexServerMatches(current.server, target);

  // Preflight file-backed pieces before asking Codex to mutate TOML.
  const skillPlan = await copySkill(
    { dryRun: true },
    { targetDir: CODEX_SKILL_TARGET_DIR },
  );
  const hookPlan = await patchCodexHooks("install", {
    dryRun: true,
    includeStop: opts.withStopHook === true,
    mapBin,
  });
  if (skillPlan.status === "error") return { status: "error", message: `skill: ${skillPlan.detail}`, configPath };
  if (hookPlan.status === "error") return { status: "error", message: `hooks: ${hookPlan.detail}`, configPath };

  if (opts.dryRun) {
    const lines = [
      runtime.note ? `runtime: ${runtime.note}` : "",
      mcpMatches ? "mcp: already matches" : `mcp: would register '${SERVER_KEY}' through codex mcp`,
      `skill: ${skillPlan.detail}`,
      `hooks: ${hookPlan.detail}`,
    ].filter(Boolean);
    return { status: "would-install", message: lines.join("\n  · "), configPath };
  }

  let mcpBackup: string | undefined;
  if (!mcpMatches) {
    const changed = await replaceMcpRegistration(bin, target, current.server !== null);
    if (!changed.ok) return { status: "error", message: changed.detail, configPath, backupPath: changed.backupPath };
    mcpBackup = changed.backupPath;
  }
  const skill = await copySkill({ dryRun: false }, { targetDir: CODEX_SKILL_TARGET_DIR });
  const hooks = await patchCodexHooks("install", {
    dryRun: false,
    includeStop: opts.withStopHook === true,
    mapBin,
  });
  if (skill.status === "error") return { status: "error", message: `skill: ${skill.detail}`, configPath, backupPath: mcpBackup };
  if (hooks.status === "error") return { status: "error", message: `hooks: ${hooks.detail}`, configPath, backupPath: mcpBackup };

  const unchanged = mcpMatches && skill.status === "already-installed" && hooks.status === "already-installed";
  if (unchanged) {
    return {
      status: "already-installed",
      message: "MCP, Codex/ChatGPT skill and required hooks already match",
      configPath,
    };
  }
  const lines = [
    runtime.note ? `runtime: ${runtime.note}` : "",
    mcpMatches ? "mcp: already matches" : `mcp: registered '${SERVER_KEY}' through Codex`,
    `skill: ${skill.detail}`,
    `hooks: ${hooks.detail}`,
    "review changed hooks in Codex '/hooks', then restart ChatGPT desktop, Codex sessions and the IDE extension",
  ].filter(Boolean);
  return {
    status: "installed",
    message: lines.join("\n  · "),
    configPath,
    backupPath: mcpBackup ?? hooks.backupPath,
  };
}

async function codexUninstall(opts: { dryRun: boolean }): Promise<UninstallResult> {
  const configPath = CODEX_CONFIG;
  const bin = findCodexExecutable();
  if (!bin) return { status: "error", message: "Codex/ChatGPT desktop executable not found", configPath };
  const current = codexMcpGet(bin);
  if (!current.result.ok && !mcpMissing(current.result.detail)) {
    return { status: "error", message: `cannot inspect Codex MCP config: ${current.result.detail}`, configPath };
  }
  const mcpPresent = current.server !== null;
  // Preflight must never mutate the hook file. The actual removal happens
  // once below, after the MCP step has succeeded, so its backup and status
  // are reported accurately and a failed MCP removal leaves hooks intact.
  const hookPlan = await patchCodexHooks("uninstall", { dryRun: true });
  const skillPresent = await fileExists(CODEX_SKILL_TARGET_DIR);
  if (hookPlan.status === "error") return { status: "error", message: `hooks: ${hookPlan.detail}`, configPath };
  if (!mcpPresent && !skillPresent && hookPlan.status === "not-present") {
    return { status: "not-present", message: "no bastra-recall Codex integration present", configPath };
  }
  if (opts.dryRun) {
    return {
      status: "would-remove",
      message: [
        mcpPresent ? `mcp: would remove '${SERVER_KEY}'` : "mcp: not present",
        `hooks: ${hookPlan.detail}`,
        skillPresent ? `skill: would remove ${CODEX_SKILL_TARGET_DIR}` : "skill: not present",
      ].join("\n  · "),
      configPath,
    };
  }

  let backupPath: string | undefined;
  if (mcpPresent) {
    backupPath = (await backupConfig(configPath)) ?? undefined;
    const removed = runCaptured(bin, ["mcp", "remove", SERVER_KEY], { timeoutMs: 10_000 });
    if (!removed.ok) return { status: "error", message: `cannot remove MCP registration: ${removed.detail}`, configPath, backupPath };
  }
  if (skillPresent) await rm(CODEX_SKILL_TARGET_DIR, { recursive: true, force: true });
  const hooks = await patchCodexHooks("uninstall", { dryRun: false });
  if (hooks.status === "error") return { status: "error", message: `hooks: ${hooks.detail}`, configPath, backupPath };
  return {
    status: "removed",
    message: [
      mcpPresent ? `mcp: removed '${SERVER_KEY}'` : "mcp: not present",
      `hooks: ${hooks.detail}`,
      skillPresent ? `skill: removed ${CODEX_SKILL_TARGET_DIR}` : "skill: not present",
      "restart ChatGPT desktop, Codex CLI sessions and the IDE extension",
    ].join("\n  · "),
    configPath,
    backupPath: backupPath ?? hooks.backupPath,
  };
}

function registeredCodexHookFiles(hooks: Record<string, unknown>): Set<string> {
  const found = new Set<string>();
  for (const event of HOOK_EVENTS) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    for (const entry of entries) {
      if (!isOurHookEntry(entry)) continue;
      const handlers = (entry as Record<string, unknown>).hooks;
      if (!Array.isArray(handlers)) continue;
      for (const handler of handlers) {
        const command = typeof (handler as Record<string, unknown>)?.command === "string"
          ? String((handler as Record<string, unknown>).command)
          : "";
        for (const def of codexHookDefinitions(true)) {
          if (command.includes(`/${def.bin.split("/").pop()}`) ||
              (command.includes("bastra-hook") && command.includes(` ${def.stubSubcommand}`))) {
            found.add(def.bin.split("/").pop() ?? def.bin);
          }
        }
      }
    }
  }
  return found;
}

async function codexDoctor(): Promise<DoctorResult> {
  const details: Record<string, string> = {};
  const bin = findCodexExecutable();
  details["codex-executable"] = bin ?? "not found (Codex CLI or ChatGPT desktop required)";
  details["shared-host-config"] = CODEX_CONFIG;
  if (!bin) return { status: "missing", message: "Codex/ChatGPT desktop not detected", details };

  const current = codexMcpGet(bin);
  if (!current.result.ok && !mcpMissing(current.result.detail)) {
    return { status: "broken", message: `cannot inspect Codex MCP config: ${current.result.detail}`, details };
  }
  const registered = current.server !== null;
  details["mcp-registration"] = registered ? "present (shared with ChatGPT desktop)" : "missing";
  let forwarderBroken = false;
  if (current.server) {
    const path = current.server.transport.args?.[0];
    if (typeof path === "string") {
      const check = checkForwarderRegistration(path, await fileExists(path), "codex");
      details["forwarder-path"] = check.detail;
      forwarderBroken = check.broken;
    } else {
      details["forwarder-path"] = "missing from transport args[0]";
      forwarderBroken = true;
    }
    const vault = current.server.transport.env?.BASTRA_VAULT_PATH;
    details["vault-path"] = typeof vault === "string"
      ? `${vault}${await fileExists(vault) ? " (exists)" : " (MISSING)"}`
      : "not set in env";
  }
  // #456: compared against the shipped bundle, not merely present.
  details.skill = describeSkillInstall(await inspectSkillInstall(SKILL_SOURCE_DIR, CODEX_SKILL_TARGET_DIR), CODEX_SKILL_TARGET_DIR);

  let hooksBroken = false;
  const hookRead = await readJsonConfig(CODEX_HOOKS);
  if ("error" in hookRead) {
    details.hooks = hookRead.error;
    hooksBroken = true;
  } else {
    const hooks = hookRead.data.hooks && typeof hookRead.data.hooks === "object" && !Array.isArray(hookRead.data.hooks)
      ? hookRead.data.hooks as Record<string, unknown>
      : {};
    const found = registeredCodexHookFiles(hooks);
    const missing = REQUIRED_HOOK_FILES.filter((file) => !found.has(file));
    hooksBroken = missing.length > 0;
    details.hooks = missing.length > 0
      ? `${found.size}/${OUR_HOOK_FILES.length} registered (missing required: ${missing.join(", ")})`
      : found.has("stop-hook.js")
        ? `${OUR_HOOK_FILES.length}/${OUR_HOOK_FILES.length} registered`
        : `${REQUIRED_HOOK_FILES.length}/${OUR_HOOK_FILES.length} registered (optional Stop disabled)`;
    if (!hooksBroken) details["hook-trust"] = "Codex-owned; use '/hooks' to confirm registered hooks are active";
  }
  const probe = await probeDaemon();
  details["daemon-on-6723"] = probe.ok ? `reachable (${probe.detail})` : probe.detail;
  if (!registered) return { status: "missing", message: "MCP not registered with Codex/ChatGPT desktop", details };
  const broken = forwarderBroken || hooksBroken || (details.skill === "missing" || details.skill.startsWith("STALE")) ||
    details["vault-path"]?.includes("MISSING") === true || details["vault-path"]?.startsWith("not ") === true;
  if (broken) return { status: "broken", message: "registered but some pieces need repair — re-run 'bastra install codex'", details };
  return { status: "ok", message: "MCP + Codex/ChatGPT skill + required hooks registered and healthy", details };
}

export const codexAdapter: Adapter = {
  surface: "codex",
  description: "Codex + ChatGPT Desktop (MCP + Skill + Hooks)",
  configPath: CODEX_CONFIG,
  install: codexInstall,
  uninstall: codexUninstall,
  doctor: codexDoctor,
};
