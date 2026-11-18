/**
 * The words of the terminal onboarding interview (`bastra onboard`), by
 * language.primary (#1602): English is the default and the fallback — the
 * question catalog in onboarding.ts, byte-identical to before — and German
 * complete. Only the terminal reads these; the catalog the map and the AI
 * session use stays as it is. Text the product writes — never matched against
 * user text (answers are saved as typed).
 */
import type { OnboardingQuestion, Persona } from "../onboarding.js";

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
  /** Persona labels and question texts [question, hint] by id; English uses the catalog's own. */
  personaNames: {} as Readonly<Partial<Record<Persona, string>>>,
  questions: {} as Readonly<Record<string, readonly [string, string]>>,
  /** The catalog's own label and texts are the English ones. */
  persona: (_persona: Persona, label: string) => label,
  ask: (question: OnboardingQuestion) => question.ask,
  hint: (question: OnboardingQuestion) => question.hint,
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
  personaNames: {
    developer: "Code & Projekte — ich baue Software",
    business: "Firma & Entscheidungen — ich leite ein Team oder ein Unternehmen",
    personal: "Leben & Wissen — ein gutes Gedächtnis für alles",
    mixed: "Von allem etwas",
  },
  questions: {
    identity: [
      "Wie soll deine KI dich ansprechen — in welcher Sprache und welchem Ton?",
      "z. B. Alex · Deutsch, per Du · knapp und technisch",
    ],
    rules: [
      "Harte Regeln — was soll deine KI IMMER oder NIE tun?",
      "z. B. nie selbst nach git pushen · immer vor dem Löschen fragen",
    ],
    stack: [
      "Dein Stack — die Sprachen, Frameworks und Werkzeuge, in denen du lebst?",
      "z. B. TypeScript + Node, SwiftUI, Postgres, keine ORMs",
    ],
    projects: [
      "Woran baust du gerade — deine aktiven Projekte, je eine Zeile?",
      "Projektname — was es ist, wo es steht",
    ],
    workflow: [
      "Wie arbeitest du am liebsten — Tests, Commits, Reviews, Code-Stil?",
      "z. B. ich committe selbst · Tests vor dem Merge · kleine PRs",
    ],
    conventions_size: [
      "Richtwert für die Dateigröße — wie viele Zeilen soll eine Quelldatei etwa haben, bevor eine Aufteilung vorgeschlagen wird?",
      "z. B. 500 — ein Richtwert, keine harte Grenze; die KI schlägt Aufteilungen vor, statt Dateien still wachsen zu lassen",
    ],
    conventions_structure: [
      "Ordnerkonventionen — welcher Ordner enthält in deinen Projekten was?",
      "z. B. hooks/ für React-Hooks · api/ für Routen · components/ · managers/ · utils/",
    ],
    role: [
      "Deine Firma und Rolle — was leitest du, und was macht es?",
      "z. B. Geschäftsführung einer Agentur mit 12 Leuten für Industriekunden",
    ],
    people: [
      "Die wichtigsten Menschen um dich — Namen und Rollen, mit denen du eng arbeitest?",
      "z. B. Anna — Mitgründerin · Marc — leitender Entwickler · Kim — größter Kunde",
    ],
    duties: [
      "Was soll deine KI für dich vorbereiten oder im Blick behalten — Termine, Mails, Entscheidungen?",
      "z. B. vor Gesprächen kurz briefen · Antworten entwerfen · Fristen melden",
    ],
    world: [
      "Dein Alltag — die Menschen, Orte und Gewohnheiten, die zählen?",
      "z. B. zwei Kinder · Berlin · Sport Di+Do · wöchentlicher Anruf bei Mama",
    ],
    remember: [
      "Was darf nie vergessen werden — Daten, Vorlieben, laufende Themen?",
      "z. B. Jahrestag 12. Mai · keine Meeresfrüchte · Haussuche läuft",
    ],
    goals: [
      "Worauf arbeitest du gerade hin — Projekte, Pläne, Ziele?",
      "z. B. die Zertifizierung abschließen · die Küche renovieren",
    ],
    freeform: [
      "Sonst noch etwas, das deine KI über dich wissen sollte? Schreib frei.",
      "was immer hilft — Hintergrund, Eigenheiten, was dich stört",
    ],
  },
  persona: (persona, label) => de.personaNames[persona] ?? label,
  ask: (question) => de.questions[question.id]?.[0] ?? question.ask,
  hint: (question) => de.questions[question.id]?.[1] ?? question.hint,
};

export const ONBOARD_WORDS: Readonly<Record<string, OnboardWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function onboardWordsIn(language: string | undefined): OnboardWords {
  return ONBOARD_WORDS[language ?? "en"] ?? en;
}
