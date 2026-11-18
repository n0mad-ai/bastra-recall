/**
 * The words `bastra autostart`, the autostart refresh of `bastra update` and
 * the doctor's autostart warning print, by language.primary (#1602): English
 * is the default and the fallback (byte-identical to before), German
 * complete. The browser settings path and `--json` stay English (they are not
 * terminal text for a person). Text the product writes — never matched
 * against user text.
 */
const en = {
  unsupported:
    "bastra autostart supports macOS LaunchAgents and Windows Task Scheduler.\n" +
    "On Linux use on-demand start or a systemd user unit.\n",
  foreign: (path: string, program: string | null) =>
    `error: ${path} already exists and was not written by bastra.\n` +
    (program !== null ? `  it starts: ${program}\n` : "") +
    `  Leaving it alone — a user-defined autostart service usually points somewhere on purpose\n` +
    `  (a source checkout, a custom model setup). Replace it with --force, or remove it first.\n`,
  error: (message: string) => `error: ${message}\n`,
  scriptMissing: (path: string) =>
    `error: the daemon entry point is missing: ${path}\n` +
    `  Run the build (or reinstall) before enabling autostart.\n`,
  dryRunWrite: (path: string) => `(dry-run — writing nothing)\n\n  would write ${path}\n`,
  dryRunStart: (program: string, vault: string) => `  would start: ${program}\n  vault: ${vault}\n`,
  dryRunEndpoint: (endpoint: string) => `  endpoint: ${endpoint}\n`,
  onResult: (ok: boolean): string => (ok ? "✓ autostart on\n" : "✗ autostart could not be enabled\n"),
  service: (path: string) => `  service: ${path}\n`,
  starts: (program: string) => `  starts: ${program}\n`,
  vault: (path: string) => `  vault:  ${path}\n`,
  endpointPersisted: (endpoint: string) => `  endpoint: ${endpoint} (persisted in the service)\n`,
  registered: "  ✓ registered for the next login\n",
  loaded: "  ✓ loaded — the daemon stays up from now on (idle shutdown disabled)\n",
  serviceFailed: (detail: string) =>
    `  ✗ autostart service failed: ${detail}\n` +
    `    Run bastra autostart status for details and retry bastra autostart on.\n`,
  alreadyOff:
    "autostart is already off — no autostart service installed.\n" +
    "  The daemon still starts on demand when an AI client calls it.\n",
  notOurs: (path: string) =>
    `error: ${path} was not written by bastra — leaving it alone.\n` +
    `  Remove it with --force, or delete the file yourself.\n`,
  dryRunRemove: (path: string) => `(dry-run — writing nothing)\n\n  would unload and remove ${path}\n`,
  off: "✓ autostart off\n",
  removed: (path: string) => `  removed ${path}\n`,
  offStaged: "  Login registration removed; the running daemon is unchanged.\n",
  offOnDemand:
    "  The daemon still starts on demand through the MCP forwarder,\n" +
    "  and shuts down again after 30 minutes idle.\n",
  statusHeader: "→ autostart\n",
  statusUnsupported: "  · unsupported platform — this system uses on-demand start through the MCP forwarder\n\n",
  statusOff:
    "  off — the daemon starts on demand and shuts down after 30 min idle\n" +
    `  turn it on with: bastra autostart on\n\n`,
  statusState: (loaded: boolean, path: string) => `  ${loaded ? "on" : "installed but NOT loaded"} — ${path}\n`,
  owner: (managed: boolean) => `  owner:  ${managed ? "bastra" : "hand-written (bastra will not touch it)"}\n`,
  dangling: (path: string) =>
    `  ⚠ ${path} does not exist any more — the autostart points at a\n` +
    `    runtime that was moved or removed. Fix it with: bastra autostart on\n`,
  daemonRunning: (label: string, version: string) => `  daemon: running at ${label}${version}\n`,
  daemonDown: (label: string) => `  daemon: not reachable at ${label}\n`,
  portSplit: (port: number, label: string) =>
    `  ⚠ the autostart service starts the daemon on port ${port}, but this shell is\n` +
    `    configured for ${label} — the line above describes ${label}, not the\n` +
    `    autostarted daemon. Re-run 'bastra autostart on' to agree on one endpoint.\n`,
  unknownSub: (sub: string) => `error: unknown autostart subcommand '${sub}' — use on, off or status\n`,
  unknownPath: "an unknown path",
  notResolved: (at: string) =>
    `  ✗ could not resolve where the installer put the daemon — leaving the autostart at\n` +
    `    ${at}. Run 'bastra autostart on' from the new install.\n`,
  snapshot: (path: string) => `  ✓ LaunchAgent snapshot: ${path}\n`,
  snapshotFailed: (path: string, message: string) => `  ✗ could not snapshot ${path}: ${message}\n`,
  repointing: (at: string) => `→ autostart points at ${at} — repointing it at the installed runtime\n`,
  rewriteFailed: (path: string, message: string) => `  ✗ could not rewrite ${path}: ${message}\n`,
  bootoutFailed: "  ✗ bootout failed; service was not reloaded\n",
  bootstrapFailed: (stopped: boolean, detail: string, uid: string, path: string) =>
    `  ✗ ${
      stopped
        ? `bootstrap failed after bootout; service is stopped: ${detail}`
        : `bootstrap failed; service is not running: ${detail}`
    }\n  Recover with: launchctl bootstrap gui/${uid} "${path}"\n`,
  stillNames: (program: string, expected: string) =>
    `  ✗ the autostart still names ${program || "nothing"} — expected ` + `${expected}\n`,
  namesMissing: (path: string) => `  ✗ the autostart names ${path}, which is not on disk\n`,
  notNode: (path: string) => `  ✗ ${path} does not run as node — the autostart would not come up\n`,
  nowRuns: (reload: boolean, script: string, version: string) =>
    reload
      ? `  ✓ autostart now runs ${script}${version}\n`
      : `  ✓ autostart now names ${script}${version} — staged, so the running agent was left alone\n`,
  windowsRefreshed: (reload: boolean): string =>
    reload
      ? "  ✓ managed Task Scheduler service restarted with the installed runtime\n"
      : "  ✓ managed Task Scheduler service updated; running daemon left alone (staged)\n",
  legacyKeys: (keys: string) => `  ⚠ omitting legacy credential keys from managed environment: ${keys}\n`,
  queryFailed: (message: string) => `could not query autostart service: ${message}`,
  danglingWarning: (path: string, managed: boolean) =>
    `autostart names ${path}, which does not exist any more — ` +
    (managed
      ? `run 'bastra autostart on' to repoint it.`
      : `it is hand-written, so fix it yourself or replace it with 'bastra autostart on --force'.`),
  notRunningWarning: (path: string) =>
    `an autostart service is installed at ${path} but not running — run 'bastra autostart on'.`,
  tasksPlistDrift:
    "BASTRA_TASKS in the plist differs from launchd: reload with bootout + bootstrap (kickstart does not reload plist env).",
  tasksClientDrift:
    "BASTRA_TASKS differs between this client environment and the managed daemon service — align the task setting and reload the service with bootout + bootstrap.",
  legacySnapshots: (count: number) =>
    `${count} legacy LaunchAgent snapshot(s) are readable beyond the owner; old snapshots were left unchanged. Review their permissions and any legacy credentials separately.`,
  exposedBackups: (count: number, paths: string, quoted: string) =>
    `${count} LaunchAgent backup copy(ies) are readable beyond the owner and may hold environment values: ${paths}. Restrict them with: chmod 600 ${quoted}`,
};
export type AutostartWords = typeof en;

const de: AutostartWords = {
  unsupported:
    "bastra autostart unterstützt macOS-LaunchAgents und die Windows-Aufgabenplanung.\n" +
    "Unter Linux den Start bei Bedarf oder eine systemd-Benutzer-Unit verwenden.\n",
  foreign: (path, program) =>
    `Fehler: ${path} existiert bereits und wurde nicht von bastra geschrieben.\n` +
    (program !== null ? `  er startet: ${program}\n` : "") +
    `  Bleibt unangetastet — ein selbst angelegter Autostart-Dienst zeigt meist mit Absicht woandershin\n` +
    `  (ein Quellcode-Checkout, eine eigene Modell-Einrichtung). Mit --force ersetzen oder vorher entfernen.\n`,
  error: (message) => `Fehler: ${message}\n`,
  scriptMissing: (path) =>
    `Fehler: der Einstiegspunkt des Daemons fehlt: ${path}\n` +
    `  Vor dem Einschalten des Autostarts bauen (oder neu installieren).\n`,
  dryRunWrite: (path) => `(Probelauf — es wird nichts geschrieben)\n\n  würde schreiben: ${path}\n`,
  dryRunStart: (program, vault) => `  würde starten: ${program}\n  Vault: ${vault}\n`,
  dryRunEndpoint: (endpoint) => `  Endpunkt: ${endpoint}\n`,
  onResult: (ok) => (ok ? "✓ Autostart an\n" : "✗ Autostart ließ sich nicht einschalten\n"),
  service: (path) => `  Dienst: ${path}\n`,
  starts: (program) => `  startet: ${program}\n`,
  vault: (path) => `  Vault:  ${path}\n`,
  endpointPersisted: (endpoint) => `  Endpunkt: ${endpoint} (im Dienst festgeschrieben)\n`,
  registered: "  ✓ für die nächste Anmeldung eingetragen\n",
  loaded: "  ✓ geladen — der Daemon läuft ab jetzt durchgehend (Abschalten bei Leerlauf aus)\n",
  serviceFailed: (detail) =>
    `  ✗ Autostart-Dienst fehlgeschlagen: ${detail}\n` +
    `    Mit bastra autostart status die Einzelheiten ansehen und bastra autostart on erneut versuchen.\n`,
  alreadyOff:
    "Autostart ist bereits aus — kein Autostart-Dienst eingerichtet.\n" +
    "  Der Daemon startet weiterhin bei Bedarf, wenn ein KI-Client ihn aufruft.\n",
  notOurs: (path) =>
    `Fehler: ${path} wurde nicht von bastra geschrieben — bleibt unangetastet.\n` +
    `  Mit --force entfernen oder die Datei selbst löschen.\n`,
  dryRunRemove: (path) => `(Probelauf — es wird nichts geschrieben)\n\n  würde entladen und entfernen: ${path}\n`,
  off: "✓ Autostart aus\n",
  removed: (path) => `  entfernt: ${path}\n`,
  offStaged: "  Anmelde-Eintrag entfernt; der laufende Daemon bleibt unverändert.\n",
  offOnDemand:
    "  Der Daemon startet weiterhin bei Bedarf über den MCP-Forwarder\n" +
    "  und beendet sich nach 30 Minuten Leerlauf wieder.\n",
  statusHeader: "→ Autostart\n",
  statusUnsupported: "  · Plattform nicht unterstützt — dieses System startet bei Bedarf über den MCP-Forwarder\n\n",
  statusOff:
    "  aus — der Daemon startet bei Bedarf und beendet sich nach 30 Min. Leerlauf\n" +
    `  einschalten mit: bastra autostart on\n\n`,
  statusState: (loaded, path) => `  ${loaded ? "an" : "eingerichtet, aber NICHT geladen"} — ${path}\n`,
  owner: (managed) => `  Besitzer: ${managed ? "bastra" : "selbst geschrieben (bastra fasst ihn nicht an)"}\n`,
  dangling: (path) =>
    `  ⚠ ${path} gibt es nicht mehr — der Autostart zeigt auf eine\n` +
    `    verschobene oder entfernte Laufzeit. Beheben mit: bastra autostart on\n`,
  daemonRunning: (label, version) => `  Daemon: läuft an ${label}${version}\n`,
  daemonDown: (label) => `  Daemon: nicht erreichbar an ${label}\n`,
  portSplit: (port, label) =>
    `  ⚠ der Autostart-Dienst startet den Daemon auf Port ${port}, diese Shell ist aber\n` +
    `    auf ${label} eingestellt — die Zeile darüber beschreibt ${label}, nicht den\n` +
    `    automatisch gestarteten Daemon. 'bastra autostart on' erneut ausführen, um sich auf einen Endpunkt zu einigen.\n`,
  unknownSub: (sub) => `Fehler: unbekannter Autostart-Unterbefehl '${sub}' — möglich sind on, off oder status\n`,
  unknownPath: "einem unbekannten Pfad",
  notResolved: (at) =>
    `  ✗ nicht feststellbar, wohin der Installer den Daemon gelegt hat — der Autostart bleibt bei\n` +
    `    ${at}. 'bastra autostart on' aus der neuen Installation ausführen.\n`,
  snapshot: (path) => `  ✓ LaunchAgent-Sicherung: ${path}\n`,
  snapshotFailed: (path, message) => `  ✗ Sicherung von ${path} fehlgeschlagen: ${message}\n`,
  repointing: (at) => `→ Autostart zeigt auf ${at} — wird auf die installierte Laufzeit umgestellt\n`,
  rewriteFailed: (path, message) => `  ✗ ${path} ließ sich nicht neu schreiben: ${message}\n`,
  bootoutFailed: "  ✗ bootout fehlgeschlagen; Dienst wurde nicht neu geladen\n",
  bootstrapFailed: (stopped, detail, uid, path) =>
    `  ✗ ${
      stopped
        ? `bootstrap nach bootout fehlgeschlagen; Dienst ist gestoppt: ${detail}`
        : `bootstrap fehlgeschlagen; Dienst läuft nicht: ${detail}`
    }\n  Wiederherstellen mit: launchctl bootstrap gui/${uid} "${path}"\n`,
  stillNames: (program, expected) =>
    `  ✗ der Autostart nennt weiterhin ${program || "nichts"} — erwartet: ` + `${expected}\n`,
  namesMissing: (path) => `  ✗ der Autostart nennt ${path}, das nicht auf der Platte liegt\n`,
  notNode: (path) => `  ✗ ${path} läuft nicht als node — der Autostart käme nicht hoch\n`,
  nowRuns: (reload, script, version) =>
    reload
      ? `  ✓ Autostart startet jetzt ${script}${version}\n`
      : `  ✓ Autostart nennt jetzt ${script}${version} — vorgemerkt, der laufende Agent blieb unangetastet\n`,
  windowsRefreshed: (reload) =>
    reload
      ? "  ✓ verwalteter Dienst der Aufgabenplanung mit der installierten Laufzeit neu gestartet\n"
      : "  ✓ verwalteter Dienst der Aufgabenplanung aktualisiert; laufender Daemon unangetastet (vorgemerkt)\n",
  legacyKeys: (keys) => `  ⚠ alte Zugangsschlüssel werden aus der verwalteten Umgebung weggelassen: ${keys}\n`,
  queryFailed: (message) => `Autostart-Dienst ließ sich nicht abfragen: ${message}`,
  danglingWarning: (path, managed) =>
    `Autostart nennt ${path}, das es nicht mehr gibt — ` +
    (managed
      ? `'bastra autostart on' ausführen, um ihn umzustellen.`
      : `er ist selbst geschrieben, also selbst beheben oder mit 'bastra autostart on --force' ersetzen.`),
  notRunningWarning: (path) =>
    `ein Autostart-Dienst ist unter ${path} eingerichtet, läuft aber nicht — 'bastra autostart on' ausführen.`,
  tasksPlistDrift:
    "BASTRA_TASKS in der plist weicht von launchd ab: mit bootout + bootstrap neu laden (kickstart lädt die Umgebung der plist nicht neu).",
  tasksClientDrift:
    "BASTRA_TASKS weicht zwischen der Umgebung dieses Clients und dem verwalteten Daemon-Dienst ab — die Aufgaben-Einstellung angleichen und den Dienst mit bootout + bootstrap neu laden.",
  legacySnapshots: (count) =>
    `${count} alte LaunchAgent-Sicherung(en) sind über den Besitzer hinaus lesbar; alte Sicherungen wurden nicht verändert. Ihre Rechte und mögliche alte Zugangsdaten gesondert prüfen.`,
  exposedBackups: (count, paths, quoted) =>
    `${count} LaunchAgent-Sicherungskopie(n) sind über den Besitzer hinaus lesbar und können Umgebungswerte enthalten: ${paths}. Einschränken mit: chmod 600 ${quoted}`,
};

export const AUTOSTART_WORDS: Readonly<Record<string, AutostartWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function autostartWordsIn(language: string | undefined): AutostartWords {
  return AUTOSTART_WORDS[language ?? "en"] ?? en;
}
