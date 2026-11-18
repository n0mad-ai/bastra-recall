import { ensureBootstrap, describeBootstrap } from "../bootstrap.js";
import { codexGateSupported, CODEX_GATE_VERIFIED_VERSIONS } from "../../codex-gate-capability.js";
import { clientMcpSurface } from "../doctor-delivery.js";
/**
 * Codex + ChatGPT desktop adapter (#15).
 *
 * Codex CLI, its IDE integration and ChatGPT desktop share ~/.codex on the
 * same host. MCP mutations intentionally go through the official `codex mcp`
 * command (Codex owns TOML serialization); hooks and the cross-client skill
 * use their documented JSON/directory surfaces. All writes are idempotent,
 * preserve foreign entries and back up user configuration before mutation.
 * #1532: what the hook registration looks like (definitions, recognition,
 * merge plan, read-only checks) lives in codex-hooks.ts; this module writes
 * it and re-exports its public functions.
 */
import { copyFile, readFile, rm } from "node:fs/promises";
import { CODEX_CONFIG, CODEX_HOOKS, CODEX_SKILL_TARGET_DIR, SKILL_SOURCE_DIR } from "../paths.js";
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
import { leftAloneNote } from "./command-paths.js";
import {
  HOOK_EVENTS,
  REQUIRED_HOOK_FILES,
  codexHookDefinitions,
  codexSaveNoticeRegistered,
  inspectCodexGateRegistration,
  planCodexHooks,
  registeredCodexHookFiles,
} from "./codex-hooks.js";
import type { Adapter, DoctorResult, InstallOpts, InstallResult, UninstallResult } from "../types.js";

export {
  planCodexHooks,
  registeredCodexHookFiles,
  codexSaveNoticeRegistered,
  codexGateRegistered,
  inspectCodexGateRegistration,
  type CodexHookPlan,
} from "./codex-hooks.js";

type HookStepStatus =
  "installed" | "already-installed" | "would-install" | "removed" | "not-present" | "would-remove" | "error";

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
  }
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
  const hooks =
    data.hooks && typeof data.hooks === "object" && !Array.isArray(data.hooks)
      ? (data.hooks as Record<string, unknown>)
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
    : `gate: preparation only (Codex ${opts.codexVersion ?? "unknown"}); deny verified only on ${CODEX_GATE_VERIFIED_VERSIONS.join(", ")}; legacy additionalContext hints, no must-load promise`;
  const unchanged = HOOK_EVENTS.every(
    (event) => JSON.stringify(plan.before[event]) === JSON.stringify(plan.after[event])
  );
  if (unchanged) {
    return action === "install"
      ? { status: "already-installed", detail: `${sourceDefs.length} Codex hooks already match; ${gateDetail}`, note }
      : { status: "not-present", detail: "no bastra-recall Codex hooks present", note };
  }
  if (opts.dryRun) {
    return action === "install"
      ? {
          status: "would-install",
          detail: `would register ${sourceDefs.length} Codex hooks${plan.stopPreserved ? " (existing Stop hook retained)" : ""}; ${gateDetail}`,
          note,
        }
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
    ? {
        status: "installed",
        detail: `${sourceDefs.length} Codex hooks registered; ${gateDetail}`,
        backupPath: backupPath ?? undefined,
        note,
      }
    : { status: "removed", detail: "bastra-recall Codex hooks removed", backupPath: backupPath ?? undefined, note };
}

function mcpMissing(detail: string): boolean {
  return /No MCP server named/.test(detail);
}

async function replaceMcpRegistration(
  bin: string,
  target: ReturnType<typeof buildServerBlock>,
  existing: boolean
): Promise<{ ok: boolean; detail: string; backupPath?: string }> {
  const backupPath = await backupConfig(CODEX_CONFIG);
  if (existing) {
    const removed = runCaptured(bin, ["mcp", "remove", SERVER_KEY], { timeoutMs: 10_000 });
    if (!removed.ok)
      return {
        ok: false,
        detail: `cannot replace MCP registration: ${removed.detail}`,
        backupPath: backupPath ?? undefined,
      };
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
    { timeoutMs: 15_000 }
  );
  if (added.ok) return { ok: true, detail: `registered '${SERVER_KEY}'`, backupPath: backupPath ?? undefined };

  // Restore the exact pre-install TOML when a replacement failed. If this was
  // a new registration, remove any partial entry best-effort.
  if (backupPath) await copyFile(backupPath, CODEX_CONFIG);
  else runCaptured(bin, ["mcp", "remove", SERVER_KEY], { timeoutMs: 10_000 });
  return {
    ok: false,
    detail: `MCP registration failed and previous config was restored: ${added.detail}`,
    backupPath: backupPath ?? undefined,
  };
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
    foreignEnv(current.server?.transport)
  );
  const mcpMatches = codexServerMatches(current.server, target);

  // Preflight file-backed pieces before asking Codex to mutate TOML.
  const skillPlan = await copySkill({ dryRun: true }, { targetDir: CODEX_SKILL_TARGET_DIR });
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
  if (planToolPlan.status === "error")
    return { status: "error", message: `plan tool: ${planToolPlan.detail}`, configPath };

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
  if (skill.status === "error")
    return { status: "error", message: `skill: ${skill.detail}`, configPath, backupPath: mcpBackup };
  if (hooks.status === "error")
    return { status: "error", message: `hooks: ${hooks.detail}`, configPath, backupPath: mcpBackup };
  // Written last: `codex mcp add` above re-serializes the same file, so our
  // block goes in after Codex is done with it.
  const planTool = await ensureCodexPlanTool("install", { dryRun: false, configPath });
  if (planTool.status === "error")
    return { status: "error", message: `plan tool: ${planTool.detail}`, configPath, backupPath: mcpBackup };

  const bootstrap = await ensureBootstrap("codex", "install", opts);
  if (bootstrap.error) return { status: "error", message: bootstrap.detail, configPath };
  const planToolUnchanged = planTool.status !== "enabled";
  const unchanged =
    mcpMatches &&
    skill.status === "already-installed" &&
    hooks.status === "already-installed" &&
    planToolUnchanged &&
    !bootstrap.changed;
  if (unchanged) {
    return {
      status: "already-installed",
      message: [
        "MCP, Codex/ChatGPT skill and required hooks already match",
        hooks.note ?? "",
        `plan tool: ${planTool.detail}`,
        `bootstrap: ${bootstrap.detail}`,
      ]
        .filter(Boolean)
        .join("\n  · "),
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
  if (planToolPlan.status === "error")
    return { status: "error", message: `plan tool: ${planToolPlan.detail}`, configPath };
  const bootstrapPlan = await ensureBootstrap("codex", "uninstall", { dryRun: true });
  if (bootstrapPlan.error) return { status: "error", message: bootstrapPlan.detail, configPath };
  if (
    !bootstrapPlan.changed &&
    !mcpPresent &&
    !skillPresent &&
    hookPlan.status === "not-present" &&
    planToolPlan.status !== "would-remove"
  ) {
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
      ]
        .filter(Boolean)
        .join("\n  · "),
      configPath,
    };
  }

  let backupPath: string | undefined;
  if (mcpPresent) {
    backupPath = (await backupConfig(configPath)) ?? undefined;
    const removed = runCaptured(bin, ["mcp", "remove", SERVER_KEY], { timeoutMs: 10_000 });
    if (!removed.ok)
      return { status: "error", message: `cannot remove MCP registration: ${removed.detail}`, configPath, backupPath };
  }
  if (skillPresent) await rm(CODEX_SKILL_TARGET_DIR, { recursive: true, force: true });
  const hooks = await patchCodexHooks("uninstall", { dryRun: false });
  if (hooks.status === "error") return { status: "error", message: `hooks: ${hooks.detail}`, configPath, backupPath };
  const planTool = await ensureCodexPlanTool("uninstall", { dryRun: false, configPath });
  if (planTool.status === "error")
    return { status: "error", message: `plan tool: ${planTool.detail}`, configPath, backupPath };
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
    ]
      .filter(Boolean)
      .join("\n  · "),
    configPath,
    backupPath: backupPath ?? hooks.backupPath ?? planTool.backupPath,
  };
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
    details["vault-path"] =
      typeof vault === "string"
        ? `${vault}${(await fileExists(vault)) ? " (exists)" : " (MISSING)"}`
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
    const hooks =
      hookRead.data.hooks && typeof hookRead.data.hooks === "object" && !Array.isArray(hookRead.data.hooks)
        ? (hookRead.data.hooks as Record<string, unknown>)
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
      ? gateRegistered
        ? `registered for supported local tool paths (runtime evidence: ${codexVersion})`
        : "MISSING or stale — re-run bastra install codex, then re-trust in /hooks"
      : `preparation only — Codex ${codexVersion ?? "unknown"}; deny verified only on ${CODEX_GATE_VERIFIED_VERSIONS.join(", ")}; ${
          staleGate
            ? "STALE gate from another runtime — re-run bastra install codex to remove it and update markers, then re-trust changed hooks in /hooks"
            : "legacy additionalContext hints, no must-load promise"
        }`;
    stopHookRegistered = found.has("stop-hook.js");
    details.hooks =
      missing.length > 0
        ? `${found.size}/${expectedCount} registered (missing required: ${missing.join(", ")})`
        : found.has("stop-hook.js")
          ? `${expectedCount}/${expectedCount} registered`
          : `${required.length}/${expectedCount} registered (optional Stop disabled)`;
    details["save-notice-hook"] = saveNoticeRegistered ? "registered" : "MISSING — re-run bastra install codex";
    if (!hooksBroken)
      details["hook-trust"] =
        "Codex-owned; new or changed hook definitions require re-trust in '/hooks' (exact hook hash); registration does not prove trust";
  }
  // #506 — the plan hook lane is silent unless Codex's planning tool is on.
  const planTool = await describePlanTool();
  details["plan-tool"] = planTool.detail;
  const probe = await probeDaemon();
  // #531 — the key names the endpoint that was actually probed.
  details[`daemon-at-${probe.endpoint?.label ?? "?"}`] = probe.ok ? `reachable (${probe.detail})` : probe.detail;
  if (!registered) return { status: "missing", message: "MCP not registered with Codex/ChatGPT desktop", details };
  const transport = current.server?.transport;
  const features = {
    recallHooks: !hooksBroken,
    stopHook: stopHookRegistered,
    skill: skillState.status !== "missing",
    ...mcpEnvFeatures(transport, CODEX_CONFIG),
    rulebookGate: { version: codexVersion, verified: gateEligible },
    mcpSurface: clientMcpSurface(transport),
  };
  const broken =
    forwarderBroken ||
    hooksBroken ||
    planTool.broken ||
    details.skill === "missing" ||
    details.skill.startsWith("STALE") ||
    details["vault-path"]?.includes("MISSING") === true ||
    details["vault-path"]?.startsWith("not ") === true;
  if (broken)
    return {
      status: "broken",
      message: "registered but some pieces need repair — re-run 'bastra install codex'",
      details,
      features,
    };
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
