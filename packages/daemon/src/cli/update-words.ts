/**
 * The words `bastra update` prints itself, by language.primary (#1602): English
 * is the default and the fallback (byte-identical to before), German complete.
 * Lines produced by the modules it drives (preflight, source build, patch
 * report, hook binary check) keep their own wording, and the refusal recorded
 * for the next session stays English. Text the product writes — never matched
 * against user text.
 */
import { taskCliLanguage } from "./task-cli-words.js";

const patches = (n: number) => `${n} local patch${n === 1 ? "" : "es"}`;
const patchesDe = (n: number) => `${n} lokale${n === 1 ? "r Patch" : " Patches"}`;

const en = {
  /** `detail` is detectInstallMode's own English wording. */
  modeDetail: (_mode: string, detail: string, _wrapper: string | null) => detail,
  handingOff: (bin: string) => [
    `  → handing the re-registration to ${bin}\n`,
    "    (registration must use the newly installed CLI, not this old process)\n\n",
  ],
  verifyingSource: "→ source checkout — verifying the build (nothing is pulled, installed or built here)\n",
  leftAlone: "  Nothing was re-registered and the daemon was left alone.\n",
  buildTogether: "  Build the daemon and hook together: npm run build:deploy\n",
  kegNotFound: (n: number) =>
    `⚠ ${patches(n)} not reapplied: the installed keg could not be located ('brew --prefix bastra-recall' failed)\n\n`,
  reapplying: (n: number) => `→ reapplying ${patches(n)} (#269)\n`,
  setAside:
    `  Patches set aside stay registered — 'bastra patches status' shows them,\n` +
    `  and the pre-update backup above still holds your files.\n`,
  reapplyFailed: (message: string) => `  ⚠ patch reapply failed (${message}) — the update itself stands\n\n`,
  npmFailed: (detail: string, manual: string) =>
    `\n✗ npm install failed (${detail})\n  Update by hand:\n    ${manual}\n`,
  npmWrapperHint: (cli: string) =>
    `  If you installed with 'npm install -g ${cli}', update with this instead:\n` +
    `    npm install -g ${cli}@latest\n`,
  npmAgain: `  Then run 'bastra update' again.\n`,
  /** `refusal` is the English line recorded for the next session; `reason` names the Node.js gap. */
  nodeRefused: (refusal: string, _reason: string) =>
    `✗ ${refusal}\n  Nothing was installed — the current version is untouched.\n`,
  stopped: (message: string) => `error: update stopped: ${message}\n`,
  staged: "→ staged update: swapping files only, no daemon restart\n",
  installMode: (detail: string, cliPath: string) => [`→ install mode: ${detail}\n`, `  cli path: ${cliPath}\n\n`],
  autostartFailed: "\n✗ the managed autostart could not be pointed at the new install — fix it before relying on it\n",
  done: "→ done. Restart any open AI clients (Claude Code, Claude Desktop, Codex, ChatGPT Desktop, Cursor) to pick up the new code.\n",
  planHeader: (mode: string) => [
    "(dry-run — describing what would happen, writing nothing)\n\n",
    `→ install source: ${mode}\n`,
  ],
  planRebuild: (command: string) => `  rebuild command (yours to run, never run by 'bastra update'): ${command}\n\n`,
  planUpdate: (command: string) => `  update command: ${command}\n\n`,
  planPreflight: "  would: 0) preflight: back up locally modified files, then refuse or proceed\n",
  planBrewPreflight:
    "  would: 0) skip the preflight — Homebrew installs each version into its own\n" +
    "            Cellar directory, so there is no in-place file to modify or back up\n",
  planReapply: (n: number) =>
    `  would: 1a) reapply ${n} registered local patch${n === 1 ? "" : "es"} ` +
    `(#269) — 'bastra patches status' shows what each would do\n`,
  planInstall: "  would: 1) run the update command above\n",
  planSource: [
    "  would: 1) verify this checkout's build is current, and stop here if it is not\n",
    "            (no pull, no install, no build — 'bastra update' never runs those)\n",
  ],
  planUnknown: "  would: 1) install nothing — the install mode is unknown\n",
  planRegister: "         2) re-register every surface (idempotent)\n",
  planRestart: (staged: boolean): string =>
    staged
      ? "         3) leave the daemon running (staged — no restart mid-session)\n"
      : "         3) restart the daemon\n",
  preflight: (npm: boolean) => `→ preflight: locally modified files${npm ? " + npm provenance (#226)" : ""}\n`,
  nothingLocal: "  ✓ nothing local to protect\n\n",
  nothingInstalled: "  Nothing was installed — the current version is untouched.\n",
  brewPreflight: [
    "→ preflight: not applicable to a Homebrew install\n",
    "  Homebrew never replaces this directory: 'brew upgrade' builds a new keg under\n",
    "  Cellar/bastra-recall/<version>/ and re-points the symlinks, so a locally modified\n",
    "  file here is left behind with the old keg rather than overwritten.\n",
    "  No baseline is recorded either — the path it would be taken from is version-pinned\n",
    "  and gone from the next version's point of view. Keep local patches outside the keg.\n\n",
  ],
  unknownMode: (command: string) => ["⚠ install mode unknown — install manually from:\n", `    ${command}\n\n`],
  brewMissing: "\n✗ brew not found on a trusted PATH — run 'brew upgrade bastra-recall' manually\n",
  brewFailed: (detail: string) =>
    `\n✗ brew upgrade failed (${detail}) — fix it manually, then re-run 'bastra update'\n`,
  baselineEmpty: (root: string) => `  ⚠ no baseline written — ${root} is empty now (install root moved?)\n\n`,
  baselineRecorded: (n: number) =>
    `  ✓ baseline recorded (${n} files) — the next update can tell local changes apart\n\n`,
  baselineFailed: (message: string) =>
    `  ⚠ baseline not written (${message}) — the next update reports 'unknown' instead\n\n`,
  reRegistering: "→ re-registering with every supported surface (idempotent)\n\n",
  windowsCliMissing:
    "error: cannot locate or run the newly installed Windows CLI; refusing re-registration from this old process. Update manually and run bastra install all from the new installation.\n",
  oldProcess:
    "  ⚠ could not locate the newly installed 'bastra' — registering from this (old) process.\n" +
    "    The surfaces may stay pinned to the previous version; run 'bastra doctor' afterwards.\n\n",
  reRegisterFailed: "✗ re-register failed — fix the surface errors above, then re-run\n",
  addressRefreshFailed: (message: string) =>
    `warning: assistant address runtime refresh failed: ${message}. Run bastra address setup --yes from the updated installation.\n`,
  stagedRestart: [
    "→ staged — daemon left running on old code (no restart mid-session)\n",
    "  The managed autostart already names the new runtime, so a logout/reboot starts it (#441).\n",
    "  New code goes live on the next daemon restart:\n",
    "    · automatically after 30 min idle (forwarder mode — an autostart daemon stays warm, #78), or\n",
    "    · now — run 'bastra update' without --staged (restarts the managed autostart daemon), or restart your AI clients\n",
  ],
  restarting: "→ restarting daemon\n",
  launchAgentRefresh: "  managed LaunchAgent restart handled by autostart refresh (bootout + bootstrap)\n\n",
  kicked: "  ✓ autostart service kicked — daemon restarted with new code\n\n",
  kickFailed: "  ✗ kickstart failed — restart the daemon manually\n\n",
  taskSchedulerRefresh: "  managed Task Scheduler restart handled by autostart refresh\n\n",
  manualRestart: [
    "  no running autostart service registered — restart a running daemon manually\n",
    "  Restart it manually if the check below says it is needed:\n",
  ],
  windowsRestart: (port: number) => [
    `    Get-NetTCPConnection -LocalPort ${port} | Select-Object OwningProcess\n`,
    "    Stop-Process -Id <pid>     # forwarder respawns it on the next call\n\n",
  ],
  unixRestart: (port: number) => [
    `    lsof -i :${port}             # find the daemon pid\n`,
    "    kill <pid>                 # forwarder respawns it with new code on next call\n\n",
  ],
};
export type UpdateWords = typeof en;

const de: UpdateWords = {
  modeDetail: (mode, detail, wrapper) =>
    mode === "npm-global"
      ? `über npm installiert (global${wrapper ? `, Paket ${wrapper}` : ""})`
      : mode === "brew"
        ? "über Homebrew installiert"
        : mode === "source"
          ? "läuft aus einem Quellcode-Checkout"
          : mode === "unknown"
            ? "Installationsart nicht bestimmbar"
            : detail,
  handingOff: (bin) => [
    `  → die Neuregistrierung übernimmt ${bin}\n`,
    "    (sie muss mit der neu installierten CLI laufen, nicht mit diesem alten Prozess)\n\n",
  ],
  verifyingSource: "→ Quellcode-Checkout — prüfe den Build (hier wird nichts geholt, installiert oder gebaut)\n",
  leftAlone: "  Nichts wurde neu registriert, der Daemon blieb unberührt.\n",
  buildTogether: "  Daemon und Hook gemeinsam bauen: npm run build:deploy\n",
  kegNotFound: (n) =>
    `⚠ ${patchesDe(n)} nicht wieder eingespielt: das installierte Keg wurde nicht gefunden ('brew --prefix bastra-recall' schlug fehl)\n\n`,
  reapplying: (n) => `→ spiele ${patchesDe(n)} wieder ein (#269)\n`,
  setAside:
    "  Zurückgestellte Patches bleiben registriert — 'bastra patches status' zeigt sie,\n" +
    "  und die Sicherung vor dem Update oben enthält weiterhin deine Dateien.\n",
  reapplyFailed: (message) =>
    `  ⚠ Patches konnten nicht wieder eingespielt werden (${message}) — das Update selbst gilt\n\n`,
  npmFailed: (detail, manual) =>
    `\n✗ npm install ist fehlgeschlagen (${detail})\n  Von Hand aktualisieren:\n    ${manual}\n`,
  npmWrapperHint: (cli) =>
    `  Falls du mit 'npm install -g ${cli}' installiert hast, stattdessen so aktualisieren:\n` +
    `    npm install -g ${cli}@latest\n`,
  npmAgain: "  Danach 'bastra update' erneut ausführen.\n",
  nodeRefused: (_refusal, reason) =>
    `✗ ${reason}. Erst Node.js aktualisieren, dann 'bastra update' ausführen.\n  Nichts wurde installiert — die aktuelle Version bleibt unverändert.\n`,
  stopped: (message) => `Fehler: Update abgebrochen: ${message}\n`,
  staged: "→ Update im Hintergrund: nur Dateien tauschen, kein Neustart des Daemons\n",
  installMode: (detail, cliPath) => [`→ Installationsart: ${detail}\n`, `  CLI-Pfad: ${cliPath}\n\n`],
  autostartFailed:
    "\n✗ der verwaltete Autostart konnte nicht auf die neue Installation zeigen — vor dem nächsten Verlass darauf beheben\n",
  done: "→ fertig. Offene KI-Clients (Claude Code, Claude Desktop, Codex, ChatGPT Desktop, Cursor) neu starten, damit sie den neuen Code laden.\n",
  planHeader: (mode) => [
    "(Probelauf — beschreibt, was passieren würde, schreibt nichts)\n\n",
    `→ Installationsquelle: ${mode}\n`,
  ],
  planRebuild: (command) => `  Befehl zum Neubauen (führst du selbst aus, 'bastra update' nie): ${command}\n\n`,
  planUpdate: (command) => `  Update-Befehl: ${command}\n\n`,
  planPreflight: "  würde: 0) Vorprüfung: lokal geänderte Dateien sichern, dann ablehnen oder fortfahren\n",
  planBrewPreflight:
    "  würde: 0) die Vorprüfung auslassen — Homebrew installiert jede Version in ein eigenes\n" +
    "            Cellar-Verzeichnis, es gibt also keine Datei, die an Ort und Stelle geändert oder gesichert würde\n",
  planReapply: (n) =>
    `  würde: 1a) ${n} registrierte${n === 1 ? "n lokalen Patch" : " lokale Patches"} wieder einspielen ` +
    `(#269) — 'bastra patches status' zeigt, was jeder bewirken würde\n`,
  planInstall: "  würde: 1) den Update-Befehl oben ausführen\n",
  planSource: [
    "  würde: 1) prüfen, ob der Build dieses Checkouts aktuell ist, und sonst hier aufhören\n",
    "            (kein Pull, keine Installation, kein Build — das führt 'bastra update' nie aus)\n",
  ],
  planUnknown: "  würde: 1) nichts installieren — die Installationsart ist unbekannt\n",
  planRegister: "         2) jede Oberfläche neu registrieren (wiederholbar)\n",
  planRestart: (staged) =>
    staged
      ? "         3) den Daemon weiterlaufen lassen (Hintergrund-Update — kein Neustart mitten in der Sitzung)\n"
      : "         3) den Daemon neu starten\n",
  preflight: (npm) => `→ Vorprüfung: lokal geänderte Dateien${npm ? " + npm-Herkunftsnachweis (#226)" : ""}\n`,
  nothingLocal: "  ✓ nichts Lokales zu schützen\n\n",
  nothingInstalled: "  Nichts wurde installiert — die aktuelle Version bleibt unverändert.\n",
  brewPreflight: [
    "→ Vorprüfung: für eine Homebrew-Installation nicht zutreffend\n",
    "  Homebrew ersetzt dieses Verzeichnis nie: 'brew upgrade' baut ein neues Keg unter\n",
    "  Cellar/bastra-recall/<version>/ und biegt die Symlinks um; eine hier lokal geänderte\n",
    "  Datei bleibt beim alten Keg zurück, statt überschrieben zu werden.\n",
    "  Es wird auch keine Ausgangslage festgehalten — ihr Pfad hängt an der Version\n",
    "  und ist für die nächste Version weg. Lokale Patches außerhalb des Kegs aufbewahren.\n\n",
  ],
  unknownMode: (command) => ["⚠ Installationsart unbekannt — von Hand installieren:\n", `    ${command}\n\n`],
  brewMissing:
    "\n✗ brew auf keinem vertrauenswürdigen PATH gefunden — 'brew upgrade bastra-recall' von Hand ausführen\n",
  brewFailed: (detail) =>
    `\n✗ brew upgrade ist fehlgeschlagen (${detail}) — von Hand beheben, dann 'bastra update' erneut ausführen\n`,
  baselineEmpty: (root) =>
    `  ⚠ keine Ausgangslage geschrieben — ${root} ist jetzt leer (Installationsort verschoben?)\n\n`,
  baselineRecorded: (n) =>
    `  ✓ Ausgangslage festgehalten (${n} Dateien) — das nächste Update erkennt lokale Änderungen\n\n`,
  baselineFailed: (message) =>
    `  ⚠ Ausgangslage nicht geschrieben (${message}) — das nächste Update meldet stattdessen 'unbekannt'\n\n`,
  reRegistering: "→ registriere bei jeder unterstützten Oberfläche neu (wiederholbar)\n\n",
  windowsCliMissing:
    "Fehler: die neu installierte Windows-CLI ist nicht auffindbar oder startet nicht; dieser alte Prozess registriert nicht neu. Von Hand aktualisieren und bastra install all aus der neuen Installation ausführen.\n",
  oldProcess:
    "  ⚠ das neu installierte 'bastra' wurde nicht gefunden — registriere aus diesem (alten) Prozess.\n" +
    "    Die Oberflächen bleiben womöglich auf der vorigen Version; danach 'bastra doctor' ausführen.\n\n",
  reRegisterFailed:
    "✗ Neuregistrierung fehlgeschlagen — die Fehler der Oberflächen oben beheben, dann erneut ausführen\n",
  addressRefreshFailed: (message) =>
    `Warnung: die Laufzeit der Assistentenadresse ließ sich nicht auffrischen: ${message}. bastra address setup --yes aus der aktualisierten Installation ausführen.\n`,
  stagedRestart: [
    "→ Hintergrund-Update — der Daemon läuft mit dem alten Code weiter (kein Neustart mitten in der Sitzung)\n",
    "  Der verwaltete Autostart nennt schon die neue Laufzeit, Ab- und Anmelden oder ein Neustart startet sie (#441).\n",
    "  Der neue Code gilt ab dem nächsten Neustart des Daemons:\n",
    "    · automatisch nach 30 Minuten Leerlauf (Forwarder-Modus — ein Autostart-Daemon bleibt warm, #78), oder\n",
    "    · sofort — 'bastra update' ohne --staged ausführen (startet den verwalteten Autostart-Daemon neu) oder die KI-Clients neu starten\n",
  ],
  restarting: "→ starte den Daemon neu\n",
  launchAgentRefresh:
    "  den Neustart des verwalteten LaunchAgent übernimmt die Auffrischung des Autostarts (bootout + bootstrap)\n\n",
  kicked: "  ✓ Autostart-Dienst angestoßen — der Daemon läuft mit dem neuen Code\n\n",
  kickFailed: "  ✗ Anstoßen fehlgeschlagen — den Daemon von Hand neu starten\n\n",
  taskSchedulerRefresh: "  den Neustart der verwalteten Aufgabenplanung übernimmt die Auffrischung des Autostarts\n\n",
  manualRestart: [
    "  kein laufender Autostart-Dienst registriert — einen laufenden Daemon von Hand neu starten\n",
    "  Von Hand neu starten, wenn die Prüfung unten es verlangt:\n",
  ],
  windowsRestart: (port) => [
    `    Get-NetTCPConnection -LocalPort ${port} | Select-Object OwningProcess\n`,
    "    Stop-Process -Id <pid>     # der Forwarder startet ihn beim nächsten Aufruf neu\n\n",
  ],
  unixRestart: (port) => [
    `    lsof -i :${port}             # die PID des Daemons finden\n`,
    "    kill <pid>                 # der Forwarder startet ihn beim nächsten Aufruf mit neuem Code\n\n",
  ],
};

export const UPDATE_WORDS: Readonly<Record<string, UpdateWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function updateWordsIn(language: string | undefined): UpdateWords {
  return UPDATE_WORDS[language ?? "en"] ?? en;
}
/** The words in language.primary, read once per run (English when unset or unreadable). */
export async function updateWords(): Promise<UpdateWords> {
  return updateWordsIn(await taskCliLanguage().catch(() => "en"));
}
