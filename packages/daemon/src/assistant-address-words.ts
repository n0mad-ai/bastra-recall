/**
 * The assistant address's messages for people by language.primary (#1602):
 * `bastra address`, the address part of `config set assistant.name` and
 * `uninstall`, the web UI's address answers and the gateway's error pages.
 * English is the default and the fallback for an unset or unlisted language;
 * German is complete. Text the product writes — never matched against user
 * text, and no code decides on it (callers decide on error codes and classes).
 */
import { settingsFilePath } from "./settings-file.js";
import { getPrimaryLanguage } from "./settings.js";

const en = {
  // lifecycle (assistant-address.ts)
  settingsConflict: "Setting changed during system approval.",
  intentDamaged: "Address reconciliation damaged; do not repeat any system change.",
  nestedRecoveryDamaged: "Nested recovery job damaged.",
  partialHelperUnloaded: "Helper currently not loaded; files or local state not yet fully reconciled.",
  partialHelperLoaded: "Helper currently loaded; files or local state not yet fully reconciled.",
  partialHelperUnknown: "Current service state unknown; files or local state not yet fully reconciled.",
  changeNeedsConsent: "System change needs consent (system consent); bastra address setup <name> --yes",
  setupNeedsConsent: "System setup needs explicit consent (system consent)",
  macOnly:
    "Automatic system setup is only available on macOS; on Windows/Linux the administrator sets up hosts and port 80 access.",
  setupCancelled: "System setup cancelled; nothing changed.",
  setupFailedHelperUnloaded: "Setup failed; the helper was already unloaded and is still not loaded. Files unchanged.",
  setupFailed: "System setup failed; nothing changed.",
  setupCancelledPartial: "System setup cancelled; the existing partial state is kept.",
  setupPartial: (state: string, name: string) =>
    `Setup only partly done: ${state} bastra address setup ${name} --yes restores the address; bastra address remove --yes continues the removal.`,
  adminAnswerMissing: "The admin answer was missing; the actual system setup was checked and adopted.",
  setupUnconfirmed:
    "System setup not finally confirmed, possibly still pending. bastra address status checks the actual state; do not repeat the setup in parallel.",
  rollbackUnconfirmed: "Setup failed; rollback not fully confirmed. Check bastra address status.",
  removeNeedsConsent: "Removing the system address needs consent (system consent)",
  removeByAdministrator: "Have the administrator remove the system address",
  removePartial: (state: string) =>
    `Removal only partly done: ${state} bastra address setup <name> --yes restores the address.`,
  removeFailed: "Removal cancelled or failed; nothing changed.",
  removeUnconfirmed:
    "Removal not finally confirmed; bastra address status checks the actual state. Do not repeat in parallel.",
  helperNotLoaded: "Address helper set up, but not loaded.",
  helperUnreachable: "Address helper loaded, but the address is not reachable; check the runtime.",
  helperUnknown: "Address helper set up; load state unknown and the address is not reachable.",
  hostsRepairStatus: (name: string) =>
    `Back up hosts first. Check the changed block between Bastra's own bastra-recall assistant-address markers; keep your own changes outside the block. Remove only Bastra's complete own block as administrator, then run bastra address setup ${name} --yes again. Do not delete foreign lines.`,
  helperRepair: (name: string, daemonUrl: string) =>
    `Check and reload the address helper with bastra address setup ${name} --yes. Direct UI access: ${daemonUrl}/ui/.`,
  bareNameNotice:
    "Depending on the browser, a single word may count as a search. Open the address once; restart Firefox after the setup. <name>/ or <name>.localhost stays the unambiguous entry.",
  pendingSetup: "System setup still pending; wait for the open dialog and check bastra address status again.",
  partialNeedsConsent: "Finished partial state: restoring or removing needs explicit system approval.",
  repairBusy:
    "Finish the running operation first or wait. Then run bastra address status again; do not change hosts entries.",
  repairSettingsSettled: (command: string) =>
    `Check the setting/name: bastra config get assistant.name. Then confirm the wanted name explicitly with ${command}.`,
  repairSettingsChanged:
    "The setting was changed. Wait for the running system approval first; then run bastra address status again and check the name.",
  repairFirefox: (command: string) => `Close Firefox completely; then run ${command}.`,
  repairIntent: (move: string, command: string) =>
    `First end a still running admin dialog and check that it finished. Back up the damaged job: ${move}. Then run ${command}. Back up hosts first; do not delete foreign entries.`,
  repairHosts: (command: string) =>
    `Back up hosts first. Check Bastra's own changed bastra-recall assistant-address block and remove only that block as administrator; keep foreign changes. Then run ${command}.`,
  repairPartial: (command: string) =>
    `Restore the finished partial state with ${command} or continue with bastra address remove --yes. Do not delete hosts entries by hand.`,
  repairDefault: (command: string) =>
    `Check the cause and run bastra address status again. Once completion is confirmed, ${command} can restore the address; do not delete hosts entries.`,
  partialState: (state: string) => `Partial state: ${state}`,
  adminPending: (name: string) =>
    `Admin setup still pending. End the open dialog first; check bastra address status again. Run bastra address setup ${name} --yes only after completion is confirmed.`,
  adminPidUnsecured:
    "Admin PID not secured; check the open dialog and its actual completion first. Automatic release is blocked without proof of the process; run bastra address status again.",
  afterClarified: (repair: string) => ` Once completion is clarified: ${repair}`,
  // Firefox (assistant-address-firefox.ts)
  firefoxUnknown: "Firefox state unknown; close Firefox and try again.",
  firefoxOpen: "Close Firefox before the setup or change so that Bastra's own browser entries can be removed safely.",
  // admin dialog (assistant-address-admin.ts)
  adminPrompt: "Bastra: set up the local assistant name and port 80",
  adminNotStarted: "System approval could not be started.",
  adminPidWarning:
    "Warning: admin PID not secured; no automatic release without confirmed completion. Check bastra address status.\n",
  adminPidStillRunning:
    "Admin PID not secured; system setup may still be running. Check that the dialog finished; bastra address status conservatively stays pending.",
  adminStillRunning: "System setup may still be running; bastra address status checks and reconciles the actual state.",
  adminResultLost: "Admin result not saved; check bastra address status.",
  adminFailed: "System setup failed; check bastra address status.",
  // gateway error pages (assistant-address-runtime.ts)
  unavailablePage: "Bastra address not available. Please run bastra address setup --yes.\n",
  busyPage: "Bastra address busy right now. Please try again in a moment.\n",
  // bastra address (cli/address-cmd.ts)
  noName: "No assistant name set",
  reachable: "Address reachable",
  notReachable: "Address not set up yet or service not reachable",
  processBoundUpgrade: (command: string) => `Set it up again once, confirmed, for the process boundary: ${command}\n`,
  dryRun: (remove: boolean, target: string | null) =>
    `Would ${remove ? "remove" : "set up"} the local address: ${target ?? "saved name"}. hosts and Bastra's own socket helper need system approval; only Bastra's own Firefox prefs are changed.\n`,
  confirmChange:
    "Change the local assistant name, Bastra's own address helper and Firefox entry? macOS asks once for administrator rights. No foreign entries are overwritten.",
  notConfirmed: "Not confirmed; nothing changed. After checking, run with --yes.",
  setupDone:
    "Local address set up. Open the address once in the browser; restart Firefox if needed. A bare name stays browser-dependent.\n",
  removed: "Own address and browser entries removed.\n",
  confirmRename: "Change Bastra's own system address for the new name? macOS asks for administrator rights.",
  // config set assistant.name (cli/config-cmd.ts)
  oneTimeSetup: "One-time setup: bastra address setup --yes",
  stillApplies: (url: string) => `${url} still applies`,
  noAddressSet: "no address is set up",
  noBrowserAddress: (current: string) => `No browser address can be formed from this name; ${current}.`,
  // uninstall (cli/commands.ts)
  confirmUninstallRemove: "Remove the assistant's own system address? macOS asks for administrator rights.",
  removeFirst: "First remove the own system address with bastra address remove --yes. Nothing uninstalled.\n",
  notRemoved: (message: string) => `Assistant address not removed: ${message}\n`,
  notCheckedOrRemoved: (message: string) =>
    `Assistant address not checked/removed: ${message}. Check bastra address status.\n`,
  // doctor (cli/doctor-address-note.ts)
  doctorLine: (text: string) => `→ assistant address: ${text}\n`,
  doctorPending: "system setup pending",
  doctorReachable: "reachable",
  doctorNotReady: (name: string) => `not ready — run bastra address setup ${name} --yes`,
  doctorHosts: (current: boolean, profiles: number) =>
    `hosts: ${current ? "current" : "missing/stale"}; ${profiles} Firefox profile(s)`,
};
export type AddressWords = typeof en;

const de: AddressWords = {
  settingsConflict: "Einstellung während Systemfreigabe geändert.",
  intentDamaged: "Adress-Abgleich beschädigt; keine Systemänderung wiederholen.",
  nestedRecoveryDamaged: "Verschachtelter Wiederherstellungsauftrag beschädigt.",
  partialHelperUnloaded:
    "Helfer derzeit nicht geladen; Dateien oder lokaler Zustand noch nicht vollständig abgeglichen.",
  partialHelperLoaded: "Helfer derzeit geladen; Dateien oder lokaler Zustand noch nicht vollständig abgeglichen.",
  partialHelperUnknown:
    "Aktueller Dienstzustand unbekannt; Dateien oder lokaler Zustand noch nicht vollständig abgeglichen.",
  changeNeedsConsent: "Systemänderung braucht Zustimmung (system consent); bastra address setup <name> --yes",
  setupNeedsConsent: "Systemeinrichtung braucht ausdrückliche Zustimmung (system consent)",
  macOnly:
    "Automatische Systemeinrichtung ist nur auf macOS verfügbar; hosts/Port-80-Freigabe unter Windows/Linux durch den Administrator einrichten.",
  setupCancelled: "Systemeinrichtung abgebrochen, nichts geändert.",
  setupFailedHelperUnloaded:
    "Einrichtung fehlgeschlagen; Helfer war bereits entladen und ist weiterhin nicht geladen. Dateien unverändert.",
  setupFailed: "Systemeinrichtung fehlgeschlagen, nichts geändert.",
  setupCancelledPartial: "Systemeinrichtung abgebrochen; bestehender Teilzustand bleibt erhalten.",
  setupPartial: (state, name) =>
    `Einrichtung nur teilweise ausgeführt: ${state} bastra address setup ${name} --yes stellt die Adresse wieder her; bastra address remove --yes setzt das Entfernen fort.`,
  adminAnswerMissing: "Admin-Rückmeldung fehlte; tatsächliche Systemeinrichtung geprüft und übernommen.",
  setupUnconfirmed:
    "Systemeinrichtung nicht abschließend bestätigt, möglicherweise noch ausstehend. bastra address status prüft den tatsächlichen Zustand; Einrichtung nicht parallel wiederholen.",
  rollbackUnconfirmed:
    "Einrichtung fehlgeschlagen; Rücknahme nicht vollständig bestätigt. bastra address status prüfen.",
  removeNeedsConsent: "Entfernen der Systemadresse braucht Zustimmung (system consent)",
  removeByAdministrator: "Systemadresse durch den Administrator entfernen",
  removePartial: (state) =>
    `Entfernen nur teilweise ausgeführt: ${state} bastra address setup <name> --yes stellt die Adresse wieder her.`,
  removeFailed: "Entfernen abgebrochen oder fehlgeschlagen, nichts geändert.",
  removeUnconfirmed:
    "Entfernen nicht abschließend bestätigt; bastra address status prüft den tatsächlichen Zustand. Nicht parallel wiederholen.",
  helperNotLoaded: "Adress-Helfer eingerichtet, aber nicht geladen.",
  helperUnreachable: "Adress-Helfer geladen, aber Adresse nicht erreichbar; Laufzeit prüfen.",
  helperUnknown: "Adress-Helfer eingerichtet; Ladezustand unbekannt und Adresse nicht erreichbar.",
  hostsRepairStatus: (name) =>
    `hosts zuerst sichern (Backup). Den veränderten Block zwischen den eigenen bastra-recall assistant-address-Markierungen prüfen; eigene Anpassungen außerhalb des Blocks bewahren. Nur den vollständigen eigenen Block als Administrator entfernen, dann bastra address setup ${name} --yes erneut ausführen. Keine fremden Zeilen löschen.`,
  helperRepair: (name, daemonUrl) =>
    `Adress-Helfer mit bastra address setup ${name} --yes prüfen und erneut laden. Direkter UI-Zugang: ${daemonUrl}/ui/.`,
  bareNameNotice:
    "Einzelne Wörter können je nach Browser als Suche gelten. Adresse einmal öffnen; Firefox nach Einrichtung neu starten. <name>/ oder <name>.localhost bleibt die eindeutige Eingabe.",
  pendingSetup: "Systemeinrichtung noch ausstehend; laufenden Dialog abwarten und bastra address status erneut prüfen.",
  partialNeedsConsent:
    "Abgeschlossener Teilzustand: Wiederherstellen oder Entfernen braucht ausdrückliche Systemfreigabe.",
  repairBusy:
    "Laufenden Vorgang zuerst beenden oder warten. Danach bastra address status erneut ausführen; keine hosts-Einträge ändern.",
  repairSettingsSettled: (command) =>
    `Einstellung/Namen prüfen: bastra config get assistant.name. Danach den gewünschten Namen ausdrücklich mit ${command} bestätigen.`,
  repairSettingsChanged:
    "Einstellung wurde geändert. Laufende Systemfreigabe erst abwarten; danach bastra address status erneut ausführen und den Namen prüfen.",
  repairFirefox: (command) => `Firefox vollständig schließen; dann ${command} ausführen.`,
  repairIntent: (move, command) =>
    `Zuerst einen noch laufenden Admin-Dialog beenden und dessen Abschluss prüfen. Beschädigten Auftrag sichern: ${move}. Danach ${command} ausführen. hosts vorher sichern; keine fremden Einträge löschen.`,
  repairHosts: (command) =>
    `hosts zuerst sichern. Veränderten eigenen bastra-recall assistant-address-Block prüfen und nur diesen als Administrator entfernen; fremde Anpassungen bewahren. Dann ${command} ausführen.`,
  repairPartial: (command) =>
    `Abgeschlossenen Teilzustand mit ${command} wiederherstellen oder mit bastra address remove --yes fortsetzen. Keine hosts-Einträge manuell löschen.`,
  repairDefault: (command) =>
    `Fehlerursache prüfen und bastra address status erneut ausführen. Nach bestätigtem Abschluss kann ${command} die Adresse wiederherstellen; keine hosts-Einträge löschen.`,
  partialState: (state) => `Teilzustand: ${state}`,
  adminPending: (name) =>
    `Admin-Einrichtung noch ausstehend. Laufenden Dialog zuerst beenden; bastra address status erneut prüfen. Erst nach bestätigtem Abschluss bastra address setup ${name} --yes ausführen.`,
  adminPidUnsecured:
    "Admin-PID nicht gesichert; laufenden Dialog und tatsächlichen Abschluss zuerst prüfen. Automatische Freigabe ist ohne Prozessnachweis gesperrt; bastra address status erneut ausführen.",
  afterClarified: (repair) => ` Nach geklärtem Abschluss: ${repair}`,
  firefoxUnknown: "Firefox-Status unbekannt; Firefox schließen und erneut versuchen.",
  firefoxOpen:
    "Firefox vor der Einrichtung oder Änderung schließen, damit eigene Browser-Einträge sicher entfernt werden können.",
  adminPrompt: "Bastra: lokalen Assistentennamen und Port 80 einrichten",
  adminNotStarted: "Systemfreigabe konnte nicht gestartet werden.",
  adminPidWarning:
    "Warnung: Admin-PID nicht gesichert; kein automatisches Freigeben ohne bestätigten Abschluss. bastra address status prüfen.\n",
  adminPidStillRunning:
    "Admin-PID nicht gesichert; Systemeinrichtung läuft möglicherweise noch. Dialogabschluss prüfen; bastra address status bleibt konservativ ausstehend.",
  adminStillRunning:
    "Systemeinrichtung läuft möglicherweise noch; bastra address status prüft und gleicht den tatsächlichen Zustand ab.",
  adminResultLost: "Admin-Ergebnis nicht gespeichert; bastra address status prüfen.",
  adminFailed: "Systemeinrichtung fehlgeschlagen; bastra address status prüfen.",
  unavailablePage: "Bastra-Adresse nicht verfügbar. Bitte bastra address setup --yes ausführen.\n",
  busyPage: "Bastra-Adresse gerade ausgelastet. Bitte gleich erneut versuchen.\n",
  noName: "Kein Assistentenname gesetzt",
  reachable: "Adresse erreichbar",
  notReachable: "Adresse noch nicht eingerichtet oder Dienst nicht erreichbar",
  processBoundUpgrade: (command) => `Für die Prozessgrenze einmal bestätigt neu einrichten: ${command}\n`,
  dryRun: (remove, target) =>
    `Würde lokale Adresse ${remove ? "entfernen" : "einrichten"}: ${target ?? "gespeicherter Name"}. hosts und eigener Socket-Helfer brauchen Systemfreigabe; nur eigene Firefox-Prefs werden verändert.\n`,
  confirmChange:
    "Lokalen Assistentennamen, eigenen Adress-Helfer und Firefox-Eintrag ändern? macOS fragt einmal nach Administratorrechten. Keine fremden Einträge werden überschrieben.",
  notConfirmed: "Nicht bestätigt; nichts geändert. Nach Prüfung mit --yes ausführen.",
  setupDone:
    "Lokale Adresse eingerichtet. Adresse einmal im Browser öffnen; Firefox ggf. neu starten. Ein purer Name bleibt browserabhängig.\n",
  removed: "Eigene Adresse und Browser-Einträge entfernt.\n",
  confirmRename: "Eigene Systemadresse für den neuen Namen ändern? macOS fragt nach Administratorrechten.",
  oneTimeSetup: "Einmalige Einrichtung: bastra address setup --yes",
  stillApplies: (url) => `es gilt weiter ${url}`,
  noAddressSet: "es ist keine Adresse eingerichtet",
  noBrowserAddress: (current) => `Aus diesem Namen lässt sich keine Browser-Adresse bilden; ${current}.`,
  confirmUninstallRemove: "Eigene Assistenten-Systemadresse entfernen? macOS fragt nach Administratorrechten.",
  removeFirst: "Eigene Systemadresse zuerst mit bastra address remove --yes entfernen. Nichts deinstalliert.\n",
  notRemoved: (message) => `Assistenten-Adresse nicht entfernt: ${message}\n`,
  notCheckedOrRemoved: (message) =>
    `Assistenten-Adresse nicht geprüft/entfernt: ${message}. bastra address status prüfen.\n`,
  doctorLine: (text) => `→ Assistenten-Adresse: ${text}\n`,
  doctorPending: "Systemeinrichtung ausstehend",
  doctorReachable: "erreichbar",
  doctorNotReady: (name) => `nicht bereit — bastra address setup ${name} --yes ausführen`,
  doctorHosts: (current, profiles) => `hosts: ${current ? "aktuell" : "fehlt/veraltet"}; ${profiles} Firefox-Profil(e)`,
};

export const ADDRESS_WORDS: Readonly<Record<string, AddressWords>> = { en, de };
/** The address messages in `language`; English for an unset or unlisted one. */
export function addressWords(language: string | undefined): AddressWords {
  return ADDRESS_WORDS[language ?? "en"] ?? en;
}
/** language.primary from the settings file at `settingsPath`; undefined when unset or unreadable. */
export async function addressLanguage(settingsPath: string = settingsFilePath()): Promise<string | undefined> {
  return getPrimaryLanguage(settingsPath);
}
/** The options with `language` resolved once per public lifecycle call, so every message inside follows it. */
export async function withAddressLanguage<T extends { language?: string; settingsPath?: string }>(
  options: T
): Promise<T> {
  return options.language ? options : { ...options, language: await addressLanguage(options.settingsPath) };
}
