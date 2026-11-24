/** File-backed MCP entries shared by the Claude and Cursor adapters. */
import { adapterWordsIn } from "../adapter-words.js";
import { SERVER_KEY, atomicWriteJson, backupConfig, getServersBlock, readJsonConfig } from "../helpers.js";
import type { McpServerBlock } from "../helpers.js";
import type { UninstallResult } from "../types.js";

export async function registerJsonMcp(
  configPath: string,
  data: Record<string, unknown>,
  block: McpServerBlock
): Promise<string | undefined> {
  const backup = await backupConfig(configPath);
  data.mcpServers = { ...getServersBlock(data), [SERVER_KEY]: block };
  await atomicWriteJson(configPath, data);
  return backup ?? undefined;
}

export async function unregisterJsonMcp(
  configPath: string,
  dryRun: boolean,
  removedMessage: string,
  language?: string
): Promise<UninstallResult> {
  const text = adapterWordsIn(language);
  const read = await readJsonConfig(configPath, language);
  if ("error" in read) return { status: "error", message: read.error, configPath };
  if (!read.existed) {
    return {
      status: "not-present",
      message: text("config file doesn't exist", "Datei mit der Konfiguration fehlt"),
      configPath,
    };
  }
  const servers = getServersBlock(read.data);
  if (!servers || !(SERVER_KEY in servers)) {
    return {
      status: "not-present",
      message: text(`'${SERVER_KEY}' not registered`, `'${SERVER_KEY}' ist nicht registriert`),
      configPath,
    };
  }
  if (dryRun) {
    return {
      status: "would-remove",
      message: text(`would remove '${SERVER_KEY}' from mcpServers`, `würde '${SERVER_KEY}' aus mcpServers entfernen`),
      configPath,
    };
  }
  const backupPath = await backupConfig(configPath);
  delete servers[SERVER_KEY];
  read.data.mcpServers = servers;
  await atomicWriteJson(configPath, read.data);
  return { status: "removed", message: removedMessage, configPath, backupPath: backupPath ?? undefined };
}
