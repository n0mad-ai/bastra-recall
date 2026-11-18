/**
 * The words `bastra doctor` prints itself, by language.primary (#1602): English
 * is the default and the fallback (byte-identical to before), German complete.
 * The per-surface lines are the ones `bastra install` prints; the lines the
 * notes' own modules produce keep their wording. Text the product writes —
 * never matched against user text.
 */
import { installWordsIn, type InstallWords } from "./install-words.js";
import { VERSION_DRIFT_HINT } from "./helpers.js";

const en = {
  fix: (label: string, message: string) => `  fix: ${label}: ${message}\n`,
  clientMemory: "→ client memory folders\n",
  derivedClaims: "→ derived claims\n",
  codeAwareness: "→ code awareness (experimental)\n",
  graphify: (version: string | null, pin: string) => `  graphify ${version} (pinned ${pin})\n`,
  graphifyUnavailable: (reason: string | null) => `  ⚠ graphify unavailable — ${reason}\n`,
  ownGraphify: (path: string) => `  note: your own Graphify at ${path} is left untouched\n`,
  noGraph: (repo: string) => `  ⚠ ${repo}: no graph yet — run 'bastra code index'\n`,
  built: (warn: boolean, repo: string, builtAt: string | null) =>
    `  ${warn ? "⚠ " : ""}${repo}: built ${builtAt ?? "never"}`,
  builtEnd: (stale: boolean): string => (stale ? " (may be outdated)\n" : "\n"),
  lastError: (error: string) => `    last error: ${error}\n`,
  experimental: (status: string) => `    ${status} (experimental)\n`,
  learnedBridges: "→ learned bridges\n",
  hookBinary: "→ hook binary\n",
  autostart: (warning: string) => `→ autostart\n  ⚠ ${warning}\n\n`,
  version: "→ version\n",
  noDaemon: (version: string) => `  · cli ${version} (no running daemon to compare against)\n\n`,
  bothVersions: (label: string, version: string) => `  ${label}: cli and daemon both ${version}\n\n`,
  versionDrift: (cli: string, daemon: string, hint: string) =>
    `  ⚠ version drift: cli ${cli}, daemon ${daemon} — ${hint}\n\n`,
  driftHint: VERSION_DRIFT_HINT,
};
type DoctorOwnWords = typeof en;
export type DoctorWords = DoctorOwnWords & InstallWords;

const de: DoctorOwnWords = {
  fix: (label, message) => `  Reparatur: ${label}: ${message}\n`,
  clientMemory: "→ Memory-Ordner der Clients\n",
  derivedClaims: "→ abgeleitete Aussagen\n",
  codeAwareness: "→ Code-Wissen (experimentell)\n",
  graphify: (version, pin) => `  graphify ${version} (festgelegt auf ${pin})\n`,
  graphifyUnavailable: (reason) => `  ⚠ graphify nicht verfügbar — ${reason}\n`,
  ownGraphify: (path) => `  Hinweis: dein eigenes Graphify unter ${path} bleibt unangetastet\n`,
  noGraph: (repo) => `  ⚠ ${repo}: noch kein Graph — 'bastra code index' ausführen\n`,
  built: (warn, repo, builtAt) => `  ${warn ? "⚠ " : ""}${repo}: gebaut ${builtAt ?? "nie"}`,
  builtEnd: (stale) => (stale ? " (womöglich veraltet)\n" : "\n"),
  lastError: (error) => `    letzter Fehler: ${error}\n`,
  experimental: (status) => `    ${status} (experimentell)\n`,
  learnedBridges: "→ gelernte Brücken\n",
  hookBinary: "→ Hook-Programm\n",
  autostart: (warning) => `→ Autostart\n  ⚠ ${warning}\n\n`,
  version: "→ Version\n",
  noDaemon: (version) => `  · CLI ${version} (kein laufender Daemon zum Vergleich)\n\n`,
  bothVersions: (label, version) => `  ${label}: CLI und Daemon beide ${version}\n\n`,
  versionDrift: (cli, daemon, hint) => `  ⚠ Versionen weichen ab: CLI ${cli}, Daemon ${daemon} — ${hint}\n\n`,
  driftHint: "KI-Client neu starten, damit der Daemon neu geladen wird",
};

export const DOCTOR_WORDS: Readonly<Record<string, DoctorOwnWords>> = { en, de };
/** The words in `language`, with the install lines; English for an unset or unlisted one. */
export function doctorWordsIn(language: string | undefined): DoctorWords {
  return { ...installWordsIn(language), ...(DOCTOR_WORDS[language ?? "en"] ?? en) };
}
