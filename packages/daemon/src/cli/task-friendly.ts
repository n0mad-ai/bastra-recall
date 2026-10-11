/** User-facing task options and plain text output; JSON remains explicit. */
import { randomUUID } from "node:crypto";
import { resolveTaskCalendar } from "../task-clock.js";
export const TASK_VALUE_FLAGS = ["--goal", "--when", "--after", "--timezone", "--domain", "--scope", "--resolve-when", "--level", "--id", "--revision", "--occurrence", "--until", "--input", "--event-source", "--expected"] as const;
export function parseTaskOptions(argv: string[]) {
  const options: Record<string, string | boolean> = {}, words: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const word = argv[i];
    if (word.startsWith("--")) {
      const [name, ...rest] = word.split("="); const key = name.slice(2);
      if (["arm", "agent", "json"].includes(key)) options[key] = true;
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
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return resolveTaskCalendar(value.length === 16 ? value + ":00" : value, timezone).at;
  if (!/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw Object.assign(new Error("Use local YYYY-MM-DDTHH:mm plus --timezone, or ISO time with offset"), { code: "validation" });
  return Date.parse(value);
}
export function friendlyTaskCreate(options: Record<string, string | boolean>, now = Date.now()) {
  const goal = String(options.goal ?? ""), timezone = String(options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone), domain = String(options.domain ?? "personal");
  if (!goal || ["when", "after", "event-source"].filter(k => options[k]).length !== 1) throw Object.assign(new Error("Create needs --goal and exactly one of --when, --after or --event-source"), { code: "validation" });
  let schedule: unknown;
  if (options.after) {
    const match = /^(\d+)(m|h|d|w)$/.exec(String(options.after)); if (!match) throw Object.assign(new Error("Use --after 30m, 2h, 7d or 2w (elapsed duration)"), { code: "validation" });
    const duration = Number(match[1]) * ({ m: 60000, h: 3600000, d: 86400000, w: 604800000 }[match[2]]!);
    if (!Number.isSafeInteger(duration) || duration <= 0) throw Object.assign(new Error("Positive bounded duration required"), { code: "validation" });
    schedule = { kind: "duration", reference_at: now, duration_ms: duration, at: now + duration };
  } else if (options["event-source"]) {
    if (!options.expected) throw Object.assign(new Error("Event monitoring needs --expected and an owner-registered source"), { code: "validation" });
    schedule = { kind: "event", source_id: options["event-source"], predicate: "equals", expected: options.expected };
  } else {
    const when = String(options.when);
    schedule = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(when)
      ? { kind: "calendar", local_time: when.length === 16 ? when + ":00" : when, timezone, gap: "reject", overlap: "earlier", ...resolveTaskCalendar(when.length === 16 ? when + ":00" : when, timezone) } : { kind: "instant", at: taskWhen(when, timezone) };
  }
  return { idempotency_key: randomUUID(), original_request: goal, goal, resolution_condition: String(options["resolve-when"] ?? "Owner confirms completion"), schedule,
    timezone, scope: { kind: "personal", name: String(options.scope ?? domain) }, owner_domains: domain.split(","), action_level: String(options.level ?? "notify"), arm: options.arm === true };
}
const quote = (value: unknown) => JSON.stringify(String(value ?? ""));
export function friendlyTaskResult(sub: string, result: any): string {
  const taskLine = (t: any) => {
    const when = t.schedule.kind === "event" ? `Ereignis ${quote(t.schedule.source_id)}` : new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: t.timezone }).format(new Date(t.schedule.at));
    return `${quote(t.goal)} · ${when} · ${t.timezone} · ${t.armed ? "scharf" : "unscharf"} · ${t.state} · ${t.action_level}\n  ID ${t.id}${t.next_check_at ? `\n  Nächste Prüfung: ${new Date(t.next_check_at).toISOString()}` : ""}${t.verification ? `\n  Quelle: ${t.verification.outcome} (${t.verification.reason})` : ""}${t.last_failure ? `\n  Fehler: ${t.last_failure.code}` : ""}${t.deliveries?.at(-1)?.last_attempt ? `\n  Letzte Zustellung: ${new Date(t.deliveries.at(-1).last_attempt).toISOString()}` : ""}${t.review_reason ? `\n  Prüfung: ${quote(t.review_reason)}` : ""}`;
  };
  if (sub === "due") return result.cards.length ? result.cards.map((c: any) => `${quote(c.goal)} · fällig ${new Date(c.due_at).toISOString()} · ${c.timezone}${c.acknowledged ? " · quittiert, noch offen" : ""}\n  ${quote(c.why_now)}\n  Aufgabe ${c.task_id}\n  Vorkommen ${c.occurrence_id}\n  Quittieren / zurückstellen / erledigen / beenden`).join("\n\n") + (result.overflow ? `\nWeitere fällige Karten: ${result.overflow}` : "") : "Keine zustellbare fällige Karte. Offene Aufgaben: bastra tasks list.";
  if (sub === "status") return `Zustellung: ${result.coverage} · Automatik: ${result.runtime?.running ? "läuft" : "nicht aktiv"}\nStumm: ${result.controls?.muted ? "ja" : "nein"} · Ausführung gestoppt: ${result.controls?.execution_stopped ? "ja" : "nein"}\nOwner-Schlüssel: ${result.approval.enrolled_domains.join(", ") || "keine"} · Geschützte Grenze: ${result.approval.protected_boundary ? "ja" : "nein"}\nQuellen: ${result.sources.map((s: any) => `${s.id} ${s.enabled ? "aktiv" : "aus"}`).join(", ") || "keine"}\nAdapter: ${result.adapters.map((a: any) => `${a.id} ${a.enabled ? "aktiv" : "aus"}`).join(", ") || "keine"}\n${result.tasks.length ? result.tasks.map(taskLine).join("\n\n") : "Keine Aufgaben."}`;
  if (result.tasks) return result.tasks.length ? result.tasks.map(taskLine).join("\n\n") : "Keine Aufgaben.";
  if (result.schedule) return taskLine(result);
  if (result.coverage) return `Zustellung: ${result.coverage}\nAutomatik: ${result.runtime?.running ? "läuft" : "nicht aktiv"}\nStumm: ${result.controls?.muted ? "ja" : "nein"} · Ausführung gestoppt: ${result.controls?.execution_stopped ? "ja" : "nein"}\n${result.tasks?.length ?? 0} Aufgaben`;
  return JSON.stringify(result, null, 2);
}
