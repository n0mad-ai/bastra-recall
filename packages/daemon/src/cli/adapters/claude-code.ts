import { ensureBootstrap, describeBootstrap } from "../bootstrap.js";
import { windowsHookToken } from "./command-paths.js";
import { clientMcpSurface } from "../doctor-delivery.js";
import { sessionStartRegistration } from "../doctor-session-probe.js";
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
import { SAVE_NOTICE_MATCHER } from "../../save-notice-lane.js";
import { adapterWordsIn } from "../adapter-words.js";
import { registerJsonMcp } from "./json-mcp.js";
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
export function statuslineCommand(
  bin: string,
  stubPresent: boolean = existsSync(HOOK_STUB_BIN),
  platform: string = process.platform
): string {
  const token = platform === "win32" ? windowsHookToken : (s: string) => s;
  return stubPresent ? `${token(HOOK_STUB_BIN)} statusline --style=powerline` : `node ${token(bin)} --style=powerline`;
}

function buildStatuslineBlock(command: string): Record<string, unknown> {
  return {
    type: "command",
    command,
    refreshInterval: 1,
    __bastraRecall: true,
  };
}

// Only the explicit marker or a complete supported command grants ownership.
// A checkout path alone also matches foreign consumers such as the Ember feed.
export function isOurStatusline(sl: unknown): boolean {
  if (typeof sl !== "object" || sl === null) return false;
  const s = sl as Record<string, unknown>;
  if (s.__bastraRecall === true) return true;
  const cmd = typeof s.command === "string" ? s.command : "";
  const tokens = cmd.match(/"[^"\n]+"|'[^'\n]+'|[^\s]+/g)?.map((t) => t.replace(/^["']|["']$/g, "")) ?? [];
  if (tokens.some((t) => /[;&|`$<>\n]/.test(t))) return false;
  const executable = tokens[0]?.replaceAll("\\", "/").split("/").pop();
  if (/^bastra-hook(?:\.exe)?$/.test(executable ?? "")) {
    return tokens[1] === "statusline" && tokens.slice(2).every((arg) => /^--style=(?:powerline|plain)$/.test(arg));
  }
  if (!/^node(?:\.exe)?$/.test(executable ?? "")) return false;
  if (tokens.slice(2).some((arg) => !/^--style=(?:powerline|plain)$/.test(arg))) return false;
  const script = tokens[1]?.replaceAll("\\", "/") ?? "";
  return /\/statusline\/(?:dist\/index\.mjs|bin\/claude-powerline)$/.test(script);
}

function statuslineMatches(sl: unknown, command: string): boolean {
  if (typeof sl !== "object" || sl === null) return false;
  const s = sl as Record<string, unknown>;
  return s.command === command && s.type === "command";
}

type StatuslineStepStatus =
  | "installed"
  | "already-installed"
  | "would-install"
  | "foreign-kept"
  | "removed"
  | "not-present"
  | "would-remove"
  | "error";

export async function patchClaudeCodeStatusline(
  action: "install" | "uninstall",
  opts: {
    dryRun: boolean;
    force: boolean;
    bin?: string;
    stubPresent?: boolean;
    settingsPath?: string;
    language?: string;
  }
): Promise<{ status: StatuslineStepStatus; detail: string; backupPath?: string }> {
  const text = adapterWordsIn(opts.language);
  // opts.bin: the path to REGISTER (stable-runtime copy when active, #180).
  // Build/existence is still checked against the source STATUSLINE_BIN — the
  // copy mirrors it and may not exist yet under dry-run.
  const settingsPath = opts.settingsPath ?? CLAUDE_CODE_SETTINGS;
  const command = statuslineCommand(opts.bin ?? STATUSLINE_BIN, opts.stubPresent);
  if (action === "install" && !(await fileExists(STATUSLINE_BIN))) {
    return {
      status: "error",
      detail: text(
        `statusline not built: ${STATUSLINE_BIN} — run 'npm run build'`,
        `Statuszeile fehlt: ${STATUSLINE_BIN} — führe 'npm run build' aus`
      ),
    };
  }

  const read = await readJsonConfig(settingsPath, opts.language);
  if ("error" in read) return { status: "error", detail: read.error };
  const data = read.data;
  const existing = data.statusLine;
  const present = existing !== undefined && existing !== null;

  if (action === "install") {
    // A different statusLine is configured → never clobber it without --yes.
    if (present && !isOurStatusline(existing)) {
      if (!opts.force) {
        return {
          status: "foreign-kept",
          detail: text(
            "a different statusLine is configured — kept it (pass --yes to use bastra's)",
            "Die bisherige Statuszeile bleibt aktiv. Mit --yes wechselst du zur Recall-Statuszeile."
          ),
        };
      }
    } else if (statuslineMatches(existing, command)) {
      return {
        status: "already-installed",
        detail: text("bastra statusLine already configured", "Recall-Statuszeile bereits eingerichtet"),
      };
    }

    if (opts.dryRun) {
      const verb = !present
        ? text("would add", "würde hinzufügen:")
        : isOurStatusline(existing)
          ? text("would update", "würde aktualisieren:")
          : text("would replace foreign", "würde ersetzen:");
      return { status: "would-install", detail: `${verb} statusLine → ${command}` };
    }

    if (present && !isOurStatusline(existing)) {
      const previous =
        (existing as Record<string, unknown>).command ?? text("(unknown command)", "(unbekannter Befehl)");
      console.log(text(`replacing foreign statusLine ${previous}`, `Ersetze die bisherige Statuszeile ${previous}`));
    }
    const backupPath = await backupConfig(settingsPath);
    // An update owns the command, but the user owns their refresh cadence.
    // Also preserve an omitted interval (event-driven rendering).
    data.statusLine =
      present && isOurStatusline(existing)
        ? { ...(existing as Record<string, unknown>), type: "command", command, __bastraRecall: true }
        : buildStatuslineBlock(command);
    await atomicWriteJson(settingsPath, data);
    const how = !present
      ? text("powerline, refreshInterval 1s", "Powerline, alle 1 s aktualisieren")
      : isOurStatusline(existing)
        ? text("path updated", "Pfad aktualisiert")
        : text("replaced foreign", "bisherige ersetzt");
    return {
      status: "installed",
      detail: text(`statusLine registered (${how})`, `Statuszeile registriert (${how})`),
      backupPath: backupPath ?? undefined,
    };
  }

  // uninstall — only remove our own statusLine, never a foreign one.
  if (!present || !isOurStatusline(existing)) {
    return {
      status: "not-present",
      detail: present
        ? text("statusLine is not bastra's — kept", "Eigene Statuszeile bleibt erhalten")
        : text("no statusLine present", "keine Statuszeile vorhanden"),
    };
  }
  if (opts.dryRun)
    return {
      status: "would-remove",
      detail: text("would remove bastra statusLine", "würde Recall-Statuszeile entfernen"),
    };

  const backupPath = await backupConfig(settingsPath);
  delete data.statusLine;
  await atomicWriteJson(settingsPath, data);
  return {
    status: "removed",
    detail: text("bastra statusLine removed", "Recall-Statuszeile entfernt"),
    backupPath: backupPath ?? undefined,
  };
}

// ─── Adapter functions ───────────────────────────────────────────

async function claudeCodeInstall(opts: InstallOpts, language?: string): Promise<InstallResult> {
  const text = adapterWordsIn(language);
  const configPath = CLAUDE_CODE_CONFIG;
  const vault = await resolveVault(opts, language);
  if ("error" in vault) return { status: "error", message: vault.error, configPath };

  const fwd = await ensureStableForwarder({ dryRun: opts.dryRun, language });
  // #180: hooks and statusline must survive npx-cache eviction like the
  // forwarder — register the stable-runtime copy of every bin when active.
  // On non-npx installs mapBin is the identity (byte-identical no-op).
  const mapBin = (bin: string) => mapBinToStableRuntime(bin, fwd);
  const read = await readJsonConfig(configPath, language);
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
    foreignEnv(servers[SERVER_KEY])
  );

  const mcpMatches = blocksMatch(servers[SERVER_KEY], block);
  const bootstrapPlan = await ensureBootstrap("claude-code", "install", { ...opts, dryRun: true, language });
  if (bootstrapPlan.error) return { status: "error", message: bootstrapPlan.detail, configPath };
  const skillResult = await copySkill({ dryRun: opts.dryRun, language });
  const hookResult = await patchClaudeCodeHooks("install", {
    dryRun: opts.dryRun,
    includeStop: opts.withStopHook === true,
    mapBin,
    stubPresent: opts.useStub,
    language,
  });
  const statuslineResult = await patchClaudeCodeStatusline("install", {
    dryRun: opts.dryRun,
    force: opts.force === true,
    bin: mapBin(STATUSLINE_BIN),
    stubPresent: opts.useStub,
    language,
  });

  if (skillResult.status === "error")
    return {
      status: "error",
      message: text(`skill: ${skillResult.detail}`, `Skill: ${skillResult.detail}`),
      configPath,
    };
  if (hookResult.status === "error")
    return { status: "error", message: text(`hooks: ${hookResult.detail}`, `Hooks: ${hookResult.detail}`), configPath };
  if (statuslineResult.status === "error")
    return {
      status: "error",
      message: text(`statusline: ${statuslineResult.detail}`, `Statuszeile: ${statuslineResult.detail}`),
      configPath,
    };

  const bootstrap = await ensureBootstrap("claude-code", "install", { ...opts, language });
  if (bootstrap.error) return { status: "error", message: bootstrap.detail, configPath };

  // If everything is already in place: no MCP write, no Skill write, no Hook write.
  // A kept foreign statusLine counts as settled (nothing to write) — we just
  // surface the hint that --yes would switch it to bastra's.
  const statuslineSettled =
    statuslineResult.status === "already-installed" || statuslineResult.status === "foreign-kept";
  const allAlreadyInstalled =
    mcpMatches &&
    skillResult.status === "already-installed" &&
    hookResult.status === "already-installed" &&
    statuslineSettled &&
    !bootstrap.changed;
  if (allAlreadyInstalled) {
    const msg =
      statuslineResult.status === "foreign-kept"
        ? text(
            "MCP, skill, hooks in place; statusLine: foreign one kept (pass --yes to use bastra's)",
            "MCP, Skill und Hooks sind eingerichtet. Die bisherige Statuszeile bleibt aktiv. Mit --yes wechselst du zur Recall-Statuszeile."
          )
        : text(
            "MCP server, skill, hooks, and statusLine all already in place",
            "MCP-Server, Skill, Hooks und Statuszeile sind bereits eingerichtet."
          );
    // #683: an entry that was left alone is named on every run, this one too.
    return {
      status: "already-installed",
      message: [msg, hookResult.note, text(`bootstrap: ${bootstrap.detail}`, `Startanweisungen: ${bootstrap.detail}`)]
        .filter(Boolean)
        .join("\n  · "),
      configPath,
    };
  }

  if (opts.dryRun) {
    const steps: string[] = [];
    if (fwd.note) steps.push(text(`runtime: ${fwd.note}`, `Laufzeitumgebung: ${fwd.note}`));
    if (!mcpMatches)
      steps.push(
        text(
          `mcp: would register '${SERVER_KEY}' in ${configPath}`,
          `MCP: würde '${SERVER_KEY}' in ${configPath} registrieren`
        )
      );
    else steps.push(text("mcp: already matches", "MCP: Registrierung stimmt bereits überein"));
    steps.push(text(`skill: ${skillResult.detail}`, `Skill: ${skillResult.detail}`));
    steps.push(text(`hooks: ${hookResult.detail}`, `Hooks: ${hookResult.detail}`));
    if (hookResult.note) steps.push(hookResult.note);
    steps.push(text(`statusline: ${statuslineResult.detail}`, `Statuszeile: ${statuslineResult.detail}`));
    steps.push(text(`bootstrap: ${bootstrap.detail}`, `Startanweisungen: ${bootstrap.detail}`));
    return { status: "would-install", message: steps.join("\n  · "), configPath };
  }

  // Write MCP block (if changed)
  const backupPath = mcpMatches ? undefined : await registerJsonMcp(configPath, data, block);

  const lines: string[] = [];
  if (fwd.note) lines.push(text(`runtime: ${fwd.note}`, `Laufzeitumgebung: ${fwd.note}`));
  lines.push(
    mcpMatches
      ? text("mcp: already matches", "MCP: Registrierung stimmt bereits überein")
      : text(`mcp: registered '${SERVER_KEY}'`, `MCP: '${SERVER_KEY}' registriert`)
  );
  lines.push(text(`skill: ${skillResult.detail}`, `Skill: ${skillResult.detail}`));
  lines.push(text(`hooks: ${hookResult.detail}`, `Hooks: ${hookResult.detail}`));
  if (hookResult.note) lines.push(hookResult.note);
  lines.push(text(`statusline: ${statuslineResult.detail}`, `Statuszeile: ${statuslineResult.detail}`));
  lines.push(text(`bootstrap: ${bootstrap.detail}`, `Startanweisungen: ${bootstrap.detail}`));
  lines.push(text("restart Claude Code to activate", "Starte Claude Code neu, um die Einrichtung zu aktivieren."));

  return {
    status: "installed",
    message: lines.join("\n  · "),
    configPath,
    backupPath: backupPath ?? statuslineResult.backupPath,
  };
}

async function claudeCodeUninstall(opts: { dryRun: boolean }, language?: string): Promise<UninstallResult> {
  const text = adapterWordsIn(language);
  const configPath = CLAUDE_CODE_CONFIG;
  const read = await readJsonConfig(configPath, language);
  if ("error" in read) return { status: "error", message: read.error, configPath };

  const data = read.data;
  const servers = getServersBlock(data);
  const mcpPresent = !!(servers && SERVER_KEY in servers);

  // Skill is shared with Claude Desktop (~/.claude/skills/bastra-recall).
  // We don't remove it here — Claude Desktop might still need it. Once no
  // surface registration references it, cmdUninstall's final sweep removes
  // it (#181).
  const hookResult = await patchClaudeCodeHooks("uninstall", { dryRun: opts.dryRun, language });
  const statuslineResult = await patchClaudeCodeStatusline("uninstall", {
    dryRun: opts.dryRun,
    force: false,
    language,
  });

  const bootstrap = await ensureBootstrap("claude-code", "uninstall", { ...opts, language });
  if (bootstrap.error) return { status: "error", message: bootstrap.detail, configPath };
  if (
    !bootstrap.changed &&
    !mcpPresent &&
    hookResult.status === "not-present" &&
    statuslineResult.status === "not-present"
  ) {
    return {
      status: "not-present",
      message: text(
        "nothing to remove (skill: shared file — final sweep decides)",
        "nichts zu entfernen (der gemeinsame Skill wird am Ende geprüft)"
      ),
      configPath,
    };
  }

  if (opts.dryRun) {
    const steps: string[] = [];
    steps.push(
      mcpPresent
        ? text(`mcp: would remove '${SERVER_KEY}'`, `MCP: würde '${SERVER_KEY}' entfernen`)
        : text("mcp: not present", "MCP: nicht vorhanden")
    );
    steps.push(text(`hooks: ${hookResult.detail}`, `Hooks: ${hookResult.detail}`));
    if (hookResult.note) steps.push(hookResult.note);
    steps.push(text(`statusline: ${statuslineResult.detail}`, `Statuszeile: ${statuslineResult.detail}`));
    steps.push(text(`bootstrap: ${bootstrap.detail}`, `Startanweisungen: ${bootstrap.detail}`));
    steps.push(text("skill: shared file — final sweep decides", "Skill: gemeinsam genutzt, wird am Ende geprüft"));
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
  lines.push(
    mcpPresent
      ? text(`mcp: removed '${SERVER_KEY}'`, `MCP: '${SERVER_KEY}' entfernt`)
      : text("mcp: not present", "MCP: nicht vorhanden")
  );
  lines.push(text(`hooks: ${hookResult.detail}`, `Hooks: ${hookResult.detail}`));
  if (hookResult.note) lines.push(hookResult.note);
  lines.push(text(`statusline: ${statuslineResult.detail}`, `Statuszeile: ${statuslineResult.detail}`));
  lines.push(text(`bootstrap: ${bootstrap.detail}`, `Startanweisungen: ${bootstrap.detail}`));
  lines.push(text("skill: shared file — final sweep decides", "Skill: gemeinsam genutzt, wird am Ende geprüft"));
  lines.push(
    text("restart Claude Code to drop the connection", "Starte Claude Code neu, um die Verbindung zu trennen.")
  );

  return {
    status: "removed",
    message: lines.join("\n  · "),
    configPath,
    backupPath: backupPath ?? statuslineResult.backupPath,
  };
}

async function claudeCodeDoctor(language?: string): Promise<DoctorResult> {
  const text = adapterWordsIn(language);
  const configPath = CLAUDE_CODE_CONFIG;
  const details: Record<string, string> = {};
  details.bootstrap = await describeBootstrap("claude-code", { language });

  // MCP entry in ~/.claude.json
  const read = await readJsonConfig(configPath, language);
  if ("error" in read) return { status: "broken", message: read.error, details };
  details["claude-json"] = read.existed ? text("present", "vorhanden") : text("missing", "fehlt");
  const servers = getServersBlock(read.data) ?? {};
  const registered = SERVER_KEY in servers;
  details["mcp-registration"] = registered ? text("present", "vorhanden") : text("missing", "fehlt");

  let forwarderBroken = false;
  let vaultMissing = false;
  if (registered) {
    const block = servers[SERVER_KEY] as Record<string, unknown>;
    const args = Array.isArray(block?.args) ? block.args : [];
    const fwd = args[0];
    if (typeof fwd === "string") {
      const check = checkForwarderRegistration(
        fwd,
        await fileExists(fwd),
        "claude-code",
        undefined,
        undefined,
        undefined,
        language
      );
      details["forwarder-path"] = check.detail;
      forwarderBroken = check.broken;
    }
    const env = block?.env as Record<string, unknown> | undefined;
    const vault = env?.BASTRA_VAULT_PATH;
    if (typeof vault === "string") {
      const exists = await fileExists(vault);
      vaultMissing = !exists || vault.includes("MISSING");
      details["vault-path"] = exists
        ? text(`${vault} (exists)`, `${vault} (vorhanden)`)
        : text(`${vault} (MISSING)`, `${vault} (FEHLT)`);
    }
  }

  // Skill — #456: compared against the shipped bundle, not merely present.
  const skillState = await inspectSkillInstall(SKILL_SOURCE_DIR, SKILL_TARGET_DIR);
  details["skill"] = describeSkillInstall(skillState, SKILL_TARGET_DIR, language);

  // Hooks. Stop is optional: some users intentionally disable autonomous
  // save-eval while keeping the rest of the reflex layer active.
  let requiredHooksMissing = false;
  let saveNoticeMissing = false;
  let hookPathBroken = false;
  let stopHookRegistered = false;
  let hooksDisabledBy: string | undefined;
  let sessionStart: DoctorResult["sessionStart"];
  const settingsRead = await readJsonConfig(CLAUDE_CODE_SETTINGS, language);
  if ("error" in settingsRead) {
    details["hooks"] = text(
      `settings.json broken: ${settingsRead.error}`,
      `settings.json fehlerhaft: ${settingsRead.error}`
    );
    requiredHooksMissing = true;
  } else {
    const hooks =
      settingsRead.data.hooks && typeof settingsRead.data.hooks === "object"
        ? (settingsRead.data.hooks as Record<string, unknown>)
        : {};
    const found = registeredHookBins(hooks);
    const registeredCommands = registeredHookCommands(hooks);
    const requiredMissing = REQUIRED_HOOK_FILES.filter((f) => !found.has(f));
    const allMissing = missingRequiredHookRegistrations(hooks);
    const noticeRegistration = `PostToolUse:${SAVE_NOTICE_MATCHER}`;
    saveNoticeMissing = allMissing.includes(noticeRegistration);
    const registrationMissing = allMissing.filter((registration) => registration !== noticeRegistration);
    details["save-notice-hook"] = saveNoticeMissing
      ? text("MISSING — re-run bastra install claude-code", "FEHLT — führe bastra install claude-code erneut aus")
      : text("registered", "registriert");
    const optionalMissing = OUR_HOOK_FILES.filter((f) => !REQUIRED_HOOK_FILES.includes(f)).filter((f) => !found.has(f));
    requiredHooksMissing = requiredMissing.length > 0 || registrationMissing.length > 0;
    stopHookRegistered = found.has("stop-hook.js");
    // Claude Code's own off switch — user file only; a project file can override it.
    if (settingsRead.data.disableAllHooks === true) {
      hooksDisabledBy = `"disableAllHooks": true in ${CLAUDE_CODE_SETTINGS}`;
    } else {
      sessionStart = sessionStartRegistration(hooks, "claude-code");
    }
    details["hooks"] = requiredHooksMissing
      ? text(
          `${found.size}/${OUR_HOOK_FILES.length} lanes registered (missing required: ${[
            ...requiredMissing,
            ...registrationMissing,
          ].join(", ")})`,
          `${found.size}/${OUR_HOOK_FILES.length} Hooks registriert (benötigte Hooks fehlen: ${[...requiredMissing, ...registrationMissing].join(", ")})`
        )
      : optionalMissing.length > 0
        ? text(
            `${found.size}/${OUR_HOOK_FILES.length} registered (optional disabled: ${optionalMissing.join(", ")})`,
            `${found.size}/${OUR_HOOK_FILES.length} registriert (optional ausgeschaltet: ${optionalMissing.join(", ")})`
          )
        : text(
            `${OUR_HOOK_FILES.length}/${OUR_HOOK_FILES.length} registered`,
            `${OUR_HOOK_FILES.length}/${OUR_HOOK_FILES.length} registriert`
          );

    // #650: the archive opt-in (its state is in the features block) acts
    // only on a Bash hook call that carries the Claude Code marker.
    const bashPre = registeredCommands.find(([f]) => f === "bash-pre-hook.js")?.[1];
    if (
      archiveMode(await getArchiveEnabled().catch(() => false)) !== "off" &&
      bashPre !== undefined &&
      !bashPre.includes(CLIENT_MARKER.trim())
    ) {
      details["archive"] = text(
        "opted in, but the Bash hook carries no Claude Code marker, so nothing is rewritten — re-run 'bastra install claude-code'",
        "eingeschaltet, aber am Bash-Hook fehlt die Claude-Code-Markierung. Führe 'bastra install claude-code' erneut aus, damit die Archivierung die Befehle anpassen kann."
      );
    }

    const hookPathProblems = await checkHookPaths(registeredCommands, { language });
    hookPathBroken = hookPathProblems.length > 0;
    if (hookPathBroken) details["hook-paths"] = hookPathProblems.join("; ");

    // Statusline (optional/cosmetic — never marks the surface as broken).
    const sl = settingsRead.data.statusLine;
    details["statusline"] =
      sl === undefined || sl === null
        ? text("missing (run 'bastra install' to add it)", "fehlt (mit 'bastra install' einrichten)")
        : isOurStatusline(sl)
          ? text("present (bastra)", "vorhanden (bastra)")
          : text(
              `present (foreign: ${(sl as Record<string, unknown>).command ?? "unknown command"})`,
              `vorhanden (eigener Befehl: ${(sl as Record<string, unknown>).command ?? "unbekannt"})`
            );
  }

  // Daemon
  const probe = await probeDaemon(undefined, language);
  // #531: the key names the endpoint that was actually probed. It used to say
  // 6723 unconditionally while the probe went wherever the env pointed.
  details[`daemon-at-${probe.endpoint?.label ?? "?"}`] = probe.ok
    ? text(`reachable (${probe.detail})`, `erreichbar (${probe.detail})`)
    : probe.detail;

  if (!registered)
    return {
      status: "missing",
      message: text("MCP not registered with Claude Code", "MCP bei Claude Code nicht registriert"),
      details,
    };
  const features = {
    recallHooks: !requiredHooksMissing,
    stopHook: stopHookRegistered,
    skill: skillState.status !== "missing",
    ...(hooksDisabledBy ? { hooksDisabledBy } : {}),
    ...mcpEnvFeatures(servers[SERVER_KEY], configPath),
    mcpSurface: clientMcpSurface(servers[SERVER_KEY]),
  };
  const broken =
    forwarderBroken || vaultMissing || requiredHooksMissing || hookPathBroken || skillState.status !== "up-to-date";
  if (broken)
    return {
      status: "broken",
      message: text(
        "registered but some pieces need repair — re-run 'bastra install claude-code'",
        "registriert, aber Teile der Einrichtung müssen repariert werden — führe 'bastra install claude-code' erneut aus"
      ),
      details,
      features,
      sessionStart,
    };
  return {
    status: "ok",
    message: saveNoticeMissing
      ? text(
          "MCP + skill + required recall hooks healthy; save notice missing — re-run 'bastra install claude-code'",
          "MCP, Skill und erforderliche Recall-Hooks funktionieren. Der Speicherhinweis fehlt. Führe 'bastra install claude-code' erneut aus."
        )
      : text(
          "MCP + skill + required hooks registered and healthy",
          "MCP, Skill und erforderliche Hooks sind registriert und funktionieren"
        ),
    details,
    features,
    sessionStart,
  };
}

export const claudeCodeAdapter: Adapter = {
  surface: "claude-code",
  description: "Claude Code (MCP + Skill + Hooks)",
  configPath: CLAUDE_CODE_CONFIG,
  install: claudeCodeInstall,
  uninstall: claudeCodeUninstall,
  doctor: claudeCodeDoctor,
};
