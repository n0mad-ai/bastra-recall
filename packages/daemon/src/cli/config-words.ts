/**
 * The words `bastra config` prints around a value, by language.primary
 * (#1602): English is the default and the fallback (byte-identical to
 * before), German complete. The value line of `config get` stays as it is —
 * scripts read it. Text the product writes — never matched against user text.
 */
import { taskCliLanguage } from "./task-cli-words.js";

const en = {
  knownKeys: (keys: string) => `known keys: ${keys}\n`,
  unknownKey: (key: string) => `error: unknown config key '${key}'\n`,
  storedIn: (path: string) => `  stored in ${path}\n`,
  envNote: (name: string, env: string) => `  note: ${name}=${env} (env) overrides this file at runtime\n`,
  envWarning: (name: string, env: string) =>
    `  ⚠ ${name}=${env} (env) is set and OVERRIDES this — unset it for the file to take effect.\n`,
  overrides: (name: string) => `  note: ${name} overrides this setting at runtime\n`,
  mustBeBool: (key: string) => `error: ${key} must be one of: true | false (also on|off)\n`,
  nameMissing: "Give a name; remove it with bastra address remove.\n",
  updateModeOneOf: (modes: string, fallback: string) =>
    `error: update.mode must be one of: ${modes} (default: ${fallback})\n`,
  updateAuto: "  bastra will now stage updates at session start (no restart mid-session).\n",
  providerOneOf: (providers: string) => `error: embedding.provider must be one of: ${providers}\n`,
  restartOnBoot: "  restart the daemon to apply (activates on next boot).\n",
  needsOllama: "  needs Ollama + the embeddinggemma model — run `bastra embeddings on` if not set up.\n",
  docsModeOneOf: (modes: string, fallback: string) =>
    `error: docs.mode must be one of: ${modes} (default: ${fallback})\n`,
  docsLand: (auto: boolean) =>
    `  product docs land in dokumentationen/<project>/ in your vault ` +
    `(${auto ? "written autonomously on feature completion" : "proposed first, written after you agree"}).\n`,
  docsLanguage: "error: docs.language must be a short tag like 'en', 'de', 'pt-br'\n",
  vaultMap: (url: string) => `  vault map: ${url} (or just: bastra map — no daemon restart needed)\n`,
  archiveOn: `  Claude Code's rm -r and lossy git acts now run through bastra's archive and are allowed without a prompt (docs/hooks.md).\n`,
  archiveOff: `  rm -r and the lossy git acts get the plain STOP again.\n`,
  nextBash: `  the next Bash call uses it (no restart needed).\n`,
  nextPrompt: "  the next prompt uses it (no restart needed).\n",
  batteryOn: `  on battery, background paraphrasing waits for AC, model warm-ups are skipped and the model unloads after 60 s idle (macOS).\n`,
  batteryOff: `  background model work runs the same on battery as on AC.\n`,
  restart: `  restart the daemon to apply.\n`,
  coverageOn:
    "  test commands in repositories with code awareness now run with NODE_V8_COVERAGE; the next Bash call uses it (no restart needed).\n",
  coverageOff: "  test commands run untouched again.\n",
  retainFormat: "error: archive.retain is days per class, e.g. junk=1,in-git=2,user=2 (fractions allowed)\n",
  nextReconcile: `  the next hourly reconcile uses it (no restart needed).\n`,
  capFormat: (value: string) =>
    `error: archive.cap is a size above zero, e.g. 5GB or 500MB (units KB, MB, GB, TB) — got '${value}'\n`,
  capNext: `  the next hourly reconcile uses it (no restart needed): over the cap, build junk goes first, then clean git-tracked files.\n`,
  maxItemFormat: (value: string) =>
    `error: archive.max-item is a size above zero, e.g. 2GB or 500MB (units KB, MB, GB, TB), or off for no limit — got '${value}'\n`,
  maxItemOff: "off (no per-target limit)",
  maxItemAny: `  rm archives a target of any size again.\n`,
  maxItemRefuses: `  a larger target is neither archived nor deleted: rm refuses and names /bin/rm and this setting.\n`,
  sizeGuideRange: "error: size.guide must be a line count between 100 and 5000 (default 500)\n",
  sizeGuideNext: `  the PreToolUse hook now flags source files near/over this guide value (no restart needed).\n`,
  languageCode: "error: language.primary must be a 2-letter ISO code like 'de', 'en', 'ru'\n",
  languageNext: `  new memories are now authored in this language (English tech terms kept as anchors, no restart needed).\n`,
  envUpdated: (key: string) => `✓ ${key} updated in daemon.env; restart the daemon to apply\n`,
  envInvalid: (key: string) => `error: invalid or environment-controlled value for ${key}\n`,
  updated: (key: string, restart: boolean) =>
    `✓ ${key} updated${restart ? "; restart the daemon and clients to apply" : ""}\n`,
  invalid: (key: string) => `error: invalid value for ${key}\n`,
};
export type ConfigWords = typeof en;

const de: ConfigWords = {
  knownKeys: (keys) => `bekannte Schlüssel: ${keys}\n`,
  unknownKey: (key) => `Fehler: unbekannter Konfigurationsschlüssel '${key}'\n`,
  storedIn: (path) => `  gespeichert in ${path}\n`,
  envNote: (name, env) => `  Hinweis: ${name}=${env} (Umgebung) hat zur Laufzeit Vorrang vor dieser Datei\n`,
  envWarning: (name, env) =>
    `  ⚠ ${name}=${env} (Umgebung) ist gesetzt und hat VORRANG — entfernen, damit die Datei wirkt.\n`,
  overrides: (name) => `  Hinweis: ${name} hat zur Laufzeit Vorrang vor dieser Einstellung\n`,
  mustBeBool: (key) => `Fehler: ${key} muss einer dieser Werte sein: true | false (auch on|off)\n`,
  nameMissing: "Name angeben; entfernen mit bastra address remove.\n",
  updateModeOneOf: (modes, fallback) =>
    `Fehler: update.mode muss einer dieser Werte sein: ${modes} (Standard: ${fallback})\n`,
  updateAuto:
    "  bastra spielt Updates jetzt beim Sitzungsstart im Hintergrund ein (kein Neustart mitten in der Sitzung).\n",
  providerOneOf: (providers) => `Fehler: embedding.provider muss einer dieser Werte sein: ${providers}\n`,
  restartOnBoot: "  den Daemon neu starten, damit es wirkt (gilt ab dem nächsten Start).\n",
  needsOllama:
    "  braucht Ollama und das Modell embeddinggemma — `bastra embeddings on` ausführen, falls nicht eingerichtet.\n",
  docsModeOneOf: (modes, fallback) =>
    `Fehler: docs.mode muss einer dieser Werte sein: ${modes} (Standard: ${fallback})\n`,
  docsLand: (auto) =>
    `  Produktdokus landen in deinem Vault unter dokumentationen/<projekt>/ ` +
    `(${auto ? "selbstständig geschrieben, wenn ein Feature fertig ist" : "erst vorgeschlagen, nach deiner Zustimmung geschrieben"}).\n`,
  docsLanguage: "Fehler: docs.language muss ein kurzes Kürzel wie 'en', 'de', 'pt-br' sein\n",
  vaultMap: (url) => `  Vault-Karte: ${url} (oder einfach: bastra map — kein Neustart des Daemons nötig)\n`,
  archiveOn:
    "  rm -r und verlustbehaftete git-Befehle von Claude Code laufen jetzt über das Archiv von bastra und sind ohne Rückfrage erlaubt (docs/hooks.md).\n",
  archiveOff: "  rm -r und die verlustbehafteten git-Befehle bekommen wieder das einfache STOP.\n",
  nextBash: "  der nächste Bash-Aufruf nutzt es (kein Neustart nötig).\n",
  nextPrompt: "  der nächste Prompt nutzt es (kein Neustart nötig).\n",
  batteryOn:
    "  im Akkubetrieb wartet das Umformulieren im Hintergrund auf Netzstrom, das Vorwärmen der Modelle entfällt und das Modell wird nach 60 s Leerlauf entladen (macOS).\n",
  batteryOff: "  Modellarbeit im Hintergrund läuft im Akkubetrieb wie am Netz.\n",
  restart: "  den Daemon neu starten, damit es wirkt.\n",
  coverageOn:
    "  Testbefehle in Repositories mit Code-Wissen laufen jetzt mit NODE_V8_COVERAGE; der nächste Bash-Aufruf nutzt es (kein Neustart nötig).\n",
  coverageOff: "  Testbefehle laufen wieder unverändert.\n",
  retainFormat: "Fehler: archive.retain sind Tage je Klasse, z. B. junk=1,in-git=2,user=2 (Bruchteile erlaubt)\n",
  nextReconcile: "  der nächste stündliche Abgleich nutzt es (kein Neustart nötig).\n",
  capFormat: (value) =>
    `Fehler: archive.cap ist eine Größe über null, z. B. 5GB oder 500MB (Einheiten KB, MB, GB, TB) — erhalten: '${value}'\n`,
  capNext:
    "  der nächste stündliche Abgleich nutzt es (kein Neustart nötig): über der Grenze gehen zuerst Build-Reste, dann saubere von git verfolgte Dateien.\n",
  maxItemFormat: (value) =>
    `Fehler: archive.max-item ist eine Größe über null, z. B. 2GB oder 500MB (Einheiten KB, MB, GB, TB), oder off für keine Grenze — erhalten: '${value}'\n`,
  maxItemOff: "off (keine Grenze je Ziel)",
  maxItemAny: "  rm archiviert wieder Ziele jeder Größe.\n",
  maxItemRefuses:
    "  ein größeres Ziel wird weder archiviert noch gelöscht: rm lehnt ab und nennt /bin/rm und diese Einstellung.\n",
  sizeGuideRange: "Fehler: size.guide muss eine Zeilenzahl zwischen 100 und 5000 sein (Standard 500)\n",
  sizeGuideNext:
    "  der PreToolUse-Hook markiert jetzt Quelldateien nahe an oder über diesem Richtwert (kein Neustart nötig).\n",
  languageCode: "Fehler: language.primary muss ein zweistelliger ISO-Code wie 'de', 'en', 'ru' sein\n",
  languageNext:
    "  neue Memories werden jetzt in dieser Sprache verfasst (englische Fachbegriffe bleiben als Anker, kein Neustart nötig).\n",
  envUpdated: (key) => `✓ ${key} in daemon.env geändert; den Daemon neu starten, damit es wirkt\n`,
  envInvalid: (key) => `Fehler: ungültiger oder von der Umgebung gesteuerter Wert für ${key}\n`,
  updated: (key, restart) => `✓ ${key} geändert${restart ? "; Daemon und Clients neu starten, damit es wirkt" : ""}\n`,
  invalid: (key) => `Fehler: ungültiger Wert für ${key}\n`,
};

export const CONFIG_WORDS: Readonly<Record<string, ConfigWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function configWordsIn(language: string | undefined): ConfigWords {
  return CONFIG_WORDS[language ?? "en"] ?? en;
}
/** The words in language.primary, read once per command (English when unset or unreadable). */
export async function configWords(): Promise<ConfigWords> {
  return configWordsIn(await taskCliLanguage().catch(() => "en"));
}
