/**
 * The words `bastra install` and `bastra uninstall` print, by language.primary
 * (#1602): English is the default and the fallback (byte-identical to before),
 * German complete. The adapters' own result messages keep their wording. Text
 * the product writes — never matched against user text.
 */
import { DEFAULT_VAULT_DISPLAY, formatStatus } from "./helpers.js";
import { taskCliLanguage } from "./task-cli-words.js";

const en = {
  /** The status label of an adapter result (helpers' formatStatus in English). */
  status: (status: string): string => formatStatus(status),
  firstRunQuestion: `No memory vault configured yet. Create one at ${DEFAULT_VAULT_DISPLAY}?`,
  wouldPromptVault: `~ would prompt to create ${DEFAULT_VAULT_DISPLAY} (dry-run): no vault configured yet\n\n`,
  couldNotCreateDefault: (error: string) => `✗ could not create ${DEFAULT_VAULT_DISPLAY}: ${error}\n`,
  vaultRequired: (message: string) => `error: ${message}\n`,
  created: (path: string) => `✓ created ${path} — your memories live here as plain markdown files\n\n`,
  wouldCreateVault: (path: string) => `~ would create the vault at ${path} (dry-run): it does not exist yet\n\n`,
  couldNotCreateVault: (path: string, error: string) => `✗ could not create the vault at ${path}: ${error}\n`,
  notCreating: (reason: string) =>
    `⚠ ${reason}.\n  Not creating it: a path from the environment or an earlier registration that is missing is usually an unmounted drive.\n\n`,
  extensionOnlyDesktop: "error: --extension is only available for 'bastra install claude-desktop'\n",
  error: (message: string) => `error: ${message}\n`,
  hookClient: (failed: boolean, detail: string) => `${failed ? "⚠" : "·"} hook client: ${detail}\n\n`,
  config: (path: string) => `  config: ${path}\n`,
  backup: (path: string) => `  backup: ${path}\n`,
  surfaceError: (message: string) => `  error: ${message}\n`,
  addressDryRun: "→ assistant address: would remove only owned hosts/browser/socket entries after system consent\n",
  sharedSkill: "→ skill (shared across Claude surfaces)\n",
  runtime: "→ runtime (pinned npx runtime, ~/.bastra/runtime)\n",
  runtimeRemoved: (label: string) => `  ${label}: no surface registration references it anymore\n\n`,
  ollamaStays:
    "→ semantic recall: Ollama stays configured and its login service may still run.\n" +
    "  Disable recall: bastra embeddings off\n" +
    "  Stop the service: brew services stop ollama\n\n",
};
export type InstallWords = typeof en;

const STATUS_DE: Readonly<Record<string, string>> = {
  installed: "✓ eingerichtet",
  "already-installed": "= schon eingerichtet",
  "would-install": "~ würde einrichten (Probelauf)",
  removed: "✓ entfernt",
  "not-present": "= nicht vorhanden",
  "would-remove": "~ würde entfernen (Probelauf)",
  ok: "✓ ok",
  missing: "✗ fehlt",
  broken: "✗ defekt",
  "not-implemented": "… noch nicht umgesetzt",
  error: "✗ Fehler",
  warn: "! Hinweis",
};

const de: InstallWords = {
  status: (status) => STATUS_DE[status] ?? status,
  firstRunQuestion: `Noch kein Memory-Vault eingerichtet. Einen unter ${DEFAULT_VAULT_DISPLAY} anlegen?`,
  wouldPromptVault: `~ würde fragen, ob ${DEFAULT_VAULT_DISPLAY} angelegt werden soll (Probelauf): noch kein Vault eingerichtet\n\n`,
  couldNotCreateDefault: (error) => `✗ ${DEFAULT_VAULT_DISPLAY} konnte nicht angelegt werden: ${error}\n`,
  vaultRequired: (message) => `Fehler: ${message}\n`,
  created: (path) => `✓ ${path} angelegt — hier liegen deine Memories als einfache Markdown-Dateien\n\n`,
  wouldCreateVault: (path) => `~ würde den Vault unter ${path} anlegen (Probelauf): er existiert noch nicht\n\n`,
  couldNotCreateVault: (path, error) => `✗ der Vault unter ${path} konnte nicht angelegt werden: ${error}\n`,
  notCreating: (reason) =>
    `⚠ ${reason}.\n  Wird nicht angelegt: Fehlt ein Pfad aus der Umgebung oder einer früheren Registrierung, ist meist ein Laufwerk nicht eingebunden.\n\n`,
  extensionOnlyDesktop: "Fehler: --extension gibt es nur für 'bastra install claude-desktop'\n",
  error: (message) => `Fehler: ${message}\n`,
  hookClient: (failed, detail) => `${failed ? "⚠" : "·"} Hook-Client: ${detail}\n\n`,
  config: (path) => `  Konfiguration: ${path}\n`,
  backup: (path) => `  Sicherung: ${path}\n`,
  surfaceError: (message) => `  Fehler: ${message}\n`,
  addressDryRun:
    "→ Assistentenadresse: würde nach Zustimmung des Systems nur eigene Einträge für Hosts, Browser und Socket entfernen\n",
  sharedSkill: "→ Skill (von den Claude-Oberflächen gemeinsam genutzt)\n",
  runtime: "→ Laufzeit (fest verdrahtete npx-Laufzeit, ~/.bastra/runtime)\n",
  runtimeRemoved: (label) => `  ${label}: keine Registrierung einer Oberfläche verweist mehr darauf\n\n`,
  ollamaStays:
    "→ semantischer Recall: Ollama bleibt eingerichtet, sein Anmeldedienst läuft womöglich weiter.\n" +
    "  Recall abschalten: bastra embeddings off\n" +
    "  Dienst stoppen: brew services stop ollama\n\n",
};

export const INSTALL_WORDS: Readonly<Record<string, InstallWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function installWordsIn(language: string | undefined): InstallWords {
  return INSTALL_WORDS[language ?? "en"] ?? en;
}
/** The words in language.primary, read once per command (English when unset or unreadable). */
export async function installWords(): Promise<InstallWords> {
  return installWordsIn(await taskCliLanguage().catch(() => "en"));
}
