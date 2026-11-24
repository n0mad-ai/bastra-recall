/** The `bastra tasks` CLI's words by language. The whole CLI follows
 *  language.primary, English when unset or unlisted, so one dialog never mixes
 *  two languages (#1602). Text the product writes — never matched against user text. */
import { getPrimaryLanguage } from "../settings.js";

/** language.primary from the settings file at `settingsPath` (the default one when not given). */
export async function taskCliLanguage(settingsPath?: string): Promise<string> {
  return (await getPrimaryLanguage(settingsPath)) ?? "en";
}
/** One CLI text by language; an unlisted language gets English. */
export type TaskCliText = Readonly<{ en: string } & Record<string, string>>;
export const inLanguage = (text: TaskCliText, language: string | undefined) => text[language ?? "en"] ?? text.en;

const en = {
  locale: "en-GB",
  noneYet: "none yet",
  none: "none",
  onOff: (on: boolean): string => (on ? "on" : "off"),
  yesNo: (yes: boolean): string => (yes ? "yes" : "no"),
  whyNowRegistered: "The trigger is due. Elapsed time does not confirm a measurement result.",
  accessHint: {
    disabled: "Chat reminders are switched off.",
    "unsafe-or-corrupt": "Reminder access is damaged or too open; cards stay silent. Owner: bastra tasks setup-hooks.",
    missing: "Reminder access is missing. Start the daemon; if it is still missing: bastra tasks setup-hooks.",
    ready: "On next contact, while the daemon is running.",
    "owner-not-for-agents": "Do not use owner access for automatic agent cards.",
    "revoked-or-invalid": "Reminder access is revoked or invalid; cards stay silent. Owner: bastra tasks setup-hooks.",
  } as Record<string, string>,
  reviewName: {
    "Explicit owner review required": "The owner must arm it explicitly.",
    "Owner review required before arming": "The owner must arm it explicitly.",
    "Edited binding requires explicit owner review": "Edited; the owner must review it again.",
    "Recovered snapshot requires owner review": "Recovered; the owner must review it again.",
  } as Record<string, string>,
  levelName: { notify: "remind", prepare: "prepare", execute: "execute (instruction in chat)" } as Record<
    string,
    string
  >,
  stateName: {
    pending: "open",
    due: "due",
    snoozed: "snoozed",
    resolved: "done",
    cancelled: "cancelled",
    expired: "expired",
  } as Record<string, string>,
  verificationName: {
    verified: "confirmed",
    refuted: "premise changed",
    inconclusive: "unclear/contested",
    unavailable: "not reachable",
    stale: "outdated",
  } as Record<string, string>,
  verificationReason: {
    irrelevant_claim: "event concerns another premise",
    evidence_not_attributable: "evidence unknown or contested",
    unknown_or_contested_evidence: "evidence unknown or contested",
    source_disabled_or_missing: "source off or missing",
    source_timeout: "time budget reached",
    source_budget: "source budget exceeded",
    evidence_revision_drift: "evidence revision changed",
    claim_evidence_mismatch: "event does not match the evidence",
    state_too_old: "source state too old",
    evidence_too_old: "evidence too old",
    unattributable_state_age: "timestamp cannot be attributed",
  } as Record<string, string>,
  notConfirmed: "not confirmed",
  checked: (when: string) => `checked ${when}`,
  waitingFirstEvent: "waiting for the first event",
  notChecked: "not checked yet",
  actionState: {
    pending: "open, reconciliation required",
    succeeded: "effect confirmed",
    reconciled: "target state reconciled",
    unknown: "outcome unknown, reconciliation required",
    failed: "failed",
  } as Record<string, string>,
  event: (id: string) => `Event ${id}`,
  armed: (armed: boolean): string => (armed ? "armed" : "unarmed"),
  paused: "paused",
  ambiguous: "Ambiguous local time: the earlier instant was chosen. The owner must check this choice with review.",
  validUntil: (when: string, timezone: string) => `Valid until ${when} (${timezone})`,
  snoozedUntil: (when: string, timezone: string) => `Snoozed until ${when} (${timezone})`,
  recurrence: (calendar: boolean, bound: string) =>
    `Repetition: ${calendar ? "calendar days" : "elapsed time"}; ${bound}`,
  count: (n: number) => `count ${n}`,
  until: (when: string) => `until ${when}`,
  noEnd: "no end",
  rearmed: "Submitted for review again, UNARMED. Arm it: bastra tasks review <id>.",
  lastFailure: (message: string) => `Last task error: ${message}`,
  sourceUnreachable: "source not reachable",
  budget: (poll: number, timeout: number, bytes: number) =>
    `Budget: check at most every ${poll}s; timeout ${timeout}ms; source at most ${bytes} bytes.`,
  sourceCheck: (text: string) => `Source check: ${text}`,
  review: (text: string) => `Review: ${text}`,
  deleted: (id: string) => `Task ${id} deleted.`,
  archived: (id: string) => `Tasks archived. Archive ID ${id}.`,
  details: (command: string) => `Details: ${command}`,
  dueAt: (when: string) => `due ${when}`,
  acknowledgedOpen: " · acknowledged, still open",
  effect: "Effect",
  intent: "intent",
  tempRest: "temp leftover, safe cleanup required",
  receiptPresent: "receipt present",
  task: "Task",
  shortened: (command: string) => `Shortened; details: ${command}`,
  occurrence: "Occurrence",
  acknowledge: "Acknowledge",
  deliveryPaused: "Delivery is muted or off; the owner still sees due work here.",
  moreDue: (n: number) => `More due cards: ${n}; call due again.`,
  noDue: "No current due card. Unarmed, snoozed or open tasks and delivery reasons: bastra tasks status.",
  control: {
    mute: "Muted: delivery is postponed, nothing gets done by itself.",
    unmute: "Delivery is audible again; open work is kept.",
    off: "Feature off: no automatic evaluation or delivery; tasks stay stored.",
    on: "Feature on: evaluation on next contact or job; execution approvals are not renewed.",
    stop: "Execution stopped. Reminding and preparing stay available.",
    resume: "Execution stop lifted; only explicitly enabled adapters with a valid new effect chain may write.",
  } as Record<string, string>,
  controlSummary: (enabled: boolean, muted: boolean, stopped: boolean) =>
    `Feature ${enabled ? "on" : "off"}, delivery ${muted ? "muted" : "audible"}, execution ${stopped ? "stopped" : "allowed"}. No task done, no approval renewed.`,
  noTasks: "No tasks.",
  released: "Reservation released. Existing effect receipts are kept; no approval renewed.",
  status: {
    reminderAccess: "Reminder access: ",
    feature: "Feature: ",
    automation: (enabled: boolean, running: boolean) =>
      `Automation: ${!enabled ? "off" : running ? "running" : "not active"}`,
    delivery: "Delivery: on next contact",
    muted: "Muted: ",
    executionStopped: (stopped: boolean) =>
      `Execution stopped: ${stopped ? "yes (on the user's instruction: execution-enable --agent)" : "no"}`,
    nextCheck: "Next check: ",
    nextCheckOff: "none, feature off",
    lastDelivery: "Last delivery: ",
    lastJobError: "Last job error: ",
    noJobError: "none",
    globalBudgets: "Global budgets: at most 10 source checks per 5s run, 60s poll; file access at most 1s per source.",
    archives: "Archives: ",
    archiveTasks: (n: number) => `${n} tasks`,
    effects: (intents: number, intentLimit: number, receipts: number, receiptLimit: number) =>
      `Effects: ${intents}/${intentLimit} intents · ${receipts}/${receiptLimit} receipts`,
    intent: "Intent",
    target: "target",
    receipt: "Receipt",
    rollback: (available: boolean) =>
      `rollback ${available ? "checkable with a user instruction and a fresh target check" : "no"}`,
    sources: "Sources: ",
    adapters: "Adapters: ",
    leases: "Reservations: ",
    leaseState: { active: "reserved", released: "released", expired: "expired" } as Record<string, string>,
    leaseUntil: (when: string) => `until ${when}`,
    leaseRelease: "own release: bastra tasks release",
    approval: "Approval: the user's instruction in chat · Trust boundary: local account",
    chatOrder: "Chat instruction",
    session: "session",
    authorization: (revoked: boolean, denied: boolean, consumed: boolean): string =>
      revoked ? "revoked" : denied ? "declined" : consumed ? "used" : "recorded",
  },
  timezoneAssumed: (timezone: string) =>
    `Time zone taken from the system: ${timezone}. Set it deliberately with --timezone.`,
  uiHint: "(turn the UI on: bastra config set ui.enabled true)",
  clientValid: "Client credential valid (the daemon must be running)",
  clientNoCards: "No cards for this client",
  authConfirm: "Manage access as the owner at the terminal? Token files must be outside the agents' reach.",
  authRevoked: (id: string) => `Access ${id} revoked. This client receives no more cards.`,
  authMinted: (role: string, actor: string, domains: string, id: string) =>
    `Access created: ${role === "owner" ? "owner" : "agent"} ${actor}, domains ${domains}. Token stored privately in the chosen file; next run bastra tasks setup-hooks. Credential ${id}.`,
  ownerTokenPrompt: "Owner task token (hidden): ",
  ownerLoginConfirm:
    "Store owner access privately for the interactive CLI only? This data directory must be outside the agents' reach; hooks and MCP never get this token.",
  ownerLoginDone:
    "Owner access stored privately for the interactive CLI. It is checked fresh on every command; the instruction in chat is the execution approval.",
  boundary:
    "The trust boundary is the local computer account. No extra boundary declaration or key approval is needed.",
  executionEnabled:
    "Local adapter enabled, execution stop lifted. The user's instruction in chat is the approval; preview, write check and receipt stay required.",
  hooksReady:
    "Cards for local hooks and MCP are set up. Separate agent credential; no owner key, no execution approval. On next contact, while the daemon is running. BASTRA_TASK_TOKEN overrides this configuration.",
  recoverConfirm:
    "Restore the backup? All tasks become unarmed and execution stops; the original is kept privately. Stop all task processes first.",
  recoverLockConfirm:
    "Also store an unknown lock privately? I explicitly confirm: ALL task processes have ended. Known live local owners are still refused.",
  restoreConfirm: "Take the archive back for readable history and rollback? It stays unarmed, execution stopped.",
  archiveConfirm: (ids: string) =>
    `Archive the finished tasks ${ids} privately? Open occurrences and unclear effects stay active; idempotency, history and used approvals are kept.`,
  recovered: (exports: number) =>
    `Older backup restored, original kept. Changes since the backup may be missing; archived tasks may be active in the history again. ${exports} cold archive exports reconciled and indexed. All tasks unarmed, execution stopped. Restart the daemon; check the original, archives and effects; the owner must review again.`,
  restored: "Archive taken back. History and receipts kept; execution stopped, no approval renewed.",
  archivedDone: (id: string) =>
    `Finished tasks archived; open work unchanged. Archive ID ${id}. History and rollback: bastra tasks archive-restore ${id}.`,
  noTargets: "No targets registered.",
  targetLine: (id: string, path: string, domains: string) => `Target ${id}: ${path}; domains ${domains}.`,
  targetRemoveConfirm: "Remove the target? Execution stops and old proposals and approvals become outdated.",
  targetRemoved: "Target removed; execution stopped, old proposals outdated.",
  targetPreview: (id: string, path: string, root: string, domains: string) =>
    `Local target ${id}: ${path}; resolved work folder ${root}; domains ${domains}. The adapter replaces exactly this UTF-8 file, no provider.`,
  packageScripts:
    "WARNING: package.json can define install, test or start scripts that run code later. Check exact script changes before the approval.",
  outsideWorkdir:
    "WARNING: this chosen work folder is outside the current project folder. Use only explicitly approved work files; configuration, keys and vault are protected.",
  targetConfirm: (update: boolean) =>
    `${update ? "Change" : "Register"} this local target? Execution stops, old proposals become outdated.`,
  targetDone: (id: string, update: boolean) =>
    `Target ${id} ${update ? "changed" : "registered"}. Execution stopped. The instruction in chat is the approval.`,
  chatConsentQuestion:
    "May Recall announce due tasks in your active Claude Code chat? Enabling crossSessionInbound=accept allows incoming session messages from all programs under your Mac account.",
  chatConsentResult: {
    accepted:
      "Claude chat delivery enabled for new sessions. Messages are task data, never execution approval; macOS notification and the board remain available.",
    blocked:
      "Claude chat delivery stays off: existing hold/refuse, unknown inbound value or managed settings were preserved. macOS notification and the board remain available; this setup will not ask again.",
    declined:
      "Claude chat delivery declined and saved; this setup will not ask again. macOS notification and the board remain available.",
  } as Record<"accepted" | "blocked" | "declined", string>,
};
export type TaskCliWords = typeof en;

const de: TaskCliWords = {
  locale: "de-DE",
  noneYet: "noch keine",
  none: "keine",
  onOff: (on) => (on ? "an" : "aus"),
  yesNo: (yes) => (yes ? "ja" : "nein"),
  whyNowRegistered: "Der Auslöser ist fällig. Zeitablauf bestätigt kein Messergebnis.",
  accessHint: {
    disabled: "Gesprächserinnerungen sind ausgeschaltet.",
    "unsafe-or-corrupt":
      "Erinnerungszugang beschädigt oder zu offen; Karten bleiben stumm. Owner: bastra tasks setup-hooks.",
    missing: "Erinnerungszugang fehlt. Daemon starten; falls weiterhin fehlend: bastra tasks setup-hooks.",
    ready: "Bei nächstem Kontakt, solange der Daemon läuft.",
    "owner-not-for-agents": "Owner-Zugang nicht für automatische Agent-Karten verwenden.",
    "revoked-or-invalid":
      "Erinnerungszugang widerrufen/ungültig; Karten bleiben stumm. Owner: bastra tasks setup-hooks.",
  },
  reviewName: {
    "Explicit owner review required": "Owner muss ausdrücklich scharf schalten.",
    "Owner review required before arming": "Owner muss ausdrücklich scharf schalten.",
    "Edited binding requires explicit owner review": "Bearbeitet; Owner muss neu prüfen.",
    "Recovered snapshot requires owner review": "Wiederhergestellt; Owner muss neu prüfen.",
  },
  levelName: { notify: "erinnern", prepare: "vorbereiten", execute: "ausführen (Anweisung im Chat)" },
  stateName: {
    pending: "offen",
    due: "fällig",
    snoozed: "zurückgestellt",
    resolved: "erledigt",
    cancelled: "abgebrochen",
    expired: "abgelaufen",
  },
  verificationName: {
    verified: "bestätigt",
    refuted: "Prämisse geändert",
    inconclusive: "unklar/strittig",
    unavailable: "nicht erreichbar",
    stale: "veraltet",
  },
  verificationReason: {
    irrelevant_claim: "Ereignis betrifft eine andere Prämisse",
    evidence_not_attributable: "Evidenz unbekannt oder strittig",
    unknown_or_contested_evidence: "Evidenz unbekannt oder strittig",
    source_disabled_or_missing: "Quelle aus oder fehlt",
    source_timeout: "Zeitbudget erreicht",
    source_budget: "Quellbudget überschritten",
    evidence_revision_drift: "Evidenzrevision geändert",
    claim_evidence_mismatch: "Ereignis passt nicht zur Evidenz",
    state_too_old: "Quellstand zu alt",
    evidence_too_old: "Evidenz zu alt",
    unattributable_state_age: "Zeitstempel nicht belegbar",
  },
  notConfirmed: "nicht bestätigt",
  checked: (when) => `geprüft ${when}`,
  waitingFirstEvent: "wartet auf erstes Ereignis",
  notChecked: "noch nicht geprüft",
  actionState: {
    pending: "offen, Abgleich nötig",
    succeeded: "Wirkung bestätigt",
    reconciled: "Zielstand abgeglichen",
    unknown: "Ausgang unklar, Abgleich nötig",
    failed: "fehlgeschlagen",
  },
  event: (id) => `Ereignis ${id}`,
  armed: (armed) => (armed ? "scharf" : "unscharf"),
  paused: "pausiert",
  ambiguous: "Mehrdeutige Ortszeit: früherer Zeitpunkt gewählt. Owner muss diese Wahl mit review prüfen.",
  validUntil: (when, timezone) => `Gültig bis ${when} (${timezone})`,
  snoozedUntil: (when, timezone) => `Zurückgestellt bis ${when} (${timezone})`,
  recurrence: (calendar, bound) => `Wiederholung: ${calendar ? "Kalendertage" : "verstrichene Dauer"}; ${bound}`,
  count: (n) => `Anzahl ${n}`,
  until: (when) => `bis ${when}`,
  noEnd: "ohne Ende",
  rearmed: "Wieder zur Prüfung vorgelegt, UNSCHARF. Scharf schalten: bastra tasks review <id>.",
  lastFailure: (message) => `Letzter Aufgabenfehler: ${message}`,
  sourceUnreachable: "Quelle nicht erreichbar",
  budget: (poll, timeout, bytes) =>
    `Budget: Prüfung frühestens alle ${poll}s; Timeout ${timeout}ms; Quelle höchstens ${bytes} Bytes.`,
  sourceCheck: (text) => `Quellenprüfung: ${text}`,
  review: (text) => `Prüfung: ${text}`,
  deleted: (id) => `Aufgabe ${id} gelöscht.`,
  archived: (id) => `Aufgaben archiviert. Archiv-ID ${id}.`,
  details: (command) => `Details: ${command}`,
  dueAt: (when) => `fällig ${when}`,
  acknowledgedOpen: " · quittiert, noch offen",
  effect: "Wirkung",
  intent: "Absicht",
  tempRest: "Temp-Rest, sichere Bereinigung nötig",
  receiptPresent: "Quittung vorhanden",
  task: "Aufgabe",
  shortened: (command) => `Gekürzt; Details: ${command}`,
  occurrence: "Vorkommen",
  acknowledge: "Quittieren",
  deliveryPaused: "Zustellung ist stumm/aus; Owner sieht Fälliges hier trotzdem.",
  moreDue: (n) => `Weitere fällige Karten: ${n}; due erneut aufrufen.`,
  noDue:
    "Keine aktuelle fällige Karte. Unscharfe/zurückgestellte/offene Aufgaben und Zustellgründe: bastra tasks status.",
  control: {
    mute: "Stumm geschaltet: Zustellung wird verschoben, nichts erledigt sich.",
    unmute: "Zustellung wieder hörbar; offene Arbeit bleibt erhalten.",
    off: "Funktion aus: keine automatische Auswertung/Zustellung; Aufgaben bleiben gespeichert.",
    on: "Funktion an: Auswertung beim nächsten Kontakt/Job; Ausführungsfreigaben werden nicht erneuert.",
    stop: "Ausführung gestoppt. Erinnern und Vorbereiten bleiben nutzbar.",
    resume:
      "Ausführungsstopp aufgehoben; nur explizit aktivierte Adapter und gültige neue Wirkungskette dürfen schreiben.",
  },
  controlSummary: (enabled, muted, stopped) =>
    `Funktion ${enabled ? "an" : "aus"}, Zustellung ${muted ? "stumm" : "hörbar"}, Ausführung ${stopped ? "gestoppt" : "freigegeben"}. Keine Aufgabe erledigt, keine Freigabe erneuert.`,
  noTasks: "Keine Aufgaben.",
  released: "Reservierung freigegeben. Vorhandene Wirkungsquittungen bleiben erhalten; keine Freigabe erneuert.",
  status: {
    reminderAccess: "Erinnerungszugang: ",
    feature: "Funktion: ",
    automation: (enabled, running) => `Automatik: ${!enabled ? "aus" : running ? "läuft" : "nicht aktiv"}`,
    delivery: "Zustellung: bei nächstem Kontakt",
    muted: "Stumm: ",
    executionStopped: (stopped) =>
      `Ausführung gestoppt: ${stopped ? "ja (auf Nutzeranweisung execution-enable --agent)" : "nein"}`,
    nextCheck: "Nächste Prüfung: ",
    nextCheckOff: "keine, Funktion aus",
    lastDelivery: "Letzte Zustellung: ",
    lastJobError: "Letzter Job-Fehler: ",
    noJobError: "keiner",
    globalBudgets:
      "Globale Budgets: höchstens 10 Quellprüfungen/5s pro Lauf, 60s Poll; Dateizugriff höchstens 1s pro Quelle.",
    archives: "Archive: ",
    archiveTasks: (n) => `${n} Aufgaben`,
    effects: (intents, intentLimit, receipts, receiptLimit) =>
      `Wirkungen: ${intents}/${intentLimit} Absichten · ${receipts}/${receiptLimit} Quittungen`,
    intent: "Absicht",
    target: "Ziel",
    receipt: "Quittung",
    rollback: (available) =>
      `Rückabwicklung ${available ? "mit Nutzerauftrag und frischem Zielabgleich prüfbar" : "nein"}`,
    sources: "Quellen: ",
    adapters: "Adapter: ",
    leases: "Reservierungen: ",
    leaseState: { active: "reserviert", released: "freigegeben", expired: "abgelaufen" },
    leaseUntil: (when) => `bis ${when}`,
    leaseRelease: "eigene Freigabe: bastra tasks release",
    approval: "Freigabe: Nutzeranweisung im Chat · Vertrauensgrenze: lokales Konto",
    chatOrder: "Chat-Auftrag",
    session: "Sitzung",
    authorization: (revoked, denied, consumed) =>
      revoked ? "widerrufen" : denied ? "abgelehnt" : consumed ? "verbraucht" : "erfasst",
  },
  timezoneAssumed: (timezone) => `Zeitzone aus dem System angenommen: ${timezone}. Mit --timezone bewusst festlegen.`,
  uiHint: "(UI aktivieren: bastra config set ui.enabled true)",
  clientValid: "Client-Kennung gültig (Daemon muss laufen)",
  clientNoCards: "Keine Karten für diesen Client",
  authConfirm: "Zugang als Owner am Terminal verwalten? Token-Dateien müssen außerhalb des Agent-Zugriffs liegen.",
  authRevoked: (id) => `Zugang ${id} widerrufen. Dieser Client erhält keine Karten mehr.`,
  authMinted: (role, actor, domains, id) =>
    `Zugang angelegt: ${role === "owner" ? "Owner" : "Agent"} ${actor}, Domänen ${domains}. Token privat in der gewählten Datei; jetzt bastra tasks setup-hooks. Kennung ${id}.`,
  ownerTokenPrompt: "Owner-Aufgaben-Token (verborgen): ",
  ownerLoginConfirm:
    "Owner-Zugang nur für interaktive CLI privat speichern? Dieses Datenverzeichnis muss außerhalb des Agent-Zugriffs liegen; Hooks/MCP bekommen diesen Token nie.",
  ownerLoginDone:
    "Owner-Zugang privat für die interaktive CLI gespeichert. Wird bei jedem Befehl frisch geprüft; Die Anweisung im Chat ist die Ausführungsfreigabe.",
  boundary:
    "Die Vertrauensgrenze ist das lokale Rechnerkonto. Keine zusätzliche Grenzerklärung oder Schlüssel-Freigabe erforderlich.",
  executionEnabled:
    "Lokaler Adapter aktiviert, Ausführungsstopp aufgehoben. Die Nutzeranweisung im Chat ist die Freigabe; Vorschau, Schreibabgleich und Quittung bleiben erforderlich.",
  hooksReady:
    "Karten für lokale Hooks/MCP eingerichtet. Eigene Agent-Kennung; kein Owner-Schlüssel, keine Ausführungsfreigabe. Bei nächstem Kontakt, solange der Daemon läuft. BASTRA_TASK_TOKEN überschreibt diese Konfiguration.",
  recoverConfirm:
    "Backup wiederherstellen? Alle Aufgaben werden unscharf, Ausführung gestoppt; Original wird privat gesichert. Vorher alle Task-Prozesse stoppen.",
  recoverLockConfirm:
    "Auch unbekannte Sperre privat sichern? Ich bestätige ausdrücklich: ALLE Task-Prozesse sind beendet. Bekannte lebende lokale Besitzer werden trotzdem abgewiesen.",
  restoreConfirm: "Archiv für lesbaren Verlauf/Rollback wieder aufnehmen? Bleibt unscharf, Ausführung gestoppt.",
  archiveConfirm: (ids) =>
    `Abgeschlossene Aufgaben ${ids} privat archivieren? Offene Vorkommen/unklare Wirkungen bleiben aktiv; Idempotenz, History und verbrauchte Freigaben bleiben erhalten.`,
  recovered: (exports) =>
    `Älteres Backup wiederhergestellt, Original gesichert. Änderungen seit dem Backup können fehlen; archivierte Aufgaben können wieder aktiv im Verlauf stehen. ${exports} kalte Archiv-Exporte abgeglichen und indiziert. Alle Aufgaben unscharf, Ausführung gestoppt. Daemon neu starten; Original/Archive und Wirkungen prüfen, Owner muss neu prüfen.`,
  restored:
    "Archiv wieder aufgenommen. Historie und Quittungen erhalten; Ausführung gestoppt, keine Freigabe erneuert.",
  archivedDone: (id) =>
    `Abgeschlossene Aufgaben archiviert; offene Arbeit unverändert. Archiv-ID ${id}. Verlauf/Rollback: bastra tasks archive-restore ${id}.`,
  noTargets: "Keine Ziele registriert.",
  targetLine: (id, path, domains) => `Ziel ${id}: ${path}; Domänen ${domains}.`,
  targetRemoveConfirm: "Ziel entfernen? Ausführung stoppen, alte Vorschläge veralten; alte Freigaben werden veraltet.",
  targetRemoved: "Ziel entfernt; Ausführung gestoppt, alte Vorschläge veraltet.",
  targetPreview: (id, path, root, domains) =>
    `Lokales Ziel ${id}: ${path}; aufgelöster Arbeitsordner ${root}; Domänen ${domains}. Adapter ersetzt genau diese UTF-8-Datei, kein Anbieter.`,
  packageScripts:
    "WARNUNG: package.json kann Install-/Test-/Start-Skripte definieren, die später Code ausführen. Exakte Skriptänderungen vor der Freigabe prüfen.",
  outsideWorkdir:
    "WARNUNG: Dieser gewählte Arbeitsordner liegt außerhalb des aktuellen Projektordners. Nur ausdrücklich freigegebene Arbeitsdateien verwenden; Konfiguration, Schlüssel und Vault sind gesperrt.",
  targetConfirm: (update) =>
    `Dieses lokale Ziel ${update ? "ändern" : "registrieren"}? Ausführung wird gestoppt, alte Vorschläge veralten.`,
  targetDone: (id, update) =>
    `Ziel ${id} ${update ? "geändert" : "registriert"}. Ausführung gestoppt. Die Anweisung im Chat ist die Freigabe.`,
  chatConsentQuestion:
    "Darf Recall fällige Aufgaben in deinem aktiven Claude-Code-Chat ankündigen? Das Einschalten von crossSessionInbound=accept erlaubt eingehende Sitzungsnachrichten von allen Programmen unter deinem Mac-Benutzerkonto.",
  chatConsentResult: {
    accepted:
      "Zustellung in den Claude-Chat für neue Sitzungen eingeschaltet. Nachrichten sind Aufgabendaten, nie eine Ausführungsfreigabe; macOS-Mitteilung und Board bleiben verfügbar.",
    blocked:
      "Zustellung in den Claude-Chat bleibt aus: ein bestehendes hold/refuse, ein unbekannter Inbound-Wert oder verwaltete Einstellungen wurden beibehalten. macOS-Mitteilung und Board bleiben verfügbar; diese Einrichtung fragt nicht noch einmal.",
    declined:
      "Zustellung in den Claude-Chat abgelehnt und gespeichert; diese Einrichtung fragt nicht noch einmal. macOS-Mitteilung und Board bleiben verfügbar.",
  },
};

const WORDS: Readonly<Record<string, TaskCliWords>> = { en, de };
export function taskCliWords(language: string | undefined): TaskCliWords {
  return WORDS[language ?? "en"] ?? en;
}
