import { CLAUDE_DESKTOP_CONFIG, CLAUDE_DESKTOP_DIR, SKILL_SOURCE_DIR, SKILL_TARGET_DIR } from "../paths.js";
import {
  SERVER_KEY,
  blocksMatch,
  buildServerBlock,
  existingToolSurface,
  serverBlockEndpoint,
  foreignEnv,
  fileExists,
  getServersBlock,
  probeDaemon,
  readJsonConfig,
  resolveVault,
} from "../helpers.js";
import { copySkill, describeSkillInstall, inspectSkillInstall } from "../skill.js";
import { checkForwarderRegistration, ensureStableForwarder } from "../stable-runtime.js";
import { adapterWordsIn } from "../adapter-words.js";
import { registerJsonMcp, unregisterJsonMcp } from "./json-mcp.js";
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
const DESKTOP_MODEL_INSTRUCTIONS =
  "       ┄┄┄\n" +
  "       Memory: I use bastra-recall (local MCP). Begin every conversation by silently\n" +
  "       retrieving context with its recall tool. Before answering anything about my past,\n" +
  "       projects, documents or preferences, search bastra-recall first (recall +\n" +
  "       find_document) — before any other lookup. When I state a durable preference,\n" +
  "       rule, decision or fact worth keeping, save it via save_memory without being\n" +
  "       asked, then confirm in one short line.\n" +
  "       ┄┄┄\n";

const DESKTOP_AUTONOMY_NOTE = {
  en:
    "make Desktop use memory ON ITS OWN (one-time, ~2 min):\n" +
    '    1. Settings → Connectors → bastra-recall → tool access: "Always available"\n' +
    "       (keeps the memory tools and their guidance always in Claude's context)\n" +
    '    2. On the first tool call pick "Allow always" — recall/load/find are read-only\n' +
    '    3. Settings → Profile → personal preferences ("Instructions for Claude") — paste:\n' +
    DESKTOP_MODEL_INSTRUCTIONS +
    "       Full guide: https://github.com/n0mad-ai/bastra-recall/wiki/Claude-Desktop",
  de:
    "Automatisches Erinnern und Speichern in Claude Desktop einrichten (einmalig, ca. 2 Minuten):\n" +
    "    1. Einstellungen → Konnektoren → bastra-recall → Werkzeugzugriff: „Immer verfügbar“\n" +
    "       (hält die Memory-Werkzeuge und ihre Anleitung in Claudes Kontext)\n" +
    "    2. Beim ersten Werkzeugaufruf „Immer erlauben“ wählen. recall, load und find lesen nur.\n" +
    "    3. Einstellungen → Profil → persönliche Einstellungen („Anweisungen für Claude“) — einfügen:\n" +
    DESKTOP_MODEL_INSTRUCTIONS +
    "       Vollständige Anleitung: https://github.com/n0mad-ai/bastra-recall/wiki/Claude-Desktop",
};

async function claudeDesktopInstall(opts: InstallOpts, language?: string): Promise<InstallResult> {
  const text = adapterWordsIn(language);
  const configPath = CLAUDE_DESKTOP_CONFIG;
  const vault = await resolveVault(opts, language);
  if ("error" in vault) return { status: "error", message: vault.error, configPath };

  const fwd = await ensureStableForwarder({ dryRun: opts.dryRun, language });
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

  // Claude Desktop reads skills from the same ~/.claude/skills/ path as
  // Claude Code, so we drop the Skill here too (idempotent). Hooks aren't
  // a Claude Desktop surface yet.
  const skillResult = await copySkill({ dryRun: opts.dryRun, language });
  if (skillResult.status === "error")
    return {
      status: "error",
      message: text(`skill: ${skillResult.detail}`, `Skill: ${skillResult.detail}`),
      configPath,
    };

  if (mcpMatches && skillResult.status === "already-installed") {
    return {
      status: "already-installed",
      message: text(
        "MCP server and skill both already in place\n" +
          "  · autonomy guide (make Desktop recall & save on its own): " +
          "https://github.com/n0mad-ai/bastra-recall/wiki/Claude-Desktop",
        "MCP-Server und Skill sind bereits eingerichtet\n" +
          "  · Anleitung für automatisches Erinnern und Speichern: https://github.com/n0mad-ai/bastra-recall/wiki/Claude-Desktop"
      ),
      configPath,
    };
  }

  if (opts.dryRun) {
    const steps: string[] = [];
    if (fwd.note) steps.push(text(`runtime: ${fwd.note}`, `Laufzeitumgebung: ${fwd.note}`));
    steps.push(
      mcpMatches
        ? text("mcp: already matches", "MCP: Registrierung stimmt bereits überein")
        : text(
            `mcp: would register '${SERVER_KEY}' (vault=${vault.path})`,
            `MCP: würde '${SERVER_KEY}' registrieren (Vault=${vault.path})`
          )
    );
    steps.push(text(`skill: ${skillResult.detail}`, `Skill: ${skillResult.detail}`));
    return { status: "would-install", message: steps.join("\n  · "), configPath };
  }

  const backupPath = mcpMatches ? undefined : await registerJsonMcp(configPath, data, block);

  const lines: string[] = [];
  if (fwd.note) lines.push(text(`runtime: ${fwd.note}`, `Laufzeitumgebung: ${fwd.note}`));
  lines.push(
    mcpMatches
      ? text("mcp: already matches", "MCP: Registrierung stimmt bereits überein")
      : text(`mcp: registered '${SERVER_KEY}'`, `MCP: '${SERVER_KEY}' registriert`)
  );
  lines.push(text(`skill: ${skillResult.detail}`, `Skill: ${skillResult.detail}`));
  lines.push(
    text("restart Claude Desktop to activate", "Starte Claude Desktop neu, um die Einrichtung zu aktivieren.")
  );
  lines.push(text(DESKTOP_AUTONOMY_NOTE.en, DESKTOP_AUTONOMY_NOTE.de));

  return {
    status: "installed",
    message: lines.join("\n  · "),
    configPath,
    backupPath,
  };
}

function claudeDesktopUninstall(opts: { dryRun: boolean }, language?: string): Promise<UninstallResult> {
  const text = adapterWordsIn(language);
  return unregisterJsonMcp(
    CLAUDE_DESKTOP_CONFIG,
    opts.dryRun,
    text(
      `removed '${SERVER_KEY}' — restart Claude Desktop to drop the connection`,
      `'${SERVER_KEY}' entfernt — starte Claude Desktop neu, um die Verbindung zu trennen`
    ),
    language
  );
}

async function claudeDesktopDoctor(language?: string): Promise<DoctorResult> {
  const text = adapterWordsIn(language);
  const configPath = CLAUDE_DESKTOP_CONFIG;
  const details: Record<string, string> = {};

  // 1. Claude Desktop installed? (config dir is platform-specific — see paths.ts)
  details["claude-desktop-app"] = (await fileExists(CLAUDE_DESKTOP_DIR))
    ? text(`installed (${CLAUDE_DESKTOP_DIR} exists)`, `installiert (${CLAUDE_DESKTOP_DIR} vorhanden)`)
    : text("not detected", "nicht gefunden");

  // 2. Config + registration
  const read = await readJsonConfig(configPath, language);
  if ("error" in read) return { status: "broken", message: read.error, details };
  details["config-file"] = read.existed
    ? text("present", "vorhanden")
    : text("missing (created on first Desktop launch)", "fehlt (wird beim ersten Start von Claude Desktop angelegt)");

  const servers = getServersBlock(read.data) ?? {};
  const registered = SERVER_KEY in servers;
  details["mcp-registration"] = registered ? text("present", "vorhanden") : text("missing", "fehlt");

  let forwarderBroken = false;
  let vaultBroken = false;
  if (registered) {
    const block = servers[SERVER_KEY] as Record<string, unknown>;
    const args = Array.isArray(block?.args) ? block.args : [];
    const fwd = args[0];
    if (typeof fwd === "string") {
      const check = checkForwarderRegistration(
        fwd,
        await fileExists(fwd),
        "claude-desktop",
        undefined,
        undefined,
        undefined,
        language
      );
      details["forwarder-path"] = check.detail;
      forwarderBroken = check.broken;
    } else {
      details["forwarder-path"] = text("no path in args[0]", "kein Pfad in args[0]");
      forwarderBroken = true;
    }
    const env = block?.env as Record<string, unknown> | undefined;
    const vault = env?.BASTRA_VAULT_PATH;
    if (typeof vault === "string") {
      const exists = await fileExists(vault);
      vaultBroken = !exists || vault.includes("MISSING") || vault.startsWith("not ");
      details["vault-path"] = exists
        ? text(`${vault} (exists)`, `${vault} (vorhanden)`)
        : text(`${vault} (MISSING)`, `${vault} (FEHLT)`);
    } else {
      details["vault-path"] = text("not set in env", "in der Umgebung nicht gesetzt");
      vaultBroken = true;
    }
  }

  // 3. Skill (shared with Claude Code under ~/.claude/skills/)
  // #456: compared against the shipped bundle, not merely present.
  const skillState = await inspectSkillInstall(SKILL_SOURCE_DIR, SKILL_TARGET_DIR);
  details["skill"] = describeSkillInstall(skillState, SKILL_TARGET_DIR, language);

  // 4. Daemon reachable
  const probe = await probeDaemon(undefined, language);
  // #531: the key names the endpoint that was actually probed. It used to say
  // 6723 unconditionally while the probe went wherever the env pointed.
  details[`daemon-at-${probe.endpoint?.label ?? "?"}`] = probe.ok
    ? text(`reachable (${probe.detail})`, `erreichbar (${probe.detail})`)
    : probe.detail;

  if (!registered)
    return {
      status: "missing",
      message: text("not registered with Claude Desktop", "bei Claude Desktop nicht registriert"),
      details,
    };
  const broken = forwarderBroken || vaultBroken || skillState.status !== "up-to-date";
  if (broken)
    return {
      status: "broken",
      message: text(
        "registered but skill or referenced paths need repair — re-run 'bastra install claude-desktop'",
        "registriert, aber der Skill oder verknüpfte Pfade müssen repariert werden — führe 'bastra install claude-desktop' erneut aus"
      ),
      details,
    };
  return {
    status: "ok",
    message: text("registered with skill, looks healthy", "mit Skill registriert, keine Probleme gefunden"),
    details,
  };
}

export const claudeDesktopAdapter: Adapter = {
  surface: "claude-desktop",
  description: "Claude Desktop App",
  configPath: CLAUDE_DESKTOP_CONFIG,
  install: claudeDesktopInstall,
  uninstall: claudeDesktopUninstall,
  doctor: claudeDesktopDoctor,
};
