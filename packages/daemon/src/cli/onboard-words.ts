/**
 * The words of the terminal onboarding interview (`bastra onboard`), by
 * language.primary (#1602): English is the default and the fallback — the
 * question catalog in onboarding.ts, byte-identical to before — and German
 * complete. Only the terminal reads these; the catalog's own texts (persona
 * labels, questions, hints) come from onboarding-words.ts, which the map's
 * dialog shares. Text the product writes — never matched against user text
 * (answers are saved as typed).
 */
import type { OnboardingQuestion, Persona } from "../onboarding.js";
import { ONBOARDING_WORDS } from "../onboarding-words.js";

const en = {
  dismissed: "✓ onboarding dismissed — run `bastra onboard` anytime to do the interview later\n",
  markedDone: "✓ onboarding marked done\n",
  ignored: (persona: string, ignored: string, known: string) =>
    `ignored (not a ${persona} question): ${ignored} — ` + `known ids: ${known}\n`,
  cannotRead: (path: string, message: string) => `cannot read answers file ${path}: ${message}`,
  cannotParse: (path: string, message: string) => `cannot parse answers file ${path}: ${message}`,
  invalid: (path: string, error: string) => `answers file ${path}: ${error}`,
  notAQuestion: (persona: string, ids: string) => `not a ${persona} question: ${ids}`,
  notText: (ids: string) => `not text: ${ids}`,
  noUsable: (path: string, named: string, known: string) =>
    `answers file ${path}: no usable answer (${named}) — known ids: ${known}`,
  onboardedBefore: "(you have onboarded before — answers overwrite your existing profile memories)\n\n",
  inputEnded: "\ninput ended before the interview finished — nothing saved\n",
  saved: (n: number) =>
    `\n✓ ${n} profile memories saved — your AI knows you from the next session on.\n` +
    `  Refine anytime: just tell your AI, or re-run \`bastra onboard\` (answers overwrite).\n` +
    `  Got memories in other AI tools? \`bastra import\` brings them along too.\n`,
  intro:
    "Seed your vault in ~5 minutes — a handful of questions, every answer becomes a memory\n" +
    "your AI recalls from day one. Enter skips an optional question; Ctrl-C aborts.\n\n" +
    "What will your memory mainly hold?\n",
  pick: (n: number) => `pick 1-${n}\n`,
  optional: "  (optional)",
  /** The catalog's persona labels and question texts — one source with the
   *  map's dialog, in onboarding-words.ts; English is the catalog's own. */
  persona: (persona: Persona, label: string) => ONBOARDING_WORDS.en.persona(persona, label),
  ask: (question: OnboardingQuestion) => ONBOARDING_WORDS.en.ask(question),
  hint: (question: OnboardingQuestion) => ONBOARDING_WORDS.en.hint(question),
};
export type OnboardWords = typeof en;

const de: OnboardWords = {
  dismissed: "✓ Onboarding übersprungen — `bastra onboard` startet das Interview jederzeit später\n",
  markedDone: "✓ Onboarding als erledigt markiert\n",
  ignored: (persona, ignored, known) => `ignoriert (keine Frage für ${persona}): ${ignored} — bekannte IDs: ${known}\n`,
  cannotRead: (path, message) => `Antwortdatei ${path} lässt sich nicht lesen: ${message}`,
  cannotParse: (path, message) => `Antwortdatei ${path} lässt sich nicht einlesen: ${message}`,
  invalid: (path, error) => `Antwortdatei ${path}: ${error}`,
  notAQuestion: (persona, ids) => `keine Frage für ${persona}: ${ids}`,
  notText: (ids) => `kein Text: ${ids}`,
  noUsable: (path, named, known) =>
    `Antwortdatei ${path}: keine verwertbare Antwort (${named}) — bekannte IDs: ${known}`,
  onboardedBefore:
    "(du hast das Onboarding schon gemacht — Antworten überschreiben deine bisherigen Profil-Memories)\n\n",
  inputEnded: "\ndie Eingabe endete vor dem Ende des Interviews — nichts gespeichert\n",
  saved: (n) =>
    `\n✓ ${n} Profil-Memories gespeichert — deine KI kennt dich ab der nächsten Sitzung.\n` +
    "  Jederzeit verfeinern: sag es einfach deiner KI oder führe `bastra onboard` erneut aus (Antworten überschreiben).\n" +
    "  Memories in anderen KI-Werkzeugen? `bastra import` bringt sie mit.\n",
  intro:
    "Füll deinen Vault in etwa 5 Minuten — eine Handvoll Fragen, jede Antwort wird ein Memory,\n" +
    "an das sich deine KI vom ersten Tag an erinnert. Enter überspringt eine optionale Frage; Strg-C bricht ab.\n\n" +
    "Was soll dein Gedächtnis vor allem enthalten?\n",
  pick: (n) => `wähle 1-${n}\n`,
  optional: "  (freiwillig)",
  persona: (persona, label) => ONBOARDING_WORDS.de.persona(persona, label),
  ask: (question) => ONBOARDING_WORDS.de.ask(question),
  hint: (question) => ONBOARDING_WORDS.de.hint(question),
};

export const ONBOARD_WORDS: Readonly<Record<string, OnboardWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function onboardWordsIn(language: string | undefined): OnboardWords {
  return ONBOARD_WORDS[language ?? "en"] ?? en;
}
