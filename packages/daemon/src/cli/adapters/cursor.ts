import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { CURSOR_CONFIG, CURSOR_RULES_RELATIVE, CURSOR_RULES_SOURCE_PATH } from "../paths.js";
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
import { checkForwarderRegistration, ensureStableForwarder } from "../stable-runtime.js";
import { adapterWordsIn } from "../adapter-words.js";
import { registerJsonMcp, unregisterJsonMcp } from "./json-mcp.js";
import type { Adapter, DoctorResult, InstallOpts, InstallResult, UninstallResult } from "../types.js";

async function cursorInstall(opts: InstallOpts, language?: string): Promise<InstallResult> {
  const text = adapterWordsIn(language);
  const configPath = CURSOR_CONFIG;
  const vault = await resolveVault(opts, language);
  if ("error" in vault) return { status: "error", message: vault.error, configPath };

  const fwd = await ensureStableForwarder({ dryRun: opts.dryRun, language });
  const runtimeNote = fwd.note ? text(`\n  · runtime: ${fwd.note}`, `\n  · Laufzeitumgebung: ${fwd.note}`) : "";
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

  if (blocksMatch(servers[SERVER_KEY], block)) {
    return {
      status: "already-installed",
      message: text(
        `'${SERVER_KEY}' already registered with matching forwarder + vault`,
        `'${SERVER_KEY}' ist mit passendem Forwarder und Vault bereits registriert`
      ),
      configPath,
    };
  }
  if (opts.dryRun) {
    return {
      status: "would-install",
      message: text(
        `would register '${SERVER_KEY}' (vault=${vault.path}, forwarder=${block.args[0]})${runtimeNote}`,
        `würde '${SERVER_KEY}' registrieren (Vault=${vault.path}, Forwarder=${block.args[0]})${runtimeNote}`
      ),
      configPath,
    };
  }
  const backupPath = await registerJsonMcp(configPath, data, block);
  return {
    status: "installed",
    // The rules layer cannot be installed from here: Cursor has no global
    // rules file (User Rules live in its settings UI), so the convention layer
    // is per-project by construction — `bastra rules cursor` does that step.
    message: text(
      `registered '${SERVER_KEY}' — restart Cursor${runtimeNote}\n` +
        "  next: run 'bastra rules cursor' inside a project to add the memory rules\n" +
        "        (Cursor keeps rules per repo, so there is nothing global to install)",
      `'${SERVER_KEY}' registriert — starte Cursor neu${runtimeNote}\n` +
        "  Füge die Memory-Regeln mit 'bastra rules cursor' im Projektordner hinzu.\n" +
        "        Cursor speichert die Regeln pro Projekt."
    ),
    configPath,
    backupPath,
  };
}

function cursorUninstall(opts: { dryRun: boolean }, language?: string): Promise<UninstallResult> {
  const text = adapterWordsIn(language);
  return unregisterJsonMcp(
    CURSOR_CONFIG,
    opts.dryRun,
    text(`removed '${SERVER_KEY}' — restart Cursor`, `'${SERVER_KEY}' entfernt — starte Cursor neu`),
    language
  );
}

async function cursorDoctor(language?: string): Promise<DoctorResult> {
  const text = adapterWordsIn(language);
  const configPath = CURSOR_CONFIG;
  const details: Record<string, string> = {};

  const cursorAppDir = resolve(homedir(), ".cursor");
  details["cursor-config-dir"] = (await fileExists(cursorAppDir))
    ? text(`present (${cursorAppDir})`, `vorhanden (${cursorAppDir})`)
    : text(
        "not detected (Cursor may not be installed)",
        "nicht gefunden (Cursor ist möglicherweise nicht installiert)"
      );

  const read = await readJsonConfig(configPath, language);
  if ("error" in read) return { status: "broken", message: read.error, details };
  details["mcp-config"] = read.existed
    ? text("present", "vorhanden")
    : text("missing (will be created on install)", "fehlt (wird bei der Einrichtung angelegt)");

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
        "cursor",
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
      details["vault-path"] = !exists
        ? text(`${vault} (MISSING)`, `${vault} (FEHLT)`)
        : text(`${vault} (exists)`, `${vault} (vorhanden)`);
    }
  }

  const probe = await probeDaemon(undefined, language);
  // #531: the key names the endpoint that was actually probed. It used to say
  // 6723 unconditionally while the probe went wherever the env pointed.
  details[`daemon-at-${probe.endpoint?.label ?? "?"}`] = probe.ok
    ? text(`reachable (${probe.detail})`, `erreichbar (${probe.detail})`)
    : probe.detail;

  // #456: the project rule is a generated projection of the skill. Reported
  // for the CURRENT project only — rules live in the repo, not in HOME.
  details["cursor-rule"] = await cursorRuleState(process.cwd(), CURSOR_RULES_SOURCE_PATH, language);

  if (!registered)
    return { status: "missing", message: text("not registered with Cursor", "bei Cursor nicht registriert"), details };
  const broken = forwarderBroken || vaultMissing;
  if (broken)
    return {
      status: "broken",
      message: text(
        "registered but referenced paths need repair — re-run 'bastra install cursor'",
        "registriert, aber einige Pfade müssen repariert werden — führe 'bastra install cursor' erneut aus"
      ),
      details,
    };
  return {
    status: "ok",
    message: text(
      "registered (project rule: see cursor-rule below — 'bastra rules cursor' installs or refreshes it)",
      "registriert (siehe Cursor-Projektregel. 'bastra rules cursor' installiert oder aktualisiert sie.)"
    ),
    details,
  };
}

/** `.cursor/rules/bastra-recall.mdc` of one project against the shipped rule. */
export async function cursorRuleState(
  projectDir: string,
  sourcePath: string | null = CURSOR_RULES_SOURCE_PATH,
  language?: string
): Promise<string> {
  const text = adapterWordsIn(language);
  const target = resolve(projectDir, CURSOR_RULES_RELATIVE);
  if (!(await fileExists(target)))
    return text(
      `not in this project (${CURSOR_RULES_RELATIVE}) — 'bastra rules cursor' installs it`,
      `fehlt in diesem Projekt (${CURSOR_RULES_RELATIVE}). 'bastra rules cursor' installiert die Regel.`
    );
  if (!sourcePath)
    return text(
      "present (shipped rule not found, cannot compare)",
      "vorhanden (Vergleich fehlgeschlagen, weil die mitgelieferte Regel fehlt)"
    );
  const [installed, shipped] = await Promise.all([readFile(target, "utf8"), readFile(sourcePath, "utf8")]);
  return installed === shipped
    ? text(`present, up to date (${CURSOR_RULES_RELATIVE})`, `vorhanden und aktuell (${CURSOR_RULES_RELATIVE})`)
    : text(
        `STALE — ${CURSOR_RULES_RELATIVE} differs from the shipped rule; re-run 'bastra rules cursor'`,
        `VERALTET: ${CURSOR_RULES_RELATIVE} weicht von der mitgelieferten Regel ab. Führe 'bastra rules cursor' erneut aus.`
      );
}

export const cursorAdapter: Adapter = {
  surface: "cursor",
  description: "Cursor (MCP only)",
  configPath: CURSOR_CONFIG,
  install: cursorInstall,
  uninstall: cursorUninstall,
  doctor: cursorDoctor,
};
