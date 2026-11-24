/** User-facing task options and plain text output; JSON remains explicit. */
import { randomUUID } from "node:crypto";
import { localWall, ambiguousTaskCalendar, resolveTaskCalendar } from "../task-clock.js";
import { localTaskCardText } from "../task-card-text.js";
import { inLanguage, taskCliWords, type TaskCliText } from "./task-cli-words.js";
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
/** CLI input errors carry a stable reason; the person reads it in the CLI's language. */
function invalidInput(reason: string, message: string): never {
  throw Object.assign(new Error(message), { code: "validation", reason });
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
    invalidInput("time_format", "Use local time as YYYY-MM-DDTHH:mm with --timezone, or ISO time with an offset");
  return Date.parse(value);
}
export function friendlyTaskCreate(options: Record<string, string | boolean>, now = Date.now()) {
  const goal = String(options.goal ?? ""),
    timezone = String(options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
    domain = String(options.domain ?? "personal");
  if (!goal || ["when", "after", "event-source"].filter((k) => options[k]).length !== 1)
    invalidInput(
      "create_trigger_required",
      "Create needs --goal and exactly one trigger: --when, --after or --event-source"
    );
  let schedule: unknown;
  if (options.after) {
    const match = /^(\d+)(m|h|d|w)$/.exec(String(options.after));
    if (!match) invalidInput("duration_format", "Give the duration as --after 30m, 2h, 7d or 2w");
    const duration = Number(match[1]) * { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[match[2]]!;
    if (!Number.isSafeInteger(duration) || duration <= 0)
      invalidInput("duration_range", "The duration must be positive and within range");
    schedule = { kind: "duration", reference_at: now, duration_ms: duration, at: now + duration };
  } else if (options["event-source"]) {
    if (!options.expected)
      invalidInput("event_expected_required", "Event watching needs --expected and a source registered by the owner");
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
    if (!match || Number(match[1]) <= 0) invalidInput("every_format", "--every: for example 1d or 1w");
    const calendar = (schedule as { kind: string }).kind === "calendar";
    if (calendar && !["d", "w"].includes(match[2]))
      invalidInput("calendar_every_unit", "A calendar repetition needs days or weeks");
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
    invalidInput("ambiguous_local_time", "Ambiguous local time: confirm the exact instant first");
  return {
    ...(options.expires ? { expires_at: taskWhen(String(options.expires), timezone) } : {}),
    ...(options.agent
      ? { origin: { kind: "user-request", client: "cli", session: "local-terminal", context: goal } }
      : {}),
    ...(recurrence ? { recurrence } : {}),
    idempotency_key: randomUUID(),
    original_request: goal,
    goal,
    resolution_condition: String(options["resolve-when"] ?? "Owner confirms completion"),
    schedule,
    timezone,
    scope: { kind: "personal", name: String(options.scope ?? domain.split(",")[0]) },
    owner_domains: domain.split(","),
    action_level: String(options.level ?? "notify"),
    arm: (options.arm === true || agentNotify) && !ambiguous,
  };
}
const friendlyWhyNow = (why: string, language?: string) =>
  why.startsWith("Registered condition") ? taskCliWords(language).whyNowRegistered : localTaskCardText(why, language);
const quote = (value: unknown) => JSON.stringify(String(value ?? ""));
function taskDisplayTime(value: number | undefined, timezone = "Europe/Madrid", language?: string) {
  const w = taskCliWords(language);
  return value === undefined
    ? w.noneYet
    : new Intl.DateTimeFormat(w.locale, { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(
        new Date(value)
      );
}
const TASKS_PREFIX: TaskCliText = { en: "Tasks", de: "Aufgaben" };
const TASK_ERROR_FALLBACK: TaskCliText = {
  en: "Operation not possible. Check the current state with bastra tasks status.",
  de: "Vorgang nicht möglich. Aktuellen Stand mit bastra tasks status prüfen.",
};
const TASK_ERROR_REASONS: Record<string, TaskCliText> = {
  time_format: {
    de: "Ortszeit als YYYY-MM-DDTHH:mm mit --timezone oder ISO-Zeit mit Offset angeben.",
    en: "Give local time as YYYY-MM-DDTHH:mm with --timezone, or ISO time with an offset.",
  },
  create_trigger_required: {
    de: "Anlegen braucht --goal und genau einen Auslöser: --when, --after oder --event-source.",
    en: "Create needs --goal and exactly one trigger: --when, --after or --event-source.",
  },
  duration_format: {
    de: "Dauer mit --after 30m, 2h, 7d oder 2w angeben.",
    en: "Give the duration as --after 30m, 2h, 7d or 2w.",
  },
  duration_range: {
    de: "Dauer muss positiv sein und im zulässigen Bereich liegen.",
    en: "The duration must be positive and within the allowed range.",
  },
  event_expected_required: {
    de: "Ereignisüberwachung braucht --expected und eine vom Owner registrierte Quelle.",
    en: "Watching an event needs --expected and a source registered by the owner.",
  },
  every_format: { de: "--every: zum Beispiel 1d oder 1w.", en: "--every: for example 1d or 1w." },
  calendar_every_unit: {
    de: "Kalender-Wiederholung braucht Tage/Wochen.",
    en: "A calendar repetition needs days or weeks.",
  },
  ambiguous_local_time: {
    de: "Mehrdeutige Ortszeit: erst den genauen Zeitpunkt bestätigen.",
    en: "Ambiguous local time: confirm the exact instant first.",
  },
  input_file_unreadable: {
    de: "Die Eingabedatei fehlt, ist nicht lesbar oder enthält kein gültiges JSON (höchstens 256 KiB).",
    en: "The input file is missing, not readable or not valid JSON (at most 256 KiB).",
  },
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
  unknown_task_operation: { de: "Unbekannter Unterbefehl.", en: "Unknown subcommand." },
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
function friendlyVerification(t: any, language?: string): string {
  const w = taskCliWords(language);
  const reason = w.verificationReason[t.verification?.reason];
  return t.verification
    ? `${w.verificationName[t.verification.outcome] ?? w.notConfirmed}${reason ? ` – ${reason}` : ""}; ${w.checked(taskDisplayTime(t.verification.checked_at, t.timezone, language))}`
    : t.schedule.kind === "event"
      ? w.waitingFirstEvent
      : w.notChecked;
}
export function friendlyTaskResult(sub: string, result: any, language?: string): string {
  const w = taskCliWords(language),
    time = (value: number | undefined, timezone?: string) => taskDisplayTime(value, timezone, language),
    whyNow = (why: string) => friendlyWhyNow(why, language),
    line = (text: string) => `\n  ${text}`;
  const taskLine = (t: any) => {
    const when = t.schedule.kind === "event" ? w.event(quote(t.schedule.source_id)) : time(t.schedule.at, t.timezone);
    const bound =
      t.recurrence?.count !== undefined
        ? w.count(t.recurrence.count)
        : t.recurrence?.until !== undefined
          ? w.until(time(t.recurrence.until, t.timezone))
          : w.noEnd;
    return (
      `${quote(t.goal)} · ${when} · ${t.timezone} · ${w.armed(t.armed)} · ${t.paused ? w.paused : (w.stateName[t.state] ?? t.state)} · ${w.levelName[t.action_level] ?? t.action_level}\n  ID ${t.id}` +
      (t.schedule.kind === "calendar" && ambiguousTaskCalendar(t.schedule.local_time, t.timezone)
        ? line(w.ambiguous)
        : "") +
      (t.expires_at !== undefined ? line(w.validUntil(time(t.expires_at, t.timezone), t.timezone)) : "") +
      (t.state === "snoozed" ? line(w.snoozedUntil(time(t.snoozed_until, t.timezone), t.timezone)) : "") +
      (t.recurrence ? line(w.recurrence(t.recurrence.kind === "calendar", bound)) : "") +
      (sub === "rearm" ? line(w.rearmed) : "") +
      (t.last_failure
        ? line(
            w.lastFailure(t.last_failure.code === "source_unavailable" ? w.sourceUnreachable : t.last_failure.message)
          )
        : "") +
      (t.budget
        ? line(w.budget(t.budget.poll_interval_ms / 1000, t.budget.timeout_ms, t.budget.max_source_bytes))
        : "") +
      line(w.sourceCheck(friendlyVerification(t, language))) +
      (t.review_reason ? line(w.review(quote(w.reviewName[t.review_reason] ?? whyNow(t.review_reason)))) : "")
    );
  };
  if (sub === "delete") return w.deleted(result.id);
  if (sub === "archive") return w.archived(result.archive_id);
  if (sub === "due")
    return result.cards.length
      ? result.cards
          .map((c: any) =>
            c.kind === "availability"
              ? `${whyNow(c.summary)} ${w.details(c.detail_command)}`
              : `${quote(c.goal)} · ${w.dueAt(time(c.due_at, c.timezone))} · ${c.timezone}${c.acknowledged ? w.acknowledgedOpen : ""}\n  ${quote(whyNow(c.why_now))}${c.action_outcome ? `\n  ${w.effect}: ${w.actionState[c.action_outcome.receipt_outcome ?? c.action_outcome.state] ?? c.action_outcome.state} · ${w.intent} ${c.action_outcome.intent_id} · ${c.action_outcome.temp_cleanup_pending ? `${w.tempRest} · ` : ""}${whyNow(c.action_outcome.review_hint ?? w.actionState[c.action_outcome.receipt_outcome] ?? w.receiptPresent)}` : ""}\n  ${w.task} ${c.task_id}${c.compact ? line(w.shortened(c.detail_command)) : ""}\n  ${w.occurrence} ${c.occurrence_id}\n  ${w.acknowledge}: bastra tasks acknowledge ${c.task_id} --occurrence ${c.occurrence_id}${c.presentation === "owner-inspection-delivery-paused" ? line(w.deliveryPaused) : ""}`
          )
          .join("\n\n") + (result.overflow ? `\n${w.moreDue(result.overflow)}` : "")
      : w.noDue;
  if (result.controls && result.resumed_authority === false)
    return (
      w.control[sub] ??
      w.controlSummary(result.controls.enabled, result.controls.muted, result.controls.execution_stopped)
    );
  if (sub === "status") return statusText(result, language, taskLine);
  if (result.tasks) return result.tasks.length ? result.tasks.map(taskLine).join("\n\n") : w.noTasks;
  if (result.schedule) return taskLine(result);
  if (result.released) return w.released;
  if (result.task) return taskLine(result.task);
  return JSON.stringify(result, null, 2);
}
/** `bastra tasks status` for a person, in the CLI's language. */
function statusText(result: any, language: string | undefined, taskLine: (t: any) => string): string {
  const w = taskCliWords(language),
    st = w.status,
    time = (value: number | undefined, timezone?: string) => taskDisplayTime(value, timezone, language),
    list = (rows: string[], separator = ", ") => rows.join(separator) || w.none;
  const counts = Object.keys(w.stateName)
    .map((state) => `${w.stateName[state]}: ${result.tasks.filter((t: any) => t.state === state).length}`)
    .join(" · ");
  const attempts = result.tasks
    .flatMap((t: any) => t.deliveries.map((d: any) => ({ at: d.last_attempt, timezone: t.timezone })))
    .filter((d: any) => d.at)
    .sort((a: any, b: any) => b.at - a.at);
  const c = result.controls;
  return [
    ...(result.agent_access
      ? [st.reminderAccess + (w.accessHint[result.agent_access.reason] ?? result.agent_access.hint)]
      : []),
    `${st.feature}${w.onOff(c.enabled)} · ${st.automation(c.enabled, result.runtime.running)} · ${st.delivery}`,
    `${st.muted}${w.yesNo(c.muted)} · ${st.executionStopped(c.execution_stopped)}`,
    counts,
    st.nextCheck + (c.enabled ? time(result.runtime.next_tick || undefined) : st.nextCheckOff),
    st.lastDelivery +
      (attempts.length ? `${time(attempts[0].at, attempts[0].timezone)} ${attempts[0].timezone}` : w.noneYet),
    `${st.lastJobError}${result.runtime.last_error ?? st.noJobError} · Backoff: ${result.runtime.backoff_ms ?? 0} ms`,
    st.globalBudgets,
    st.archives + list((result.archives ?? []).map((a: any) => `${a.id} (${st.archiveTasks(a.task_count)})`)),
    st.effects(
      result.capacity.intents,
      result.capacity.intent_limit,
      result.capacity.receipts,
      result.capacity.receipt_limit
    ),
    result.intents
      .map(
        (i: any) =>
          `${st.intent} ${i.id}: ${w.actionState[i.state] ?? i.state}${i.temp_cleanup_pending ? ` · ${w.tempRest}` : ""}${i.review_hint ? ` · ${friendlyWhyNow(i.review_hint, language)}` : ""}; ${st.target} ${i.target_id}`
      )
      .join("\n"),
    result.receipts
      .map(
        (r: any) =>
          `${st.receipt} ${r.id}: ${w.actionState[r.outcome] ?? r.outcome}; ${st.target} ${r.target_id}; ${st.rollback(r.rollback_available)}`
      )
      .join("\n"),
    st.sources + list(result.sources.map((s: any) => `${s.id} ${w.onOff(s.enabled)}`)),
    st.adapters + list(result.adapters.map((a: any) => `${a.id} ${w.onOff(a.enabled)}`)),
    st.leases +
      list(
        (result.leases ?? []).map(
          (l: any) =>
            `${l.id} · ${st.leaseState[l.state] ?? st.leaseState.expired}; ${st.leaseUntil(time(l.expires_at))}; ${st.leaseRelease} ${l.id}`
        ),
        "\n"
      ),
    st.approval,
    (result.authorizations ?? [])
      .map(
        (row: any) =>
          `${st.chatOrder} ${row.task_id}: ${quote(row.authorization.user_request)} · ${quote(row.authorization.program)} · ${st.session} ${quote(row.authorization.session_id)} · ${time(row.authorization.at)} · ${st.authorization(row.revoked_at !== undefined, row.decision === "deny", row.consumed)}`
      )
      .join("\n"),
    result.tasks.length ? result.tasks.map(taskLine).join("\n\n") : w.noTasks,
  ].join("\n");
}
