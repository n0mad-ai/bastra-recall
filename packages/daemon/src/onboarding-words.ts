/**
 * The onboarding catalog's texts by language.primary (#1602) — the persona
 * labels and each question with its hint. ONE source for both screens that
 * show the catalog: `bastra onboard` in a terminal and the map's onboarding
 * dialog (GET /ui/onboarding).
 *
 * English is the default and the fallback: the catalog in onboarding.ts
 * itself, unchanged. German is complete. What is SAVED never depends on this:
 * answers come back keyed by question and persona id, and the memories are
 * built from the English catalog. The AI interview (the session hook's
 * onboarding block) is written for the model and stays English. Text the
 * product writes — never matched against user text.
 */

/** The parts of a catalog question a text lookup needs. */
interface CatalogQuestion {
  id: string;
  ask: string;
  hint: string;
}

const en = {
  /** Persona labels and question texts [question, hint] by id; English uses the catalog's own. */
  personaNames: {} as Readonly<Record<string, string>>,
  questions: {} as Readonly<Record<string, readonly [string, string]>>,
  /** The catalog's own label and texts are the English ones. */
  persona: (_persona: string, label: string) => label,
  ask: (question: CatalogQuestion) => question.ask,
  hint: (question: CatalogQuestion) => question.hint,
};
export type OnboardingWords = typeof en;

const de: OnboardingWords = {
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

export const ONBOARDING_WORDS: Readonly<Record<string, OnboardingWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function onboardingWordsIn(language: string | undefined): OnboardingWords {
  return ONBOARDING_WORDS[language ?? "en"] ?? en;
}
