/**
 * The words `bastra install claude-desktop --extension` prints, by
 * language.primary (#1602): English is the default and the fallback
 * (byte-identical to before), German complete. The skill and adapter results
 * it passes through keep their own wording. Text the product writes — never
 * matched against user text.
 */
import { taskCliLanguage } from "./task-cli-words.js";

const en = {
  checksumMismatch: "✗ checksum mismatch for the downloaded bundle — discarding it\n",
  checksumVerified: "  · checksum verified (sha256)\n",
  noChecksum: "  · no published checksum for this asset — skipping verification\n",
  macOnly: "error: the Desktop Extension install is macOS-only for now\n",
  dryRun: (version: string) =>
    `~ would install the skill, locate bastra-recall-${version}.mcpb (local build → release asset → ` +
    `latest release), offer to remove an existing config registration, and open the bundle in ` +
    `Claude Desktop (dry-run)\n`,
  skillFailed: (detail: string) => `✗ skill: ${detail}\n`,
  skill: (detail: string) => `  · skill: ${detail}\n`,
  localBuild: (path: string) => `  · extension: using local build ${path}\n`,
  downloading: (version: string) => `  · extension: downloading v${version} from GitHub releases…\n`,
  fallback: (version: string) => `  · v${version} asset not found — falling back to the latest release bundle\n`,
  noBundle:
    "✗ could not fetch a .mcpb bundle from GitHub releases — build one locally with\n" +
    "  `npm run build:mcpb:local --workspace=@bastra-recall/daemon` and re-run, or use the\n" +
    "  config install instead: bastra install claude-desktop\n",
  removeQuestion: "Remove the existing config-file registration (avoids duplicate tools)?",
  configRegistration: (message: string) => `  · config registration: ${message}\n`,
  keeping:
    "  · keeping the config-file registration — expect the tools twice until you remove one\n" +
    "    (bastra uninstall claude-desktop)\n",
  handed: (path: string, wiki: string) =>
    `✓ handed ${path} to Claude Desktop\n` +
    `  Click "Install" in the Desktop dialog and pick your vault folder.\n` +
    `  Then make Desktop use memory on its own (2 min): ` +
    `${wiki}\n`,
};
export type ExtensionWords = typeof en;

const de: ExtensionWords = {
  checksumMismatch: "✗ Prüfsumme des heruntergeladenen Pakets stimmt nicht — es wird verworfen\n",
  checksumVerified: "  · Prüfsumme bestätigt (sha256)\n",
  noChecksum: "  · keine veröffentlichte Prüfsumme für diese Datei — Prüfung entfällt\n",
  macOnly: "Fehler: die Desktop-Erweiterung lässt sich vorerst nur unter macOS installieren\n",
  dryRun: (version) =>
    `~ würde den Skill installieren, bastra-recall-${version}.mcpb suchen (lokaler Build → Release-Datei → ` +
    `neuestes Release), anbieten, eine vorhandene Konfigurationsregistrierung zu entfernen, und das Paket in ` +
    `Claude Desktop öffnen (Probelauf)\n`,
  skillFailed: (detail) => `✗ Skill: ${detail}\n`,
  skill: (detail) => `  · Skill: ${detail}\n`,
  localBuild: (path) => `  · Erweiterung: nutze den lokalen Build ${path}\n`,
  downloading: (version) => `  · Erweiterung: lade v${version} aus den GitHub-Releases…\n`,
  fallback: (version) => `  · Datei für v${version} nicht gefunden — nutze das Paket des neuesten Release\n`,
  noBundle:
    "✗ kein .mcpb-Paket aus den GitHub-Releases erhältlich — lokal bauen mit\n" +
    "  `npm run build:mcpb:local --workspace=@bastra-recall/daemon` und erneut ausführen, oder stattdessen\n" +
    "  die Konfigurationsinstallation nutzen: bastra install claude-desktop\n",
  removeQuestion: "Die vorhandene Registrierung in der Konfigurationsdatei entfernen (vermeidet doppelte Werkzeuge)?",
  configRegistration: (message) => `  · Konfigurationsregistrierung: ${message}\n`,
  keeping:
    "  · die Registrierung in der Konfigurationsdatei bleibt — die Werkzeuge erscheinen doppelt, bis du eine entfernst\n" +
    "    (bastra uninstall claude-desktop)\n",
  handed: (path, wiki) =>
    `✓ ${path} an Claude Desktop übergeben\n` +
    `  Im Desktop-Dialog auf „Install“ klicken und deinen Vault-Ordner wählen.\n` +
    `  Danach Desktop dazu bringen, das Gedächtnis von selbst zu nutzen (2 Min.): ${wiki}\n`,
};

export const EXTENSION_WORDS: Readonly<Record<string, ExtensionWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function extensionWordsIn(language: string | undefined): ExtensionWords {
  return EXTENSION_WORDS[language ?? "en"] ?? en;
}
/** The words in language.primary, read once per command (English when unset or unreadable). */
export async function extensionWords(): Promise<ExtensionWords> {
  return extensionWordsIn(await taskCliLanguage().catch(() => "en"));
}
