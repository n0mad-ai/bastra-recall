/**
 * The words of the status panel (`bastra` without arguments), by
 * language.primary (#1602): English is the default and the fallback
 * (byte-identical to before), German complete. Text the product writes —
 * never matched against user text.
 */
import { taskCliLanguage } from "./task-cli-words.js";

const en = {
  version: "version",
  offline: (cli: string) => `cli ${cli}  (daemon offline — can't check)`,
  available: (latest: string) => `↑ ${latest} available`,
  upToDate: "✓ up to date",
  buildNewer: (running: string, builtAt: string) => `daemon ${running} — build on disk is newer (${builtAt})`,
  processAndDisk: (running: string, onDisk: string) => `daemon ${running} (process), ${onDisk} on disk`,
  replaced: (cli: string) => `cli ${cli}  ⚠ daemon runs replaced code — restart it`,
  drift: (cli: string, hint: string) => `cli ${cli}  ⚠ version drift — ${hint}`,
  daemonStatus: (daemon: string, status: string) => `daemon ${daemon}  ${status}`,
  semantic: "semantic",
  semanticOffer: "off — local Ollama detected, enable: bastra embeddings on",
  running: (label: string) => `✓ running (${label})`,
  notRunning: "✗ not running (auto-spawns on next MCP call)",
  memories: (n: number) => `${n} memories`,
  update: "update",
  mode: (mode: string) => `mode: ${mode}`,
  daemon: "daemon",
  vault: "vault",
  vaultWarning: "vault warning",
  docs: "docs",
  off: "off",
  apiToken: "api token",
  tokenSet: "set (browser/REST enabled)",
  tokenUnset: "not set (loopback only)",
  help: "  bastra help                       all commands\n",
  docsMode: "  bastra config set docs.mode …     off | suggest | auto (product docs)\n",
  updateNow: (latest: string) => `  bastra update                     get ${latest} now\n`,
};
export type PanelWords = typeof en;

const de: PanelWords = {
  version: "Version",
  offline: (cli) => `CLI ${cli}  (Daemon offline — keine Prüfung möglich)`,
  available: (latest) => `↑ ${latest} verfügbar`,
  upToDate: "✓ aktuell",
  buildNewer: (running, builtAt) => `Daemon ${running} — der Build auf der Platte ist neuer (${builtAt})`,
  processAndDisk: (running, onDisk) => `Daemon ${running} (Prozess), ${onDisk} auf der Platte`,
  replaced: (cli) => `CLI ${cli}  ⚠ der Daemon läuft mit ersetztem Code — neu starten`,
  drift: (cli, hint) => `CLI ${cli}  ⚠ Versionen weichen ab — ${hint}`,
  daemonStatus: (daemon, status) => `Daemon ${daemon}  ${status}`,
  semantic: "semantisch",
  semanticOffer: "aus — lokales Ollama erkannt, einschalten: bastra embeddings on",
  running: (label) => `✓ läuft (${label})`,
  notRunning: "✗ läuft nicht (startet beim nächsten MCP-Aufruf von selbst)",
  memories: (n) => `${n} Memories`,
  update: "Update",
  mode: (mode) => `Modus: ${mode}`,
  daemon: "Daemon",
  vault: "Vault",
  vaultWarning: "Vault-Warnung",
  docs: "Dokus",
  off: "aus",
  apiToken: "API-Token",
  tokenSet: "gesetzt (Browser/REST an)",
  tokenUnset: "nicht gesetzt (nur lokal)",
  help: "  bastra help                       alle Befehle\n",
  docsMode: "  bastra config set docs.mode …     off | suggest | auto (Produktdokus)\n",
  updateNow: (latest) => `  bastra update                     ${latest} jetzt holen\n`,
};

export const PANEL_WORDS: Readonly<Record<string, PanelWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function panelWordsIn(language: string | undefined): PanelWords {
  return PANEL_WORDS[language ?? "en"] ?? en;
}
/** The words in language.primary, read once per run (English when unset or unreadable). */
export async function panelWords(): Promise<PanelWords> {
  return panelWordsIn(await taskCliLanguage().catch(() => "en"));
}
