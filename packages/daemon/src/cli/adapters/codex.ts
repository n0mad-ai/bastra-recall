import { ensureBootstrap, describeBootstrap } from "../bootstrap.js";
import { codexGateSupported, CODEX_GATE_VERIFIED_VERSIONS } from "../../codex-gate-capability.js";
import { clientMcpSurface } from "../doctor-delivery.js";
import { sessionStartRegistration } from "../doctor-session-probe.js";
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
import { copyFile, rm } from "node:fs/promises";
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
import { describePlanTool, ensureCodexPlanTool } from "./codex-plan-tool.js";
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
import { adapterWordsIn } from "../adapter-words.js";
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
    language?: string;
    stubPresent?: boolean;
    exists?: (path: string) => Promise<boolean>;
  }
): Promise<{ status: HookStepStatus; detail: string; backupPath?: string; note?: string }> {
  const text = adapterWordsIn(opts.language);
  const hooksPath = opts.hooksPath ?? CODEX_HOOKS;
  const exists = opts.exists ?? fileExists;
  const sourceDefs = codexHookDefinitions(opts.includeStop === true, opts.codexVersion);
  if (action === "install") {
    for (const def of sourceDefs) {
      if (!(await exists(def.bin))) {
        return {
          status: "error",
          detail: text(
            `hook binary missing: ${def.bin} — run 'npm run build'`,
            `Hook-Programm fehlt: ${def.bin} — führe 'npm run build' aus`
          ),
        };
      }
    }
  }

  const read = await readJsonConfig(hooksPath, opts.language);
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
  const note = leftAloneNote(plan.leftAlone, opts.language);
  const shownVersion = opts.codexVersion ?? text("unknown", "unbekannt");
  const gateDetail = codexGateSupported(opts.codexVersion)
    ? text(
        `gate: verified Codex ${opts.codexVersion}; review new/changed definitions in /hooks`,
        `Regelprüfung für Codex ${opts.codexVersion} bestätigt. Prüfe neue oder geänderte Hooks mit /hooks.`
      )
    : text(
        `gate: preparation only (Codex ${shownVersion}); deny verified only on ${CODEX_GATE_VERIFIED_VERSIONS.join(", ")}; legacy additionalContext hints, no must-load promise`,
        `Regelprüfung in Vorbereitung (Codex ${shownVersion}). Sperre nur auf ${CODEX_GATE_VERIFIED_VERSIONS.join(", ")} bestätigt. Auf anderen Versionen gibt additionalContext nur Hinweise.`
      );
  const unchanged = HOOK_EVENTS.every(
    (event) => JSON.stringify(plan.before[event]) === JSON.stringify(plan.after[event])
  );
  if (unchanged) {
    return action === "install"
      ? {
          status: "already-installed",
          detail: text(
            `${sourceDefs.length} Codex hooks already match; ${gateDetail}`,
            `${sourceDefs.length} Codex-Hooks stimmen bereits überein. ${gateDetail}`
          ),
          note,
        }
      : {
          status: "not-present",
          detail: text("no bastra-recall Codex hooks present", "keine bastra-recall-Hooks für Codex vorhanden"),
          note,
        };
  }
  if (opts.dryRun) {
    const stop = plan.stopPreserved
      ? text(" (existing Stop hook retained)", " (bisheriger Stop-Hook bleibt erhalten)")
      : "";
    return action === "install"
      ? {
          status: "would-install",
          detail: text(
            `would register ${sourceDefs.length} Codex hooks${stop}; ${gateDetail}`,
            `würde ${sourceDefs.length} Codex-Hooks registrieren${stop}. ${gateDetail}`
          ),
          note,
        }
      : {
          status: "would-remove",
          detail: text("would remove bastra-recall Codex hooks", "würde bastra-recall-Hooks für Codex entfernen"),
          note,
        };
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
        detail: text(
          `${sourceDefs.length} Codex hooks registered; ${gateDetail}`,
          `${sourceDefs.length} Codex-Hooks registriert. ${gateDetail}`
        ),
        backupPath: backupPath ?? undefined,
        note,
      }
    : {
        status: "removed",
        detail: text("bastra-recall Codex hooks removed", "bastra-recall-Hooks für Codex entfernt"),
        backupPath: backupPath ?? undefined,
        note,
      };
}

function mcpMissing(detail: string): boolean {
  return /No MCP server named/.test(detail);
}

async function replaceMcpRegistration(
  bin: string,
  target: ReturnType<typeof buildServerBlock>,
  existing: boolean,
  language?: string
): Promise<{ ok: boolean; detail: string; backupPath?: string }> {
  const text = adapterWordsIn(language);
  const backupPath = await backupConfig(CODEX_CONFIG);
  if (existing) {
    const removed = runCaptured(bin, ["mcp", "remove", SERVER_KEY], { timeoutMs: 10_000 });
    if (!removed.ok)
      return {
        ok: false,
        detail: text(
          `cannot replace MCP registration: ${removed.detail}`,
          `MCP-Registrierung kann nicht ersetzt werden: ${removed.detail}`
        ),
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
  if (added.ok)
    return {
      ok: true,
      detail: text(`registered '${SERVER_KEY}'`, `'${SERVER_KEY}' registriert`),
      backupPath: backupPath ?? undefined,
    };

  // Restore the exact pre-install TOML when a replacement failed. If this was
  // a new registration, remove any partial entry best-effort.
  if (backupPath) await copyFile(backupPath, CODEX_CONFIG);
  else runCaptured(bin, ["mcp", "remove", SERVER_KEY], { timeoutMs: 10_000 });
  return {
    ok: false,
    detail: text(
      `MCP registration failed and previous config was restored: ${added.detail}`,
      `MCP-Registrierung fehlgeschlagen. Die bisherige Konfiguration wurde wiederhergestellt: ${added.detail}`
    ),
    backupPath: backupPath ?? undefined,
  };
}

async function codexInstall(opts: InstallOpts, language?: string): Promise<InstallResult> {
  const text = adapterWordsIn(language);
  const configPath = CODEX_CONFIG;
  const bin = findCodexExecutable();
  if (!bin)
    return {
      status: "error",
      message: text(
        "Codex/ChatGPT desktop executable not found",
        "Programmdatei von Codex/ChatGPT Desktop nicht gefunden"
      ),
      configPath,
    };
  const codexVersion = codexRuntimeVersion(bin);
  const vault = await resolveVault(opts, language);
  if ("error" in vault) return { status: "error", message: vault.error, configPath };

  const runtime = await ensureStableForwarder({ dryRun: opts.dryRun, language });
  const mapBin = (path: string) => mapBinToStableRuntime(path, runtime);
  const current = codexMcpGet(bin);
  if (!current.result.ok && !mcpMissing(current.result.detail)) {
    return {
      status: "error",
      message: text(
        `cannot inspect Codex MCP config: ${current.result.detail}`,
        `MCP-Konfiguration von Codex kann nicht geprüft werden: ${current.result.detail}`
      ),
      configPath,
    };
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
  const skillPlan = await copySkill({ dryRun: true, language }, { targetDir: CODEX_SKILL_TARGET_DIR });
  const hookPlan = await patchCodexHooks("install", {
    dryRun: true,
    includeStop: opts.withStopHook === true,
    codexVersion,
    mapBin,
    // #537 — the client the install step selected, not a disk probe.
    stubPresent: opts.useStub,
    language,
  });
  if (skillPlan.status === "error")
    return { status: "error", message: text(`skill: ${skillPlan.detail}`, `Skill: ${skillPlan.detail}`), configPath };
  if (hookPlan.status === "error")
    return { status: "error", message: text(`hooks: ${hookPlan.detail}`, `Hooks: ${hookPlan.detail}`), configPath };

  const bootstrapPlan = await ensureBootstrap("codex", "install", { ...opts, dryRun: true, language });
  if (bootstrapPlan.error) return { status: "error", message: bootstrapPlan.detail, configPath };

  // #506 — the `^update_plan$` hook above is dead unless Codex's planning tool
  // is switched on; it ships off by default since Codex rust-v0.152.0.
  const planToolPlan = await ensureCodexPlanTool("install", { dryRun: true, configPath, language });
  if (planToolPlan.status === "error")
    return {
      status: "error",
      message: text(`plan tool: ${planToolPlan.detail}`, `Planungswerkzeug: ${planToolPlan.detail}`),
      configPath,
    };

  if (opts.dryRun) {
    const bootstrap = await ensureBootstrap("codex", "install", { ...opts, language });
    if (bootstrap.error) return { status: "error", message: bootstrap.detail, configPath };
    const lines = [
      runtime.note ? text(`runtime: ${runtime.note}`, `Laufzeitumgebung: ${runtime.note}`) : "",
      mcpMatches
        ? text("mcp: already matches", "MCP: Registrierung stimmt bereits überein")
        : text(
            `mcp: would register '${SERVER_KEY}' through codex mcp`,
            `MCP: würde '${SERVER_KEY}' mit codex mcp registrieren`
          ),
      text(`skill: ${skillPlan.detail}`, `Skill: ${skillPlan.detail}`),
      text(`hooks: ${hookPlan.detail}`, `Hooks: ${hookPlan.detail}`),
      hookPlan.note ?? "",
      text(`plan tool: ${planToolPlan.detail}`, `Planungswerkzeug: ${planToolPlan.detail}`),
      text(`bootstrap: ${bootstrap.detail}`, `Startanweisungen: ${bootstrap.detail}`),
    ].filter(Boolean);
    return { status: "would-install", message: lines.join("\n  · "), configPath };
  }

  let mcpBackup: string | undefined;
  if (!mcpMatches) {
    const changed = await replaceMcpRegistration(bin, target, current.server !== null, language);
    if (!changed.ok) return { status: "error", message: changed.detail, configPath, backupPath: changed.backupPath };
    mcpBackup = changed.backupPath;
  }
  const skill = await copySkill({ dryRun: false, language }, { targetDir: CODEX_SKILL_TARGET_DIR });
  const hooks = await patchCodexHooks("install", {
    dryRun: false,
    includeStop: opts.withStopHook === true,
    codexVersion,
    mapBin,
    stubPresent: opts.useStub,
    language,
  });
  if (skill.status === "error")
    return {
      status: "error",
      message: text(`skill: ${skill.detail}`, `Skill: ${skill.detail}`),
      configPath,
      backupPath: mcpBackup,
    };
  if (hooks.status === "error")
    return {
      status: "error",
      message: text(`hooks: ${hooks.detail}`, `Hooks: ${hooks.detail}`),
      configPath,
      backupPath: mcpBackup,
    };
  // Written last: `codex mcp add` above re-serializes the same file, so our
  // block goes in after Codex is done with it.
  const planTool = await ensureCodexPlanTool("install", { dryRun: false, configPath, language });
  if (planTool.status === "error")
    return {
      status: "error",
      message: text(`plan tool: ${planTool.detail}`, `Planungswerkzeug: ${planTool.detail}`),
      configPath,
      backupPath: mcpBackup,
    };

  const bootstrap = await ensureBootstrap("codex", "install", { ...opts, language });
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
        text(
          "MCP, Codex/ChatGPT skill and required hooks already match",
          "MCP, Skill für Codex/ChatGPT und erforderliche Hooks stimmen bereits überein"
        ),
        hooks.note ?? "",
        text(`plan tool: ${planTool.detail}`, `Planungswerkzeug: ${planTool.detail}`),
        text(`bootstrap: ${bootstrap.detail}`, `Startanweisungen: ${bootstrap.detail}`),
      ]
        .filter(Boolean)
        .join("\n  · "),
      configPath,
    };
  }
  const lines = [
    runtime.note ? text(`runtime: ${runtime.note}`, `Laufzeitumgebung: ${runtime.note}`) : "",
    mcpMatches
      ? text("mcp: already matches", "MCP: Registrierung stimmt bereits überein")
      : text(`mcp: registered '${SERVER_KEY}' through Codex`, `MCP: '${SERVER_KEY}' mit Codex registriert`),
    text(`skill: ${skill.detail}`, `Skill: ${skill.detail}`),
    text(`hooks: ${hooks.detail}`, `Hooks: ${hooks.detail}`),
    hooks.note ?? "",
    text(`plan tool: ${planTool.detail}`, `Planungswerkzeug: ${planTool.detail}`),
    text(`bootstrap: ${bootstrap.detail}`, `Startanweisungen: ${bootstrap.detail}`),
    hooks.status === "installed"
      ? text(
          `hook definitions changed — Codex trusts a hook by the hash of its exact command, so re-approve them in Codex with '/hooks' or they stay silent`,
          `Hook-Definitionen geändert. Codex prüft die Freigabe anhand des exakten Befehls. Bestätige die geänderten Hooks in Codex mit '/hooks', damit sie wieder ausgeführt werden.`
        )
      : text("review changed hooks in Codex '/hooks'", "prüfe geänderte Hooks in Codex mit '/hooks'"),
    text(
      "restart ChatGPT desktop, Codex sessions and the IDE extension",
      "starte ChatGPT Desktop, die Codex-Sitzungen und die IDE-Erweiterung neu"
    ),
  ].filter(Boolean);
  return {
    status: "installed",
    message: lines.join("\n  · "),
    configPath,
    backupPath: mcpBackup ?? hooks.backupPath ?? planTool.backupPath,
  };
}

async function codexUninstall(opts: { dryRun: boolean }, language?: string): Promise<UninstallResult> {
  const text = adapterWordsIn(language);
  const configPath = CODEX_CONFIG;
  const bin = findCodexExecutable();
  if (!bin)
    return {
      status: "error",
      message: text(
        "Codex/ChatGPT desktop executable not found",
        "Programmdatei von Codex/ChatGPT Desktop nicht gefunden"
      ),
      configPath,
    };
  const current = codexMcpGet(bin);
  if (!current.result.ok && !mcpMissing(current.result.detail)) {
    return {
      status: "error",
      message: text(
        `cannot inspect Codex MCP config: ${current.result.detail}`,
        `MCP-Konfiguration von Codex kann nicht geprüft werden: ${current.result.detail}`
      ),
      configPath,
    };
  }
  const mcpPresent = current.server !== null;
  // Preflight must never mutate the hook file. The actual removal happens
  // once below, after the MCP step has succeeded, so its backup and status
  // are reported accurately and a failed MCP removal leaves hooks intact.
  const hookPlan = await patchCodexHooks("uninstall", { dryRun: true, language });
  const skillPresent = await fileExists(CODEX_SKILL_TARGET_DIR);
  if (hookPlan.status === "error")
    return { status: "error", message: text(`hooks: ${hookPlan.detail}`, `Hooks: ${hookPlan.detail}`), configPath };
  // #506 — only a plan-tool block we wrote ourselves is rolled back; a value
  // the user set stays.
  const planToolPlan = await ensureCodexPlanTool("uninstall", { dryRun: true, configPath, language });
  if (planToolPlan.status === "error")
    return {
      status: "error",
      message: text(`plan tool: ${planToolPlan.detail}`, `Planungswerkzeug: ${planToolPlan.detail}`),
      configPath,
    };
  const bootstrapPlan = await ensureBootstrap("codex", "uninstall", { dryRun: true, language });
  if (bootstrapPlan.error) return { status: "error", message: bootstrapPlan.detail, configPath };
  if (
    !bootstrapPlan.changed &&
    !mcpPresent &&
    !skillPresent &&
    hookPlan.status === "not-present" &&
    planToolPlan.status !== "would-remove"
  ) {
    return {
      status: "not-present",
      message: text("no bastra-recall Codex integration present", "keine Codex-Anbindung für bastra-recall vorhanden"),
      configPath,
    };
  }
  if (opts.dryRun) {
    return {
      status: "would-remove",
      message: [
        mcpPresent
          ? text(`mcp: would remove '${SERVER_KEY}'`, `MCP: würde '${SERVER_KEY}' entfernen`)
          : text("mcp: not present", "MCP: nicht vorhanden"),
        text(`hooks: ${hookPlan.detail}`, `Hooks: ${hookPlan.detail}`),
        hookPlan.note ?? "",
        skillPresent
          ? text(`skill: would remove ${CODEX_SKILL_TARGET_DIR}`, `Skill: würde ${CODEX_SKILL_TARGET_DIR} entfernen`)
          : text("skill: not present", "Skill: nicht vorhanden"),
        text(`plan tool: ${planToolPlan.detail}`, `Planungswerkzeug: ${planToolPlan.detail}`),
        text(`bootstrap: ${bootstrapPlan.detail}`, `Startanweisungen: ${bootstrapPlan.detail}`),
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
      return {
        status: "error",
        message: text(
          `cannot remove MCP registration: ${removed.detail}`,
          `MCP-Registrierung kann nicht entfernt werden: ${removed.detail}`
        ),
        configPath,
        backupPath,
      };
  }
  if (skillPresent) await rm(CODEX_SKILL_TARGET_DIR, { recursive: true, force: true });
  const hooks = await patchCodexHooks("uninstall", { dryRun: false, language });
  if (hooks.status === "error")
    return {
      status: "error",
      message: text(`hooks: ${hooks.detail}`, `Hooks: ${hooks.detail}`),
      configPath,
      backupPath,
    };
  const planTool = await ensureCodexPlanTool("uninstall", { dryRun: false, configPath, language });
  if (planTool.status === "error")
    return {
      status: "error",
      message: text(`plan tool: ${planTool.detail}`, `Planungswerkzeug: ${planTool.detail}`),
      configPath,
      backupPath,
    };
  const bootstrap = await ensureBootstrap("codex", "uninstall", { ...opts, language });
  if (bootstrap.error) return { status: "error", message: bootstrap.detail, configPath };
  return {
    status: "removed",
    message: [
      mcpPresent
        ? text(`mcp: removed '${SERVER_KEY}'`, `MCP: '${SERVER_KEY}' entfernt`)
        : text("mcp: not present", "MCP: nicht vorhanden"),
      text(`hooks: ${hooks.detail}`, `Hooks: ${hooks.detail}`),
      hooks.note ?? "",
      skillPresent
        ? text(`skill: removed ${CODEX_SKILL_TARGET_DIR}`, `Skill: ${CODEX_SKILL_TARGET_DIR} entfernt`)
        : text("skill: not present", "Skill: nicht vorhanden"),
      text(`plan tool: ${planTool.detail}`, `Planungswerkzeug: ${planTool.detail}`),
      text(`bootstrap: ${bootstrap.detail}`, `Startanweisungen: ${bootstrap.detail}`),
      text(
        "restart ChatGPT desktop, Codex CLI sessions and the IDE extension",
        "starte ChatGPT Desktop, die Codex-CLI-Sitzungen und die IDE-Erweiterung neu"
      ),
    ]
      .filter(Boolean)
      .join("\n  · "),
    configPath,
    backupPath: backupPath ?? hooks.backupPath ?? planTool.backupPath,
  };
}

async function codexDoctor(language?: string): Promise<DoctorResult> {
  const text = adapterWordsIn(language);
  const details: Record<string, string> = {};
  details.bootstrap = await describeBootstrap("codex", { language });
  const bin = findCodexExecutable();
  details["codex-executable"] =
    bin ??
    text(
      "not found (Codex CLI or ChatGPT desktop required)",
      "nicht gefunden (Codex CLI oder ChatGPT Desktop erforderlich)"
    );
  details["shared-host-config"] = CODEX_CONFIG;
  if (!bin)
    return {
      status: "missing",
      message: text("Codex/ChatGPT desktop not detected", "Codex/ChatGPT Desktop nicht gefunden"),
      details,
    };

  const current = codexMcpGet(bin);
  if (!current.result.ok && !mcpMissing(current.result.detail)) {
    return {
      status: "broken",
      message: text(
        `cannot inspect Codex MCP config: ${current.result.detail}`,
        `MCP-Konfiguration von Codex kann nicht geprüft werden: ${current.result.detail}`
      ),
      details,
    };
  }
  const codexVersion = codexRuntimeVersion(bin);
  const shownVersion = codexVersion ?? text("unknown", "unbekannt");
  details["codex-version"] = shownVersion;
  const gateEligible = codexGateSupported(codexVersion);
  const registered = current.server !== null;
  details["mcp-registration"] = registered
    ? text("present (shared with ChatGPT desktop)", "vorhanden (gemeinsam mit ChatGPT Desktop)")
    : text("missing", "fehlt");
  let forwarderBroken = false;
  let vaultBroken = false;
  if (current.server) {
    const path = current.server.transport.args?.[0];
    if (typeof path === "string") {
      const check = checkForwarderRegistration(
        path,
        await fileExists(path),
        "codex",
        undefined,
        undefined,
        undefined,
        language
      );
      details["forwarder-path"] = check.detail;
      forwarderBroken = check.broken;
    } else {
      details["forwarder-path"] = text("missing from transport args[0]", "fehlt in transport.args[0]");
      forwarderBroken = true;
    }
    const vault = current.server.transport.env?.BASTRA_VAULT_PATH;
    const exists = typeof vault === "string" && (await fileExists(vault));
    vaultBroken = !exists || vault!.includes("MISSING") || vault!.startsWith("not ");
    details["vault-path"] =
      typeof vault === "string"
        ? exists
          ? text(`${vault} (exists)`, `${vault} (vorhanden)`)
          : text(`${vault} (MISSING)`, `${vault} (FEHLT)`)
        : text("not set in env", "in der Umgebung nicht gesetzt");
  }
  // #456: compared against the shipped bundle, not merely present.
  const skillState = await inspectSkillInstall(SKILL_SOURCE_DIR, CODEX_SKILL_TARGET_DIR);
  details.skill = describeSkillInstall(skillState, CODEX_SKILL_TARGET_DIR, language);

  let hooksBroken = false;
  let stopHookRegistered = false;
  let saveNoticeRegistered = false;
  let sessionStart: DoctorResult["sessionStart"];
  const hookRead = await readJsonConfig(CODEX_HOOKS, language);
  if ("error" in hookRead) {
    details.hooks = hookRead.error;
    hooksBroken = true;
  } else {
    const hooks =
      hookRead.data.hooks && typeof hookRead.data.hooks === "object" && !Array.isArray(hookRead.data.hooks)
        ? (hookRead.data.hooks as Record<string, unknown>)
        : {};
    sessionStart = sessionStartRegistration(hooks, "codex");
    const found = registeredCodexHookFiles(hooks);
    const required = gateEligible ? [...REQUIRED_HOOK_FILES, "gate-hook.js"] : REQUIRED_HOOK_FILES;
    const expectedCount = required.length + 1; // optional Stop
    const missing = required.filter((file) => !found.has(file));
    hooksBroken = missing.length > 0;
    saveNoticeRegistered = codexSaveNoticeRegistered(hooks);
    const gateState = inspectCodexGateRegistration(hooks, codexVersion);
    const gateRegistered = gateState.registered;
    if (gateState.broken) hooksBroken = true;
    const staleGate = gateState.stale
      ? text(
          "STALE gate from another runtime — re-run bastra install codex to remove it and update markers, then re-trust changed hooks in /hooks",
          "VERALTETE Regelprüfung einer anderen Version vorhanden. Führe bastra install codex aus, um sie zu entfernen und die Markierungen zu aktualisieren. Bestätige geänderte Hooks mit /hooks."
        )
      : text("legacy additionalContext hints, no must-load promise", "additionalContext gibt nur Hinweise.");
    details["must-load-gate"] = gateEligible
      ? gateRegistered
        ? text(
            `registered for supported local tool paths (runtime evidence: ${codexVersion})`,
            `für unterstützte lokale Werkzeugaufrufe registriert (bestätigte Codex-Version: ${codexVersion})`
          )
        : text(
            "MISSING or stale — re-run bastra install codex, then re-trust in /hooks",
            "FEHLT oder veraltet — führe bastra install codex erneut aus und bestätige den Hook mit /hooks"
          )
      : text(
          `preparation only — Codex ${shownVersion}; deny verified only on ${CODEX_GATE_VERIFIED_VERSIONS.join(", ")}; ${staleGate}`,
          `In Vorbereitung für Codex ${shownVersion}. Sperre nur auf ${CODEX_GATE_VERIFIED_VERSIONS.join(", ")} bestätigt. ${staleGate}`
        );
    stopHookRegistered = found.has("stop-hook.js");
    details.hooks =
      missing.length > 0
        ? text(
            `${found.size}/${expectedCount} registered (missing required: ${missing.join(", ")})`,
            `${found.size}/${expectedCount} registriert (benötigte Hooks fehlen: ${missing.join(", ")})`
          )
        : found.has("stop-hook.js")
          ? text(`${expectedCount}/${expectedCount} registered`, `${expectedCount}/${expectedCount} registriert`)
          : text(
              `${required.length}/${expectedCount} registered (optional Stop disabled)`,
              `${required.length}/${expectedCount} registriert (optionaler Stop-Hook ausgeschaltet)`
            );
    details["save-notice-hook"] = saveNoticeRegistered
      ? text("registered", "registriert")
      : text("MISSING — re-run bastra install codex", "FEHLT — führe bastra install codex erneut aus");
    if (!hooksBroken)
      details["hook-trust"] = text(
        "Codex-owned; new or changed hook definitions require re-trust in '/hooks' (exact hook hash); registration does not prove trust",
        "Codex verwaltet die Freigabe anhand des exakten Hook-Befehls. Bestätige neue oder geänderte Hooks mit '/hooks'. Die Registrierung allein belegt keine Freigabe."
      );
  }
  // #506 — the plan hook lane is silent unless Codex's planning tool is on.
  const planTool = await describePlanTool(language);
  details["plan-tool"] = planTool.detail;
  const probe = await probeDaemon(undefined, language);
  // #531 — the key names the endpoint that was actually probed.
  details[`daemon-at-${probe.endpoint?.label ?? "?"}`] = probe.ok
    ? text(`reachable (${probe.detail})`, `erreichbar (${probe.detail})`)
    : probe.detail;
  if (!registered)
    return {
      status: "missing",
      message: text("MCP not registered with Codex/ChatGPT desktop", "MCP bei Codex/ChatGPT Desktop nicht registriert"),
      details,
    };
  const transport = current.server?.transport;
  const features = {
    recallHooks: !hooksBroken,
    stopHook: stopHookRegistered,
    skill: skillState.status !== "missing",
    ...mcpEnvFeatures(transport, CODEX_CONFIG),
    rulebookGate: { version: codexVersion, verified: gateEligible },
    mcpSurface: clientMcpSurface(transport),
  };
  const broken = forwarderBroken || hooksBroken || planTool.broken || skillState.status !== "up-to-date" || vaultBroken;
  if (broken)
    return {
      status: "broken",
      message: text(
        "registered but some pieces need repair — re-run 'bastra install codex'",
        "registriert, aber Teile der Einrichtung müssen repariert werden — führe 'bastra install codex' erneut aus"
      ),
      details,
      features,
      sessionStart,
    };
  return {
    status: "ok",
    message: saveNoticeRegistered
      ? text(
          "MCP + Codex/ChatGPT skill + required hooks registered and healthy",
          "MCP, Skill für Codex/ChatGPT und erforderliche Hooks sind registriert und funktionieren"
        )
      : text(
          "MCP + Codex/ChatGPT skill + required hooks healthy; save notice missing — re-run 'bastra install codex'",
          "MCP, Skill für Codex/ChatGPT und erforderliche Hooks funktionieren. Der Speicherhinweis fehlt. Führe 'bastra install codex' erneut aus."
        ),
    details,
    features,
    sessionStart,
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
