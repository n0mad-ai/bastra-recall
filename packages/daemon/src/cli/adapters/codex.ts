import { ensureBootstrap, describeBootstrap } from "../bootstrap.js";
import { codexGateSupported, CODEX_GATE_MIN_VERSION } from "../../codex-gate-capability.js";
import { windowsHookToken } from "./command-paths.js";
/**
 * Codex + ChatGPT desktop adapter (#15).
 *
 * Codex CLI, its IDE integration and ChatGPT desktop share ~/.codex on the
 * same host. MCP mutations intentionally go through the official `codex mcp`
 * command (Codex owns TOML serialization); hooks and the cross-client skill
 * use their documented JSON/directory surfaces. All writes are idempotent,
 * preserve foreign entries and back up user configuration before mutation.
 */
import { copyFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  BASH_FAIL_HOOK_BIN,
  BASH_PRE_HOOK_BIN,
  GATE_HOOK_BIN,
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
  existingToolSurface,
  mcpEnvFeatures,
  serverBlockEndpoint,
  foreignEnv,
  fileExists,
  probeDaemon,
  readJsonConfig,
  resolveVault,
} from "../helpers.js";
import { copySkill, describeSkillInstall, inspectSkillInstall } from "../skill.js";
import { PLAN_TOOL_KEY, ensureCodexPlanTool, inspectPlanTool } from "./codex-plan-tool.js";
import { findCodexExecutable, codexMcpGet, codexServerMatches, codexRuntimeVersion } from "../codex-cli.js";
import { runCaptured } from "../exec.js";
import { checkForwarderRegistration, ensureStableForwarder, mapBinToStableRuntime } from "../stable-runtime.js";
import {
  existingHookWrapper,
  hookCommandTokens,
  fileOf,
  leftAloneNote,
  lookalikeHookCommands,
  runsOurHookRunner,
  slashes,
  type HookWrapper,
} from "./command-paths.js";
import { CODEX_SAVE_NOTICE_MATCHER } from "../../save-notice-lane.js";
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

function codexHookDefinitions(includeStop: boolean, codexVersion?: string | null): CodexHookDef[] {
  const defs: CodexHookDef[] = [
    { event: "SessionStart", matcher: "startup|resume|clear|compact|fork", bin: SESSION_HOOK_BIN, timeout: 3, label: "loading context", stubSubcommand: "session" },
    { event: "UserPromptSubmit", bin: PROMPT_HOOK_BIN, timeout: 2, label: "recalling for prompt", stubSubcommand: "prompt" },
    { event: "PreToolUse", matcher: "^apply_patch$", bin: PRE_TOOL_HOOK_BIN, timeout: 2, label: "recalling for patch", stubSubcommand: "write" },
    { event: "PreToolUse", matcher: "^update_plan$", bin: TODO_HOOK_BIN, timeout: 2, label: "recalling for plan", stubSubcommand: "todo" },
    { event: "PreToolUse", matcher: "^Bash$", bin: BASH_PRE_HOOK_BIN, timeout: 2, label: "checking shell command", stubSubcommand: "bash-pre" },
    { event: "PostToolUse", matcher: "^Bash$", bin: BASH_FAIL_HOOK_BIN, timeout: 2, label: "learning from shell result", stubSubcommand: "bash-fail" },
    { event: "PostToolUse", matcher: CODEX_SAVE_NOTICE_MATCHER, bin: BASH_FAIL_HOOK_BIN, timeout: 2, label: "announcing saved memory", stubSubcommand: "bash-fail" },
  ];
  // #1300 runtime evidence is exactly 0.162.1. Other/unknown versions keep
  // legacy context-only lanes, with neither a deny gate nor must-load claims.
  // Official catch-all matcher: https://learn.chatgpt.com/docs/hooks#matcher-patterns
  if (codexGateSupported(codexVersion)) defs.push({ event: "PreToolUse", matcher: "*", bin: GATE_HOOK_BIN, timeout: 2, label: "checking must-load and reflex rules", stubSubcommand: "gate" });
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
  "gate-hook.js",
];
const REQUIRED_HOOK_FILES = OUR_HOOK_FILES.filter((file) => file !== "stop-hook.js" && file !== "gate-hook.js");

const CLIENT_MARKER = "BASTRA_HOOK_CLIENT=codex";

function shellToken(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hookEntry(
  def: CodexHookDef,
  stubPresent = existsSync(HOOK_STUB_BIN),
  wrap: HookWrapper = { prefix: "", suffix: "" },
  platform: string = process.platform,
  codexVersion?: string | null,
): Record<string, unknown> {
  const token = platform === "win32" ? windowsHookToken : shellToken;
  const runner = stubPresent
    ? `${token(HOOK_STUB_BIN)} ${def.stubSubcommand}`
    : `node ${token(def.bin)}`;
  // #647/#1304: remove only our unquoted assignments adjacent to the runner.
  // Marker text inside a wrapper's quoted label is user data, kept byte-for-byte.
  let prefixEnd = wrap.prefix.length;
  for (const part of hookCommandTokens(wrap.prefix).reverse()) {
    if (wrap.prefix.slice(part.end, prefixEnd).trim() !== "" ||
        wrap.prefix.slice(part.start, part.end) !== part.value ||
        (part.value !== CLIENT_MARKER && !/^BASTRA_CODEX_VERSION=\d+\.\d+\.\d+$/.test(part.value))) break;
    prefixEnd = part.start;
  }
  const prefix = wrap.prefix.slice(0, prefixEnd);
  const version = codexGateSupported(codexVersion) ? codexVersion : null;
  const entry: Record<string, unknown> = {};
  if (def.matcher) entry.matcher = def.matcher;
  entry.hooks = [{
    type: "command",
    command: platform === "win32"
      ? `${prefix}${runner} --client=codex${version ? ` --codex-version=${version}` : ""}${wrap.suffix}`
      : `${prefix}${CLIENT_MARKER} ${version ? `BASTRA_CODEX_VERSION=${version} ` : ""}${runner}${wrap.suffix}`,
    timeout: def.timeout,
    statusMessage: `Bastra Recall · ${def.label}`,
  }];
  return entry;
}

function isOurHandler(hook: unknown): boolean {
  if (!hook || typeof hook !== "object") return false;
  const record = hook as Record<string, unknown>;
  if (typeof record.statusMessage === "string" &&
      (record.statusMessage.startsWith("bastra-recall:") || record.statusMessage.startsWith("Bastra Recall ·"))) return true;
  const command = typeof record.command === "string" ? record.command : "";
  return command.includes(CLIENT_MARKER) && runsOurHookRunner(command, OUR_HOOK_FILES, CLIENT_MARKER);
}

function isOurHookEntry(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const hooks = (value as Record<string, unknown>).hooks;
  return Array.isArray(hooks) && hooks.some(isOurHandler);
}

function foreignRemainder(entry: unknown): unknown[] {
  const record = entry as Record<string, unknown>;
  const rest = (Array.isArray(record.hooks) ? record.hooks : []).filter((hook) => !isOurHandler(hook));
  return rest.length ? [{ ...record, hooks: rest }] : [];
}

// The recognition before #683 — only to name what is now left alone.
const lookedOurs = (command: string): boolean =>
  command.includes(CLIENT_MARKER) && command.includes("bastra-hook");

export interface CodexHookPlan {
  before: Record<HookEvent, unknown[]>;
  after: Record<HookEvent, unknown[]>;
  stopPreserved: boolean;
  /** #683: commands the old substring recognition claimed; kept as they are. */
  leftAlone: string[];
}

/** Pure merge planner: foreign hook entries pass through byte-for-byte. */
export function planCodexHooks(
  action: "install" | "uninstall",
  hooks: Record<string, unknown>,
  opts: { includeStop: boolean; codexVersion?: string | null; mapBin?: (bin: string) => string; stubPresent?: boolean; platform?: string },
): CodexHookPlan {
  const map = (def: CodexHookDef): CodexHookDef =>
    opts.mapBin ? { ...def, bin: opts.mapBin(def.bin) } : def;
  const defs = codexHookDefinitions(opts.includeStop, opts.codexVersion).map(map);
  const stopDef = map(STOP_DEF);
  const stubPresent = opts.stubPresent ?? existsSync(HOOK_STUB_BIN);
  // #647: what wraps our runner for this lane today, kept on the rebuilt entry.
  const wrapOf = (def: CodexHookDef): HookWrapper =>
    existingHookWrapper(
      Array.isArray(hooks[def.event]) ? hooks[def.event] as unknown[] : [],
      def.matcher,
      fileOf(def.bin),
      def.stubSubcommand,
      isOurHookEntry,
    );
  const before = {} as Record<HookEvent, unknown[]>;
  const after = {} as Record<HookEvent, unknown[]>;
  let stopPreserved = false;

  for (const event of HOOK_EVENTS) {
    const current = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    before[event] = current;
    if (action === "install" && !opts.includeStop && event === "Stop") {
      stopPreserved = current.some(isOurHookEntry);
      after[event] = current.flatMap((entry) => isOurHookEntry(entry)
        ? [hookEntry(stopDef, stubPresent, wrapOf(stopDef), opts.platform, opts.codexVersion), ...foreignRemainder(entry)] : [entry]);
    } else {
      after[event] = current.flatMap((entry) => isOurHookEntry(entry) ? foreignRemainder(entry) : [entry]);
    }
  }
  if (action === "install") {
    for (const def of defs) after[def.event].push(hookEntry(def, stubPresent, wrapOf(def), opts.platform, opts.codexVersion));
  }
  return { before, after, stopPreserved, leftAlone: lookalikeHookCommands(hooks, HOOK_EVENTS, isOurHookEntry, lookedOurs) };
}

type HookStepStatus = "installed" | "already-installed" | "would-install" | "removed" | "not-present" | "would-remove" | "error";

export async function patchCodexHooks(
  action: "install" | "uninstall",
  opts: {
    dryRun: boolean;
    includeStop?: boolean;
    codexVersion?: string | null;
    mapBin?: (bin: string) => string;
    hooksPath?: string;
    stubPresent?: boolean;
    exists?: (path: string) => Promise<boolean>;
  },
): Promise<{ status: HookStepStatus; detail: string; backupPath?: string; note?: string }> {
  const hooksPath = opts.hooksPath ?? CODEX_HOOKS;
  const exists = opts.exists ?? fileExists;
  const sourceDefs = codexHookDefinitions(opts.includeStop === true, opts.codexVersion);
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
    codexVersion: opts.codexVersion,
    mapBin: opts.mapBin,
    stubPresent: opts.stubPresent,
  });
  const note = leftAloneNote(plan.leftAlone);
  const gateDetail = codexGateSupported(opts.codexVersion)
    ? `gate: verified Codex ${opts.codexVersion}; review new/changed definitions in /hooks`
    : `gate: preparation only (Codex ${opts.codexVersion ?? "unknown"}); deny verified only on ${CODEX_GATE_MIN_VERSION}; legacy additionalContext hints, no must-load promise`;
  const unchanged = HOOK_EVENTS.every(
    (event) => JSON.stringify(plan.before[event]) === JSON.stringify(plan.after[event]),
  );
  if (unchanged) {
    return action === "install"
      ? { status: "already-installed", detail: `${sourceDefs.length} Codex hooks already match; ${gateDetail}`, note }
      : { status: "not-present", detail: "no bastra-recall Codex hooks present", note };
  }
  if (opts.dryRun) {
    return action === "install"
      ? { status: "would-install", detail: `would register ${sourceDefs.length} Codex hooks${plan.stopPreserved ? " (existing Stop hook retained)" : ""}; ${gateDetail}`, note }
      : { status: "would-remove", detail: "would remove bastra-recall Codex hooks", note };
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
    ? { status: "installed", detail: `${sourceDefs.length} Codex hooks registered; ${gateDetail}`, backupPath: backupPath ?? undefined, note }
    : { status: "removed", detail: "bastra-recall Codex hooks removed", backupPath: backupPath ?? undefined, note };
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
    [
      "mcp",
      "add",
      SERVER_KEY,
      ...Object.entries(target.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
      "--",
      target.command,
      ...target.args,
    ],
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
  const codexVersion = codexRuntimeVersion(bin);
  const vault = await resolveVault(opts);
  if ("error" in vault) return { status: "error", message: vault.error, configPath };

  const runtime = await ensureStableForwarder({ dryRun: opts.dryRun });
  const mapBin = (path: string) => mapBinToStableRuntime(path, runtime);
  const current = codexMcpGet(bin);
  if (!current.result.ok && !mcpMissing(current.result.detail)) {
    return { status: "error", message: `cannot inspect Codex MCP config: ${current.result.detail}`, configPath };
  }
  // #481: keep a surface the user set by hand instead of resetting it to the
  // install default on every reinstall.
  const target = buildServerBlock(
    vault.path,
    runtime.path,
    existingToolSurface(current.server?.transport) ?? undefined,
    // #531 — same endpoint contract as the file-backed adapters.
    serverBlockEndpoint(current.server?.transport),
    // #647: env keys the user added (BASTRA_FORWARDER_SPAWN=0, …) survive.
    foreignEnv(current.server?.transport),
  );
  const mcpMatches = codexServerMatches(current.server, target);

  // Preflight file-backed pieces before asking Codex to mutate TOML.
  const skillPlan = await copySkill(
    { dryRun: true },
    { targetDir: CODEX_SKILL_TARGET_DIR },
  );
  const hookPlan = await patchCodexHooks("install", {
    dryRun: true,
    includeStop: opts.withStopHook === true,
    codexVersion,
    mapBin,
    // #537 — the client the install step selected, not a disk probe.
    stubPresent: opts.useStub,
  });
  if (skillPlan.status === "error") return { status: "error", message: `skill: ${skillPlan.detail}`, configPath };
  if (hookPlan.status === "error") return { status: "error", message: `hooks: ${hookPlan.detail}`, configPath };

  const bootstrapPlan = await ensureBootstrap("codex", "install", { ...opts, dryRun: true });
  if (bootstrapPlan.error) return { status: "error", message: bootstrapPlan.detail, configPath };

  // #506 — the `^update_plan$` hook above is dead unless Codex's planning tool
  // is switched on; it ships off by default since Codex rust-v0.152.0.
  const planToolPlan = await ensureCodexPlanTool("install", { dryRun: true, configPath });
  if (planToolPlan.status === "error") return { status: "error", message: `plan tool: ${planToolPlan.detail}`, configPath };

  if (opts.dryRun) {
    const bootstrap = await ensureBootstrap("codex", "install", opts);
    if (bootstrap.error) return { status: "error", message: bootstrap.detail, configPath };
    const lines = [
      runtime.note ? `runtime: ${runtime.note}` : "",
      mcpMatches ? "mcp: already matches" : `mcp: would register '${SERVER_KEY}' through codex mcp`,
      `skill: ${skillPlan.detail}`,
      `hooks: ${hookPlan.detail}`,
      hookPlan.note ?? "",
      `plan tool: ${planToolPlan.detail}`,
      `bootstrap: ${bootstrap.detail}`,
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
    codexVersion,
    mapBin,
    stubPresent: opts.useStub,
  });
  if (skill.status === "error") return { status: "error", message: `skill: ${skill.detail}`, configPath, backupPath: mcpBackup };
  if (hooks.status === "error") return { status: "error", message: `hooks: ${hooks.detail}`, configPath, backupPath: mcpBackup };
  // Written last: `codex mcp add` above re-serializes the same file, so our
  // block goes in after Codex is done with it.
  const planTool = await ensureCodexPlanTool("install", { dryRun: false, configPath });
  if (planTool.status === "error") return { status: "error", message: `plan tool: ${planTool.detail}`, configPath, backupPath: mcpBackup };

  const bootstrap = await ensureBootstrap("codex", "install", opts);
  if (bootstrap.error) return { status: "error", message: bootstrap.detail, configPath };
  const planToolUnchanged = planTool.status !== "enabled";
  const unchanged = mcpMatches && skill.status === "already-installed" && hooks.status === "already-installed" && planToolUnchanged && !bootstrap.changed;
  if (unchanged) {
    return {
      status: "already-installed",
      message: [
        "MCP, Codex/ChatGPT skill and required hooks already match",
        hooks.note ?? "",
        `plan tool: ${planTool.detail}`,
        `bootstrap: ${bootstrap.detail}`,
      ].filter(Boolean).join("\n  · "),
      configPath,
    };
  }
  const lines = [
    runtime.note ? `runtime: ${runtime.note}` : "",
    mcpMatches ? "mcp: already matches" : `mcp: registered '${SERVER_KEY}' through Codex`,
    `skill: ${skill.detail}`,
    `hooks: ${hooks.detail}`,
    hooks.note ?? "",
    `plan tool: ${planTool.detail}`,
    `bootstrap: ${bootstrap.detail}`,
    hooks.status === "installed"
      ? `hook definitions changed — Codex trusts a hook by the hash of its exact command, so re-approve them in Codex with '/hooks' or they stay silent`
      : "review changed hooks in Codex '/hooks'",
    "restart ChatGPT desktop, Codex sessions and the IDE extension",
  ].filter(Boolean);
  return {
    status: "installed",
    message: lines.join("\n  · "),
    configPath,
    backupPath: mcpBackup ?? hooks.backupPath ?? planTool.backupPath,
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
  // #506 — only a plan-tool block we wrote ourselves is rolled back; a value
  // the user set stays.
  const planToolPlan = await ensureCodexPlanTool("uninstall", { dryRun: true, configPath });
  if (planToolPlan.status === "error") return { status: "error", message: `plan tool: ${planToolPlan.detail}`, configPath };
  const bootstrapPlan = await ensureBootstrap("codex", "uninstall", { dryRun: true });
  if (bootstrapPlan.error) return { status: "error", message: bootstrapPlan.detail, configPath };
  if (!bootstrapPlan.changed && !mcpPresent && !skillPresent && hookPlan.status === "not-present" && planToolPlan.status !== "would-remove") {
    return { status: "not-present", message: "no bastra-recall Codex integration present", configPath };
  }
  if (opts.dryRun) {
    return {
      status: "would-remove",
      message: [
        mcpPresent ? `mcp: would remove '${SERVER_KEY}'` : "mcp: not present",
        `hooks: ${hookPlan.detail}`,
        hookPlan.note ?? "",
        skillPresent ? `skill: would remove ${CODEX_SKILL_TARGET_DIR}` : "skill: not present",
        `plan tool: ${planToolPlan.detail}`,
        `bootstrap: ${bootstrapPlan.detail}`,
      ].filter(Boolean).join("\n  · "),
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
  const planTool = await ensureCodexPlanTool("uninstall", { dryRun: false, configPath });
  if (planTool.status === "error") return { status: "error", message: `plan tool: ${planTool.detail}`, configPath, backupPath };
  const bootstrap = await ensureBootstrap("codex", "uninstall", opts);
  if (bootstrap.error) return { status: "error", message: bootstrap.detail, configPath };
  return {
    status: "removed",
    message: [
      mcpPresent ? `mcp: removed '${SERVER_KEY}'` : "mcp: not present",
      `hooks: ${hooks.detail}`,
      hooks.note ?? "",
      skillPresent ? `skill: removed ${CODEX_SKILL_TARGET_DIR}` : "skill: not present",
      `plan tool: ${planTool.detail}`,
      `bootstrap: ${bootstrap.detail}`,
      "restart ChatGPT desktop, Codex CLI sessions and the IDE extension",
    ].filter(Boolean).join("\n  · "),
    configPath,
    backupPath: backupPath ?? hooks.backupPath ?? planTool.backupPath,
  };
}

export function registeredCodexHookFiles(hooks: Record<string, unknown>): Set<string> {
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
        for (const def of codexHookDefinitions(true, CODEX_GATE_MIN_VERSION)) {
          if (slashes(command).includes(`/${fileOf(def.bin)}`) ||
              (command.includes("bastra-hook") && command.includes(` ${def.stubSubcommand}`))) {
            found.add(fileOf(def.bin));
          }
        }
      }
    }
  }
  return found;
}

/**
 * #506 — read-only view of `tools.update_plan.enabled` for doctor. Absent is
 * repairable by re-running the installer; an explicit `false` is the user's own
 * decision, so it is reported but never counted as broken.
 */
async function describePlanTool(): Promise<{ detail: string; broken: boolean }> {
  let source = "";
  if (await fileExists(CODEX_CONFIG)) {
    try {
      source = await readFile(CODEX_CONFIG, "utf8");
    } catch (e) {
      return { detail: `cannot read ${CODEX_CONFIG}: ${(e as Error).message}`, broken: false };
    }
  }
  const { state, managed } = inspectPlanTool(source);
  switch (state) {
    case "enabled":
      return { detail: `${PLAN_TOOL_KEY} = true${managed ? " (set by bastra)" : ""}`, broken: false };
    case "disabled":
      return {
        detail: `${PLAN_TOOL_KEY} = false — your setting; the plan hook lane (^update_plan$) stays silent until you set it to true`,
        broken: false,
      };
    case "unsupported":
      return {
        detail: `${PLAN_TOOL_KEY} has a shape bastra will not edit — set it to true by hand or the plan hook lane stays silent`,
        broken: false,
      };
    default:
      return {
        detail: `MISSING — Codex ships its planning tool off by default, so the plan hook lane (^update_plan$) never fires; re-run 'bastra install codex'`,
        broken: true,
      };
  }
}

/** A shared runner file alone does not prove the write-tool matcher is installed. */
export function codexSaveNoticeRegistered(hooks: Record<string, unknown>): boolean {
  const entries = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
  return entries.some(entry => {
    const group = entry as { matcher?: unknown; hooks?: unknown } | null;
    return group?.matcher === CODEX_SAVE_NOTICE_MATCHER && Array.isArray(group.hooks) && group.hooks.some(handler => {
      const hook = handler as { type?: unknown; command?: unknown } | null;
      return hook?.type === "command" && typeof hook.command === "string" &&
        runsOurHookRunner(hook.command, [fileOf(BASH_FAIL_HOOK_BIN)], CLIENT_MARKER, "bash-fail");
    });
  });
}

async function codexDoctor(): Promise<DoctorResult> {
  const details: Record<string, string> = {};
  details.bootstrap = await describeBootstrap("codex");
  const bin = findCodexExecutable();
  details["codex-executable"] = bin ?? "not found (Codex CLI or ChatGPT desktop required)";
  details["shared-host-config"] = CODEX_CONFIG;
  if (!bin) return { status: "missing", message: "Codex/ChatGPT desktop not detected", details };

  const current = codexMcpGet(bin);
  if (!current.result.ok && !mcpMissing(current.result.detail)) {
    return { status: "broken", message: `cannot inspect Codex MCP config: ${current.result.detail}`, details };
  }
  const codexVersion = codexRuntimeVersion(bin);
  details["codex-version"] = codexVersion ?? "unknown";
  const gateEligible = codexGateSupported(codexVersion);
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
  const skillState = await inspectSkillInstall(SKILL_SOURCE_DIR, CODEX_SKILL_TARGET_DIR);
  details.skill = describeSkillInstall(skillState, CODEX_SKILL_TARGET_DIR);

  let hooksBroken = false;
  let stopHookRegistered = false;
  let saveNoticeRegistered = false;
  const hookRead = await readJsonConfig(CODEX_HOOKS);
  if ("error" in hookRead) {
    details.hooks = hookRead.error;
    hooksBroken = true;
  } else {
    const hooks = hookRead.data.hooks && typeof hookRead.data.hooks === "object" && !Array.isArray(hookRead.data.hooks)
      ? hookRead.data.hooks as Record<string, unknown>
      : {};
    const found = registeredCodexHookFiles(hooks);
    const required = gateEligible ? [...REQUIRED_HOOK_FILES, "gate-hook.js"] : REQUIRED_HOOK_FILES;
    const expectedCount = required.length + 1; // optional Stop
    const missing = required.filter((file) => !found.has(file));
    hooksBroken = missing.length > 0;
    saveNoticeRegistered = codexSaveNoticeRegistered(hooks);
    const gateState = inspectCodexGateRegistration(hooks, codexVersion);
    const gateRegistered = gateState.registered;
    if (gateState.broken) hooksBroken = true;
    const staleGate = gateState.stale;
    details["must-load-gate"] = gateEligible
      ? gateRegistered ? "registered for supported local tool paths (runtime evidence: 0.162.1)" : "MISSING or stale — re-run bastra install codex, then re-trust in /hooks"
      : `preparation only — Codex ${codexVersion ?? "unknown"}; deny verified only on ${CODEX_GATE_MIN_VERSION}; ${staleGate
        ? "STALE gate from another runtime — re-run bastra install codex to remove it and update markers, then re-trust changed hooks in /hooks"
        : "legacy additionalContext hints, no must-load promise"}`;
    stopHookRegistered = found.has("stop-hook.js");
    details.hooks = missing.length > 0
      ? `${found.size}/${expectedCount} registered (missing required: ${missing.join(", ")})`
      : found.has("stop-hook.js")
        ? `${expectedCount}/${expectedCount} registered`
        : `${required.length}/${expectedCount} registered (optional Stop disabled)`;
    details["save-notice-hook"] = saveNoticeRegistered ? "registered" : "MISSING — re-run bastra install codex";
    if (!hooksBroken) details["hook-trust"] = "Codex-owned; new or changed hook definitions require re-trust in '/hooks' (exact hook hash); registration does not prove trust";
  }
  // #506 — the plan hook lane is silent unless Codex's planning tool is on.
  const planTool = await describePlanTool();
  details["plan-tool"] = planTool.detail;
  const probe = await probeDaemon();
  // #531 — the key names the endpoint that was actually probed.
  details[`daemon-at-${probe.endpoint?.label ?? "?"}`] = probe.ok ? `reachable (${probe.detail})` : probe.detail;
  if (!registered) return { status: "missing", message: "MCP not registered with Codex/ChatGPT desktop", details };
  const features = {
    recallHooks: !hooksBroken,
    stopHook: stopHookRegistered,
    skill: skillState.status !== "missing",
    ...mcpEnvFeatures(current.server?.transport, CODEX_CONFIG),
  };
  const broken = forwarderBroken || hooksBroken || planTool.broken || (details.skill === "missing" || details.skill.startsWith("STALE")) ||
    details["vault-path"]?.includes("MISSING") === true || details["vault-path"]?.startsWith("not ") === true;
  if (broken) return { status: "broken", message: "registered but some pieces need repair — re-run 'bastra install codex'", details, features };
  return {
    status: "ok",
    message: saveNoticeRegistered
      ? "MCP + Codex/ChatGPT skill + required hooks registered and healthy"
      : "MCP + Codex/ChatGPT skill + required hooks healthy; save notice missing — re-run 'bastra install codex'",
    details,
    features,
  };
}

export const codexAdapter: Adapter = {
  surface: "codex",
  description: "Codex + ChatGPT Desktop (MCP + Skill + Hooks)",
  configPath: CODEX_CONFIG,
  install: codexInstall,
  uninstall: codexUninstall,
  doctor: codexDoctor,
};

/** Verify the real catch-all runner and version evidence on the hint producers.
 * Trust is Codex-owned and cannot be inferred from registration. */
export function codexGateRegistered(hooks: Record<string, unknown>, version?: string | null): boolean {
  if (!codexGateSupported(version)) return false;
  return [
    ["PreToolUse", "*", "gate-hook.js", "gate"],
    ["SessionStart", "startup|resume|clear|compact|fork", "session-hook.js", "session"],
    ["UserPromptSubmit", undefined, "prompt-hook.js", "prompt"],
  ].every(([event, matcher, file, sub]) => {
    const entries = Array.isArray(hooks[event!]) ? hooks[event!] as unknown[] : [];
    return entries.some(entry => {
      const group = entry as { matcher?: unknown; hooks?: unknown } | null;
      if (!group) return false;
      return group.matcher === matcher && Array.isArray(group.hooks) && group.hooks.some(handler => {
        const command = (handler as {command?: unknown} | null)?.command;
        if (typeof command !== "string") return false;
        const tokens = hookCommandTokens(command).map(token => token.value);
        return runsOurHookRunner(command, [file!], CLIENT_MARKER, sub) &&
          (tokens.includes(CLIENT_MARKER) || tokens.includes("--client=codex")) &&
          (tokens.includes(`BASTRA_CODEX_VERSION=${version}`) || tokens.includes(`--codex-version=${version}`));
      });
    });
  });
}

/** Doctor's read-only policy includes stale hint markers: an old producer can
 * still promise must-load even if someone already removed its gate entry. */
export function inspectCodexGateRegistration(hooks: Record<string, unknown>, version?: string | null): {
  registered: boolean; stale: boolean; broken: boolean;
} {
  const eligible = codexGateSupported(version);
  const registered = codexGateRegistered(hooks, version);
  const hasVersionMarker = HOOK_EVENTS.some(event => {
    const entries = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    return entries.some(entry => isOurHookEntry(entry) &&
      ((entry as {hooks: unknown[]}).hooks).some(handler => {
        const command = (handler as {command?: unknown} | null)?.command;
        return typeof command === "string" && hookCommandTokens(command).some(token => /^(?:BASTRA_CODEX_VERSION=|--codex-version=)/.test(token.value));
      }));
  });
  const stale = !eligible && (registeredCodexHookFiles(hooks).has("gate-hook.js") || hasVersionMarker);
  return {registered, stale, broken: eligible ? !registered : stale};
}
