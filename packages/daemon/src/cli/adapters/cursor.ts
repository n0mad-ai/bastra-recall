import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { CURSOR_CONFIG, CURSOR_RULES_RELATIVE, CURSOR_RULES_SOURCE_PATH } from "../paths.js";
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
import { checkForwarderRegistration, ensureStableForwarder } from "../stable-runtime.js";
import type { Adapter, DoctorResult, InstallOpts, InstallResult, UninstallResult } from "../types.js";

async function cursorInstall(opts: InstallOpts): Promise<InstallResult> {
  const configPath = CURSOR_CONFIG;
  const vault = await resolveVault(opts);
  if ("error" in vault) return { status: "error", message: vault.error, configPath };

  const fwd = await ensureStableForwarder({ dryRun: opts.dryRun });
  const runtimeNote = fwd.note ? `\n  · runtime: ${fwd.note}` : "";
  const block = buildServerBlock(vault.path, fwd.path);
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "error", message: read.error, configPath };

  const data = read.data;
  const servers = getServersBlock(data) ?? {};

  if (blocksMatch(servers[SERVER_KEY], block)) {
    return {
      status: "already-installed",
      message: `'${SERVER_KEY}' already registered with matching forwarder + vault`,
      configPath,
    };
  }
  if (opts.dryRun) {
    return {
      status: "would-install",
      message: `would register '${SERVER_KEY}' (vault=${vault.path}, forwarder=${block.args[0]})${runtimeNote}`,
      configPath,
    };
  }
  const backupPath = await backupConfig(configPath);
  data.mcpServers = { ...servers, [SERVER_KEY]: block };
  await atomicWriteJson(configPath, data);
  return {
    status: "installed",
    // The rules layer cannot be installed from here: Cursor has no global
    // rules file (User Rules live in its settings UI), so the convention layer
    // is per-project by construction — `bastra rules cursor` does that step.
    message:
      `registered '${SERVER_KEY}' — restart Cursor${runtimeNote}\n` +
      "  next: run 'bastra rules cursor' inside a project to add the memory rules\n" +
      "        (Cursor keeps rules per repo, so there is nothing global to install)",
    configPath,
    backupPath: backupPath ?? undefined,
  };
}

async function cursorUninstall(opts: { dryRun: boolean }): Promise<UninstallResult> {
  const configPath = CURSOR_CONFIG;
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
    message: `removed '${SERVER_KEY}' — restart Cursor`,
    configPath,
    backupPath: backupPath ?? undefined,
  };
}

async function cursorDoctor(): Promise<DoctorResult> {
  const configPath = CURSOR_CONFIG;
  const details: Record<string, string> = {};

  const cursorAppDir = resolve(homedir(), ".cursor");
  details["cursor-config-dir"] = (await fileExists(cursorAppDir))
    ? `present (${cursorAppDir})`
    : "not detected (Cursor may not be installed)";

  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "broken", message: read.error, details };
  details["mcp-config"] = read.existed ? "present" : "missing (will be created on install)";

  const servers = getServersBlock(read.data) ?? {};
  const registered = SERVER_KEY in servers;
  details["mcp-registration"] = registered ? "present" : "missing";

  let forwarderBroken = false;
  if (registered) {
    const block = servers[SERVER_KEY] as Record<string, unknown>;
    const args = Array.isArray(block?.args) ? block.args : [];
    const fwd = args[0];
    if (typeof fwd === "string") {
      const check = checkForwarderRegistration(fwd, await fileExists(fwd), "cursor");
      details["forwarder-path"] = check.detail;
      forwarderBroken = check.broken;
    }
    const env = block?.env as Record<string, unknown> | undefined;
    const vault = env?.BASTRA_VAULT_PATH;
    if (typeof vault === "string") {
      details["vault-path"] = (await fileExists(vault)) ? `${vault} (exists)` : `${vault} (MISSING)`;
    }
  }

  const probe = await probeDaemon();
  details["daemon-on-6723"] = probe.ok ? `reachable (${probe.detail})` : probe.detail;

  // #456: the project rule is a generated projection of the skill. Reported
  // for the CURRENT project only — rules live in the repo, not in HOME.
  details["cursor-rule"] = await cursorRuleState(process.cwd());

  if (!registered) return { status: "missing", message: "not registered with Cursor", details };
  const broken =
    forwarderBroken ||
    details["vault-path"]?.includes("MISSING") === true;
  if (broken) return { status: "broken", message: "registered but referenced paths need repair — re-run 'bastra install cursor'", details };
  return { status: "ok", message: "registered (project rule: see cursor-rule below — 'bastra rules cursor' installs or refreshes it)", details };
}

/** `.cursor/rules/bastra-recall.mdc` of one project against the shipped rule. */
export async function cursorRuleState(projectDir: string, sourcePath: string | null = CURSOR_RULES_SOURCE_PATH): Promise<string> {
  const target = resolve(projectDir, CURSOR_RULES_RELATIVE);
  if (!(await fileExists(target))) return `not in this project (${CURSOR_RULES_RELATIVE}) — 'bastra rules cursor' installs it`;
  if (!sourcePath) return "present (shipped rule not found, cannot compare)";
  const [installed, shipped] = await Promise.all([readFile(target, "utf8"), readFile(sourcePath, "utf8")]);
  return installed === shipped
    ? `present, up to date (${CURSOR_RULES_RELATIVE})`
    : `STALE — ${CURSOR_RULES_RELATIVE} differs from the shipped rule; re-run 'bastra rules cursor'`;
}

export const cursorAdapter: Adapter = {
  surface: "cursor",
  description: "Cursor (MCP only)",
  configPath: CURSOR_CONFIG,
  install: cursorInstall,
  uninstall: cursorUninstall,
  doctor: cursorDoctor,
};
