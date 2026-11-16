/** User-facing task options and plain text output; JSON remains explicit. */
import { randomUUID } from "node:crypto";
import { localWall, ambiguousTaskCalendar, resolveTaskCalendar } from "../task-clock.js";
import { localTaskCardText } from "../task-card-text.js";
/** The task CLI's language. Its questions, lists and results are still written in
 *  German; error and card texts follow the same language so one dialog never mixes
 *  two. Switches to language.primary once the whole task CLI does (#1594 follow-up). */
export const TASK_CLI_LANGUAGE = "de";
export const TASK_VALUE_FLAGS = [
  "--goal",
  "--when",
  "--after",
  "--timezone",
  "--domain",
  "--scope",
  "--resolve-when",
  "--level",
  "--id",
  "--revision",
  "--occurrence",
  "--until",
  "--input",
  "--event-source",
  "--expected",
  "--every",
  "--count",
  "--end",
  "--expires",
  "--root",
  "--path",
  "--sensitivity",
  "--archive",
] as const;
export function parseTaskOptions(argv: string[]) {
  const options: Record<string, string | boolean> = {},
    words: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const word = argv[i];
    if (word.startsWith("--")) {
      const [name, ...rest] = word.split("=");
      const key = name.slice(2);
      if (["arm", "agent", "json", "lock"].includes(key)) options[key] = true;
      else if ((TASK_VALUE_FLAGS as readonly string[]).includes(name)) {
        if (options[key] !== undefined) throw Object.assign(new Error(`Duplicate ${name}`), { code: "validation" });
        options[key] = rest.length ? rest.join("=") : argv[++i];
        if (!options[key]) throw Object.assign(new Error(`${name} needs a value`), { code: "validation" });
      } else throw Object.assign(new Error(`Unknown task option ${name}`), { code: "validation" });
    } else words.push(word);
  }
  return { options, words };
}
export function taskWhen(value: string, timezone: string): number {
  const simple = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (simple) {
    const local = localWall(Date.now(), timezone).slice(0, 10);
    let at = resolveTaskCalendar(`${local}T${simple[1].padStart(2, "0")}:${simple[2]}:00`, timezone).at;
    if (at <= Date.now()) {
      const nextDay = new Date(Date.parse(`${local}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      at = resolveTaskCalendar(`${nextDay}T${simple[1].padStart(2, "0")}:${simple[2]}:00`, timezone).at;
    }
    return at;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value))
    return resolveTaskCalendar(value.length === 16 ? value + ":00" : value, timezone).at;
  if (!/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw Object.assign(new Error("Ortszeit als YYYY-MM-DDTHH:mm mit --timezone oder ISO-Zeit mit Offset angeben"), {
      code: "validation",
    });
  return Date.parse(value);
}
export function friendlyTaskCreate(options: Record<string, string | boolean>, now = Date.now()) {
  const goal = String(options.goal ?? ""),
    timezone = String(options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
    domain = String(options.domain ?? "personal");
  if (!goal || ["when", "after", "event-source"].filter((k) => options[k]).length !== 1)
    throw Object.assign(
      new Error("Anlegen braucht --goal und genau einen Auslöser: --when, --after oder --event-source"),
      { code: "validation" }
    );
  let schedule: unknown;
  if (options.after) {
    const match = /^(\d+)(m|h|d|w)$/.exec(String(options.after));
    if (!match) throw Object.assign(new Error("Dauer mit --after 30m, 2h, 7d oder 2w angeben"), { code: "validation" });
    const duration = Number(match[1]) * { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[match[2]]!;
    if (!Number.isSafeInteger(duration) || duration <= 0)
      throw Object.assign(new Error("Dauer muss positiv sein und im zulässigen Bereich liegen"), {
        code: "validation",
      });
    schedule = { kind: "duration", reference_at: now, duration_ms: duration, at: now + duration };
  } else if (options["event-source"]) {
    if (!options.expected)
      throw Object.assign(new Error("Ereignisüberwachung braucht --expected und eine vom Owner registrierte Quelle"), {
        code: "validation",
      });
    schedule = { kind: "event", source_id: options["event-source"], predicate: "equals", expected: options.expected };
  } else {
    const when = String(options.when);
    schedule = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(when)
      ? {
          kind: "calendar",
          local_time: when.length === 16 ? when + ":00" : when,
          timezone,
          gap: "reject",
          overlap: "earlier",
          ...resolveTaskCalendar(when.length === 16 ? when + ":00" : when, timezone),
        }
      : { kind: "instant", at: taskWhen(when, timezone) };
  }
  let recurrence: object | undefined;
  if (options.every) {
    const match = /^(\d+)(m|h|d|w)$/.exec(String(options.every));
    if (!match || Number(match[1]) <= 0)
      throw Object.assign(new Error("--every: zum Beispiel 1d oder 1w"), { code: "validation" });
    const calendar = (schedule as { kind: string }).kind === "calendar";
    if (calendar && !["d", "w"].includes(match[2]))
      throw Object.assign(new Error("Kalender-Wiederholung braucht Tage/Wochen"), { code: "validation" });
    recurrence = {
      kind: calendar ? "calendar" : "elapsed",
      interval:
        Number(match[1]) *
        (calendar ? (match[2] === "w" ? 7 : 1) : { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[match[2]]!),
      catch_up: "latest",
      ...(options.count ? { count: Number(options.count) } : {}),
      ...(options.end ? { until: taskWhen(String(options.end), timezone) } : {}),
    };
  }
  const agentNotify = options.agent === true;
  const ambiguous =
    (schedule as any).kind === "calendar" && ambiguousTaskCalendar((schedule as any).local_time, timezone);
  if (agentNotify && ambiguous)
    throw Object.assign(new Error("Mehrdeutige Ortszeit: erst den genauen Zeitpunkt bestätigen"), {
      code: "validation",
    });
  return {
    ...(options.expires ? { expires_at: taskWhen(String(options.expires), timezone) } : {}),
    ...(options.agent
      ? { origin: { kind: "user-request", client: "cli", session: "local-terminal", context: goal } }
      : {}),
    ...(recurrence ? { recurrence } : {}),
    idempotency_key: randomUUID(),
    original_request: goal,
    goal,
    resolution_condition: String(options["resolve-when"] ?? "Owner bestätigt Erledigung"),
    schedule,
    timezone,
    scope: { kind: "personal", name: String(options.scope ?? domain.split(",")[0]) },
    owner_domains: domain.split(","),
    action_level: String(options.level ?? "notify"),
    arm: (options.arm === true || agentNotify) && !ambiguous,
  };
}
export const friendlyWhyNow = (why: string) =>
  why.startsWith("Registered condition")
    ? "Der Auslöser ist fällig. Zeitablauf bestätigt kein Messergebnis."
    : localTaskCardText(why, TASK_CLI_LANGUAGE);
const agentAccessHint = (access: { reason: string; hint: string }) => accessHint[access.reason] ?? access.hint;
const accessHint: Record<string, string> = {
  disabled: "Gesprächserinnerungen sind ausgeschaltet.",
  "unsafe-or-corrupt":
    "Erinnerungszugang beschädigt oder zu offen; Karten bleiben stumm. Owner: bastra tasks setup-hooks.",
  missing: "Erinnerungszugang fehlt. Daemon starten; falls weiterhin fehlend: bastra tasks setup-hooks.",
  ready: "Bei nächstem Kontakt, solange der Daemon läuft.",
  "owner-not-for-agents": "Owner-Zugang nicht für automatische Agent-Karten verwenden.",
  "revoked-or-invalid": "Erinnerungszugang widerrufen/ungültig; Karten bleiben stumm. Owner: bastra tasks setup-hooks.",
};
const reviewName: Record<string, string> = {
  "Explicit owner review required": "Owner muss ausdrücklich scharf schalten.",
  "Owner review required before arming": "Owner muss ausdrücklich scharf schalten.",
  "Edited binding requires explicit owner review": "Bearbeitet; Owner muss neu prüfen.",
  "Recovered snapshot requires owner review": "Wiederhergestellt; Owner muss neu prüfen.",
};
const quote = (value: unknown) => JSON.stringify(String(value ?? ""));
const levelName: Record<string, string> = {
  notify: "erinnern",
  prepare: "vorbereiten",
  execute: "ausführen (Anweisung im Chat)",
};
export const taskStateName: Record<string, string> = {
  pending: "offen",
  due: "fällig",
  snoozed: "zurückgestellt",
  resolved: "erledigt",
  cancelled: "abgebrochen",
  expired: "abgelaufen",
};
export function taskDisplayTime(value: number | undefined, timezone = "Europe/Madrid") {
  return value === undefined
    ? "noch keine"
    : new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(
        new Date(value)
      );
}
/** One CLI text by language; an unlisted language gets English. */
type TaskCliText = Readonly<{ en: string } & Record<string, string>>;
const inLanguage = (text: TaskCliText, language: string | undefined) => text[language ?? "en"] ?? text.en;
const TASKS_PREFIX: TaskCliText = { en: "Tasks", de: "Aufgaben" };
const TASK_ERROR_FALLBACK: TaskCliText = {
  en: "Operation not possible. Check the current state with bastra tasks status.",
  de: "Vorgang nicht möglich. Aktuellen Stand mit bastra tasks status prüfen.",
};
const TASK_ERROR_REASONS: Record<string, TaskCliText> = {
  calendar_gap: {
    de: "Diese Ortszeit existiert wegen der Sommerzeit-Umstellung nicht. Andere Uhrzeit wählen.",
    en: "This local time does not exist because of a daylight saving change. Choose another time.",
  },
  recurrence_limit_required: {
    de: "Wiederholung braucht --count oder --end.",
    en: "A repetition needs --count or --end.",
  },
  snooze_past: {
    de: "Die Zielzeit liegt in der Vergangenheit. Eine zukünftige Zielzeit wählen.",
    en: "The target time is in the past. Choose a future time.",
  },
  owner_declined: { de: "Nicht bestätigt. Nichts geändert.", en: "Not confirmed. Nothing changed." },
  owner_terminal_required: {
    de: "Dieser Befehl braucht ein interaktives Terminal für den Owner-Zugang. Ohne Terminal: --agent mit dem Agent-Zugang verwenden.",
    en: "This command needs an interactive terminal for owner access. Without a terminal, use --agent with the agent access.",
  },
  targets_syntax: {
    de: "Syntax: bastra tasks targets register|update ID --root ARBEITSORDNER --path DATEI --domain DOMÄNE; targets remove ID.",
    en: "Syntax: bastra tasks targets register|update ID --root WORKFOLDER --path FILE --domain DOMAIN; targets remove ID.",
  },
  target_path_missing: {
    de: "Wurzel oder Zieldatei fehlt bzw. ist nicht lesbar. Vorhandenen Arbeitsordner und Datei wählen.",
    en: "The root or target file is missing or not readable. Choose an existing work folder and file.",
  },
  target_boundary: {
    de: "Ziel liegt außerhalb des gewählten Arbeitsordners oder hat eine Symlink-Grenze.",
    en: "The target is outside the chosen work folder or crosses a symlink.",
  },
  target_protected: {
    de: "Dieser Ort ist gesperrt: Aufgaben/Schlüssel, Vault, Client-/Hook-/Dienst-Konfiguration, Git-Steuerung, automatische Ausführungsorte oder Shell-Profil. Separaten Arbeitsordner wählen.",
    en: "This location is protected: tasks/keys, vault, client/hook/service configuration, Git control, automatic run locations or shell profile. Choose a separate work folder.",
  },
};
const TASK_ERRORS: Record<string, TaskCliText> = {
  owner_cache_invalid: {
    de: "Die private Owner-Ablage ist ungültig oder nicht ausreichend geschützt. Mit bastra tasks owner-login erneuern.",
    en: "The private owner store is invalid or not protected enough. Renew it with bastra tasks owner-login.",
  },
  not_found: {
    de: "Aufgabe oder Vorkommen unbekannt. Prüfe die ID mit bastra tasks list.",
    en: "Unknown task or occurrence. Check the ID with bastra tasks list.",
  },
  conflict: {
    de: "Der Stand hat sich geändert oder die Aufgabe ist bereits beendet. Mit bastra tasks get <id> neu laden.",
    en: "The state changed or the task has already ended. Reload it with bastra tasks get <id>.",
  },
  validation: {
    de: "Eingabe nicht lesbar. Beispiel: --after 7d oder --when 2026-10-12T18:00 --timezone Europe/Madrid.",
    en: "Input not readable. Example: --after 7d or --when 2026-10-12T18:00 --timezone Europe/Madrid.",
  },
  unauthorized: {
    de: "Zugang fehlt oder wurde widerrufen. Zuerst Owner-Zugang anlegen, dann bastra tasks setup-hooks.",
    en: "Access is missing or was revoked. Create owner access first, then run bastra tasks setup-hooks.",
  },
  forbidden: {
    de: "Zugang oder Domänen reichen für diese Operation nicht aus. task_status zeigt die zugewiesenen Bereiche.",
    en: "Access or domains are not sufficient for this operation. task_status shows the assigned areas.",
  },
  protected_boundary_required: {
    de: "Nutzeranweisung im Chat erfassen und das registrierte lokale Ziel prüfen. Keine Schlüssel- oder Zusatzbestätigung erforderlich.",
    en: "Record the user's instruction from the chat and check the registered local target. No key or extra confirmation is needed.",
  },
  approval_stale: {
    de: "Die Freigabe passt nicht mehr zum aktuellen Stand. Aufgabe/Vorschlag neu laden und erneut prüfen.",
    en: "The approval no longer matches the current state. Reload the task or proposal and check it again.",
  },
  approval_expired: {
    de: "Bindung abgelaufen. Gegen den aktuellen Stand neu vorbereiten und den bestehenden Nutzerauftrag übernehmen.",
    en: "The binding expired. Prepare again against the current state and carry over the existing user instruction.",
  },
  approval_revoked: {
    de: "Freigabe widerrufen. Es wird nichts geschrieben.",
    en: "Approval revoked. Nothing is written.",
  },
  approval_denied: {
    de: "Dieser Vorschlag wurde abgelehnt. Es wird nichts geschrieben.",
    en: "This proposal was declined. Nothing is written.",
  },
  key_unlock_failed: {
    de: "Der Owner-Schlüssel konnte mit dieser Passphrase nicht entsperrt werden.",
    en: "The owner key could not be unlocked with this passphrase.",
  },
  adapter_not_reversible: {
    de: "Der Vorzustand ist mit diesem Referenzadapter nicht rückrollbar (z. B. Tab/CRLF/BOM oder mehr als 16384 Zeichen). Nichts geändert.",
    en: "The previous state cannot be rolled back with this reference adapter (for example tab/CRLF/BOM or more than 16384 characters). Nothing changed.",
  },
  capacity: {
    de: "Aufgabenspeicher voll. Owner muss abgeschlossene Einträge archivieren; offene Arbeit bleibt erhalten.",
    en: "Task store is full. The owner needs to archive finished entries; open work is kept.",
  },
  adapter_disabled: {
    de: "Lokaler Adapter ist aus. Auf Nutzeranweisung mit bastra tasks execution-enable --agent aktivieren.",
    en: "The local adapter is off. On the user's instruction, turn it on with bastra tasks execution-enable --agent.",
  },
  execution_stopped: {
    de: "Ausführung gestoppt. Auf Nutzeranweisung mit execution-enable --agent fortsetzen; einen ausdrücklichen Stopp beachten.",
    en: "Execution is stopped. On the user's instruction, continue with execution-enable --agent; respect an explicit stop.",
  },
  lease_busy: {
    de: "Diese Ausführung ist bereits reserviert (höchstens 30 Sekunden). Mit bastra tasks status die Reservierungs-ID prüfen; eigene Reservierung mit bastra tasks release ID freigeben oder Ablauf abwarten. Vor erneutem Schreiben Wirkungsstatus prüfen.",
    en: "This execution is already reserved (at most 30 seconds). Check the reservation ID with bastra tasks status; release your own reservation with bastra tasks release ID or wait for it to expire. Check the outcome before writing again.",
  },
  lease_expired: {
    de: "Die Ausführungsreservierung ist abgelaufen. Neu prüfen und reservieren.",
    en: "The execution reservation expired. Check again and reserve again.",
  },
  corrupt: {
    de: "Aufgabenspeicher beschädigt; nichts überschrieben. Owner-Recovery nach Stoppen der Task-Prozesse erforderlich.",
    en: "Task store is damaged; nothing was overwritten. Owner recovery is needed after stopping the task processes.",
  },
  unavailable: {
    de: "Daemon oder Zugang nicht erreichbar. bastra tasks client-status und bastra tasks status prüfen.",
    en: "Daemon or access not reachable. Check bastra tasks client-status and bastra tasks status.",
  },
  lock_unavailable: {
    de: "Ein anderer Vorgang hält den Aufgabenspeicher gesperrt. Nichts überschrieben. Task-Prozesse stoppen; für unbekannte verwaiste Sperren am Owner-Terminal: bastra tasks recover --lock.",
    en: "Another operation holds the task store lock. Nothing was overwritten. Stop the task processes; for an unknown orphaned lock, at the owner terminal: bastra tasks recover --lock.",
  },
};
/** CLI error text for a person, in `language` (English when unlisted). */
export function friendlyTaskError(code: string, sub: string | null, reason?: string, language?: string): string {
  const prefix = sub ?? inLanguage(TASKS_PREFIX, language);
  const reasonText = reason ? TASK_ERROR_REASONS[reason] : undefined;
  return `${prefix}: ${inLanguage(reasonText ?? TASK_ERRORS[code] ?? TASK_ERROR_FALLBACK, language)}`;
}
export function friendlyVerification(t: any): string {
  const names: Record<string, string> = {
    verified: "bestätigt",
    refuted: "Prämisse geändert",
    inconclusive: "unklar/strittig",
    unavailable: "nicht erreichbar",
    stale: "veraltet",
  };
  const reasons: Record<string, string> = {
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
  };
  return t.verification
    ? `${names[t.verification.outcome] ?? "nicht bestätigt"}${reasons[t.verification.reason] ? ` – ${reasons[t.verification.reason]}` : ""}; geprüft ${taskDisplayTime(t.verification.checked_at, t.timezone)}`
    : t.schedule.kind === "event"
      ? "wartet auf erstes Ereignis"
      : "noch nicht geprüft";
}
export const actionStateName: Record<string, string> = {
  pending: "offen, Abgleich nötig",
  succeeded: "Wirkung bestätigt",
  reconciled: "Zielstand abgeglichen",
  unknown: "Ausgang unklar, Abgleich nötig",
  failed: "fehlgeschlagen",
};
export function friendlyTaskResult(sub: string, result: any): string {
  const taskLine = (t: any) => {
    const when =
      t.schedule.kind === "event"
        ? `Ereignis ${quote(t.schedule.source_id)}`
        : taskDisplayTime(t.schedule.at, t.timezone);
    return (
      `${quote(t.goal)} · ${when} · ${t.timezone} · ${t.armed ? "scharf" : "unscharf"} · ${t.paused ? "pausiert" : (taskStateName[t.state] ?? t.state)} · ${levelName[t.action_level] ?? t.action_level}\n  ID ${t.id}` +
      (t.schedule.kind === "calendar" && ambiguousTaskCalendar(t.schedule.local_time, t.timezone)
        ? "\n  Mehrdeutige Ortszeit: früherer Zeitpunkt gewählt. Owner muss diese Wahl mit review prüfen."
        : "") +
      (t.expires_at !== undefined
        ? `\n  Gültig bis ${taskDisplayTime(t.expires_at, t.timezone)} (${t.timezone})`
        : "") +
      (t.state === "snoozed"
        ? `\n  Zurückgestellt bis ${taskDisplayTime(t.snoozed_until, t.timezone)} (${t.timezone})`
        : "") +
      (t.recurrence
        ? `\n  Wiederholung: ${t.recurrence.kind === "calendar" ? "Kalendertage" : "verstrichene Dauer"}; ${t.recurrence.count !== undefined ? `Anzahl ${t.recurrence.count}` : t.recurrence.until !== undefined ? `bis ${taskDisplayTime(t.recurrence.until, t.timezone)}` : "ohne Ende"}`
        : "") +
      (sub === "rearm"
        ? "\n  Wieder zur Prüfung vorgelegt, UNSCHARF. Scharf schalten: bastra tasks review <id>."
        : "") +
      (t.last_failure
        ? `\n  Letzter Aufgabenfehler: ${t.last_failure.code === "source_unavailable" ? "Quelle nicht erreichbar" : t.last_failure.message}`
        : "") +
      (t.budget
        ? `\n  Budget: Prüfung frühestens alle ${t.budget.poll_interval_ms / 1000}s; Timeout ${t.budget.timeout_ms}ms; Quelle höchstens ${t.budget.max_source_bytes} Bytes.`
        : "") +
      `\n  Quellenprüfung: ${friendlyVerification(t)}` +
      (t.review_reason ? `\n  Prüfung: ${quote(reviewName[t.review_reason] ?? t.review_reason)}` : "")
    );
  };
  if (sub === "delete") return `Aufgabe ${result.id} gelöscht.`;
  if (sub === "archive") return `Aufgaben archiviert. Archiv-ID ${result.archive_id}.`;
  if (sub === "due")
    return result.cards.length
      ? result.cards
          .map((c: any) =>
            c.kind === "availability"
              ? `${friendlyWhyNow(c.summary)} Details: ${c.detail_command}`
              : `${quote(c.goal)} · fällig ${taskDisplayTime(c.due_at, c.timezone)} · ${c.timezone}${c.acknowledged ? " · quittiert, noch offen" : ""}\n  ${quote(friendlyWhyNow(c.why_now))}${c.action_outcome ? `\n  Wirkung: ${actionStateName[c.action_outcome.receipt_outcome ?? c.action_outcome.state] ?? c.action_outcome.state} · Absicht ${c.action_outcome.intent_id} · ${c.action_outcome.temp_cleanup_pending ? "Temp-Rest, sichere Bereinigung nötig · " : ""}${friendlyWhyNow(c.action_outcome.review_hint ?? actionStateName[c.action_outcome.receipt_outcome] ?? "Quittung vorhanden")}` : ""}\n  Aufgabe ${c.task_id}${c.compact ? `\n  Gekürzt; Details: ${c.detail_command}` : ""}\n  Vorkommen ${c.occurrence_id}\n  Quittieren: bastra tasks acknowledge ${c.task_id} --occurrence ${c.occurrence_id}${c.presentation === "owner-inspection-delivery-paused" ? "\n  Zustellung ist stumm/aus; Owner sieht Fälliges hier trotzdem." : ""}`
          )
          .join("\n\n") + (result.overflow ? `\nWeitere fällige Karten: ${result.overflow}; due erneut aufrufen.` : "")
      : "Keine aktuelle fällige Karte. Unscharfe/zurückgestellte/offene Aufgaben und Zustellgründe: bastra tasks status.";
  if (result.controls && result.resumed_authority === false) {
    const messages: Record<string, string> = {
      mute: "Stumm geschaltet: Zustellung wird verschoben, nichts erledigt sich.",
      unmute: "Zustellung wieder hörbar; offene Arbeit bleibt erhalten.",
      off: "Funktion aus: keine automatische Auswertung/Zustellung; Aufgaben bleiben gespeichert.",
      on: "Funktion an: Auswertung beim nächsten Kontakt/Job; Ausführungsfreigaben werden nicht erneuert.",
      stop: "Ausführung gestoppt. Erinnern und Vorbereiten bleiben nutzbar.",
      resume:
        "Ausführungsstopp aufgehoben; nur explizit aktivierte Adapter und gültige neue Wirkungskette dürfen schreiben.",
    };
    return (
      messages[sub] ??
      `Funktion ${result.controls.enabled ? "an" : "aus"}, Zustellung ${result.controls.muted ? "stumm" : "hörbar"}, Ausführung ${result.controls.execution_stopped ? "gestoppt" : "freigegeben"}. Keine Aufgabe erledigt, keine Freigabe erneuert.`
    );
  }
  if (sub === "status") {
    const counts = Object.keys(taskStateName)
      .map((state) => `${taskStateName[state]}: ${result.tasks.filter((t: any) => t.state === state).length}`)
      .join(" · ");
    const attempts = result.tasks
      .flatMap((t: any) => t.deliveries.map((d: any) => ({ at: d.last_attempt, timezone: t.timezone })))
      .filter((d: any) => d.at)
      .sort((a: any, b: any) => b.at - a.at);
    return `${result.agent_access ? "Erinnerungszugang: " + agentAccessHint(result.agent_access) + "\n" : ""}Funktion: ${result.controls.enabled ? "an" : "aus"} · Automatik: ${!result.controls.enabled ? "aus" : result.runtime.running ? "läuft" : "nicht aktiv"} · Zustellung: bei nächstem Kontakt\nStumm: ${result.controls.muted ? "ja" : "nein"} · Ausführung gestoppt: ${result.controls.execution_stopped ? "ja (auf Nutzeranweisung execution-enable --agent)" : "nein"}\n${counts}\nNächste Prüfung: ${result.controls.enabled ? taskDisplayTime(result.runtime.next_tick || undefined) : "keine, Funktion aus"}\nLetzte Zustellung: ${attempts.length ? taskDisplayTime(attempts[0].at, attempts[0].timezone) + " " + attempts[0].timezone : "noch keine"}\nLetzter Job-Fehler: ${result.runtime.last_error ?? "keiner"} · Backoff: ${result.runtime.backoff_ms ?? 0} ms\nGlobale Budgets: höchstens 10 Quellprüfungen/5s pro Lauf, 60s Poll; Dateizugriff höchstens 1s pro Quelle.\nArchive: ${result.archives?.map((a: any) => `${a.id} (${a.task_count} Aufgaben)`).join(", ") || "keine"}\nWirkungen: ${result.capacity.intents}/${result.capacity.intent_limit} Absichten · ${result.capacity.receipts}/${result.capacity.receipt_limit} Quittungen\n${result.intents.map((i: any) => `Absicht ${i.id}: ${actionStateName[i.state] ?? i.state}${i.temp_cleanup_pending ? " · Temp-Rest, sichere Bereinigung nötig" : ""}${i.review_hint ? ` · ${friendlyWhyNow(i.review_hint)}` : ""}; Ziel ${i.target_id}`).join("\n")}\n${result.receipts.map((r: any) => `Quittung ${r.id}: ${actionStateName[r.outcome] ?? r.outcome}; Ziel ${r.target_id}; Rückabwicklung ${r.rollback_available ? "mit Nutzerauftrag und frischem Zielabgleich prüfbar" : "nein"}`).join("\n")}\nQuellen: ${result.sources.map((s: any) => `${s.id} ${s.enabled ? "an" : "aus"}`).join(", ") || "keine"}\nAdapter: ${result.adapters.map((a: any) => `${a.id} ${a.enabled ? "an" : "aus"}`).join(", ") || "keine"}\nReservierungen: ${result.leases?.map((l: any) => `${l.id} · ${l.state === "active" ? "reserviert" : l.state === "released" ? "freigegeben" : "abgelaufen"}; bis ${taskDisplayTime(l.expires_at)}; eigene Freigabe: bastra tasks release ${l.id}`).join("\n") || "keine"}\nFreigabe: Nutzeranweisung im Chat · Vertrauensgrenze: lokales Konto\n${(result.authorizations ?? []).map((row: any) => `Chat-Auftrag ${row.task_id}: ${quote(row.authorization.user_request)} · ${quote(row.authorization.program)} · Sitzung ${quote(row.authorization.session_id)} · ${taskDisplayTime(row.authorization.at)} · ${row.revoked_at !== undefined ? "widerrufen" : row.decision === "deny" ? "abgelehnt" : row.consumed ? "verbraucht" : "erfasst"}`).join("\n")}\n${result.tasks.length ? result.tasks.map(taskLine).join("\n\n") : "Keine Aufgaben."}`;
  }
  if (result.tasks) return result.tasks.length ? result.tasks.map(taskLine).join("\n\n") : "Keine Aufgaben.";
  if (result.schedule) return taskLine(result);
  if (result.released)
    return "Reservierung freigegeben. Vorhandene Wirkungsquittungen bleiben erhalten; keine Freigabe erneuert.";
  if (result.task) return taskLine(result.task);
  return JSON.stringify(result, null, 2);
}
