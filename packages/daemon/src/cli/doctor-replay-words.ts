/**
 * The words around `bastra doctor --replay` and the onboarding replay, by
 * language.primary (#1602): English is the default and the fallback
 * (byte-identical to before), German complete. Text the product writes —
 * never matched against user text. The report table and the not-evaluable
 * reasons are also `--json` output and stay English.
 */
const en = {
  badDays: (raw: string) => `error: --days needs a whole number of days between 1 and 365, got '${raw}'\n`,
  notEvaluableReport: (path: string) => `error: ${path} holds no evaluable replay report\n`,
  cannotRead: (path: string, message: string) => `error: cannot read ${path}: ${message}\n`,
  notEvaluable: (reason: string) => `replay: not evaluable — ${reason}\n`,
  onboardNotEvaluable: (reason: string) => `\nrecall replay: not evaluable — ${reason}\n`,
  onboardHeader: "\nHow recall answers your own prompts on this vault (shadow replay, nothing written):\n",
  onboardSkipped: (message: string) => `\nrecall replay skipped: ${message} — run \`bastra doctor --replay\` later\n`,
};
export type DoctorReplayWords = typeof en;

const de: DoctorReplayWords = {
  badDays: (raw: string) => `Fehler: --days braucht eine ganze Zahl von Tagen zwischen 1 und 365, erhalten: '${raw}'\n`,
  notEvaluableReport: (path: string) => `Fehler: ${path} enthält keinen auswertbaren Replay-Bericht\n`,
  cannotRead: (path: string, message: string) => `Fehler: ${path} lässt sich nicht lesen: ${message}\n`,
  notEvaluable: (reason: string) => `Replay: nicht auswertbar — ${reason}\n`,
  onboardNotEvaluable: (reason: string) => `\nRecall-Replay: nicht auswertbar — ${reason}\n`,
  onboardHeader:
    "\nSo antwortet Recall auf deine eigenen Prompts mit diesem Vault (Schatten-Replay, nichts geschrieben):\n",
  onboardSkipped: (message: string) =>
    `\nRecall-Replay übersprungen: ${message} — später \`bastra doctor --replay\` ausführen\n`,
};

export const DOCTOR_REPLAY_WORDS: Readonly<Record<string, DoctorReplayWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function doctorReplayWordsIn(language: string | undefined): DoctorReplayWords {
  return DOCTOR_REPLAY_WORDS[language ?? "en"] ?? en;
}
