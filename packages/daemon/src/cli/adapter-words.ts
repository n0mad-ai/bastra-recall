/** Adapter output is localised at its source. Paths and external diagnostics
 * are interpolated verbatim. Callers producing script output omit language. */
export function adapterWordsIn(language: string | undefined): (english: string, german: string) => string {
  return language === "de" ? (_english, german) => german : (english) => english;
}

export function adapterDisplayLanguage(language: string, json?: boolean): string | undefined {
  return json ? undefined : language;
}

const detailLabelsDe: Record<string, string> = {
  archive: "Archivierung",
  bootstrap: "Startanweisungen",
  "claude-desktop-app": "Claude Desktop App",
  "codex-executable": "Codex-Programmdatei",
  "codex-version": "Codex-Version",
  "config-file": "Konfigurationsdatei",
  "cursor-config-dir": "Cursor-Konfigurationsordner",
  "cursor-rule": "Cursor-Projektregel",
  "forwarder-path": "Forwarder-Pfad",
  "hook-paths": "Hook-Pfade",
  "hook-trust": "Hook-Freigabe",
  "mcp-config": "MCP-Konfiguration",
  "mcp-registration": "MCP-Registrierung",
  "must-load-gate": "Regelprüfung",
  "plan-tool": "Planungswerkzeug",
  "save-notice-hook": "Hook für Speicherhinweise",
  "shared-host-config": "Gemeinsame Client-Konfiguration",
  statusline: "Statuszeile",
  "vault-path": "Vault-Pfad",
};

export function adapterDetailLabel(key: string, language?: string): string {
  if (language !== "de") return key;
  const endpointPrefix = "daemon-at-";
  if (key.startsWith(endpointPrefix)) return `Daemon unter ${key.slice(endpointPrefix.length)}`;
  return Object.hasOwn(detailLabelsDe, key) ? detailLabelsDe[key] : key;
}
