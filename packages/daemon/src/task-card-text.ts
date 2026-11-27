/** Fixed card texts. Standard card reasons carry the English text (#1594).
 * Text presented to a person uses localTaskCardText(). */
const english = {
  reconcile: "Reconciliation required",
  reconcileUnknown: "Reconciliation required: execution outcome unknown",
  premise: "Verified premise change: reconsider the decision; nothing is reversed automatically.",
  premiseShort: "Reconsideration due; premise changed, nothing is reversed automatically.",
  due: "Trigger is due; no confirmed result.",
  dueShort: "Due; check details.",
  shortened: "Shortened data; check details. No alternative chosen.",
  expired: "Validity ended; the task was not confirmed as done.",
  overdueDecision: "Overdue – please decide what to do.",
  waiting: "Due tasks are waiting for review.",
} as const;
type TaskCardTextKey = keyof typeof english;
export const TASK_CARD_TEXT: Readonly<Record<TaskCardTextKey, string>> = english;

/** The card texts by language. Text the product writes — never matched against
 *  user text. An unlisted language gets English. */
const TASK_CARD_TEXT_BY_LANGUAGE: Readonly<Record<string, Readonly<Record<TaskCardTextKey, string>>>> = {
  en: english,
  de: {
    reconcile: "Abgleich nötig",
    reconcileUnknown: "Abgleich nötig: unklarer Ausführungsausgang",
    premise: "Geprüfte Prämissenänderung: Entscheidung neu bewerten, keine automatische Umkehr.",
    premiseShort: "Neubewertung fällig; geänderte Prämisse, keine automatische Umkehr.",
    due: "Fälliger Auslöser, kein bestätigtes Ergebnis.",
    dueShort: "Fällig; Details prüfen.",
    shortened: "Gekürzte Daten; Details prüfen. Keine Alternative gewählt.",
    expired: "Die Gültigkeit ist abgelaufen; die Aufgabe wurde nicht als erledigt bestätigt.",
    overdueDecision: "Überfällig – bitte entscheiden, was damit geschehen soll.",
    waiting: "Fällige Aufgaben warten auf Prüfung.",
  },
};
const keys = Object.keys(english) as TaskCardTextKey[];

/** A card text the daemon wrote, shown in `language`; any other text is returned unchanged. */
export function localTaskCardText(text: string, language: string | undefined): string {
  const key = keys.find((k) => english[k] === text);
  if (!key) return text;
  return (TASK_CARD_TEXT_BY_LANGUAGE[language ?? "en"] ?? english)[key];
}

/** Additional overdue reminders omitted from the session-start cards. */
export function overdueOverflowText(count: number, language?: string): string {
  if (language === "de")
    return count === 1 ? "Eine weitere Erinnerung ist überfällig." : `${count} weitere Erinnerungen sind überfällig.`;
  return count === 1 ? "One more reminder is overdue." : `${count} more reminders are overdue.`;
}
