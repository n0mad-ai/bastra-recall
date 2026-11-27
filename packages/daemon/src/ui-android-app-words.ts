/**
 * The words of the "Android app is part of Recall Pulse" notice page
 * (ui-android-app.ts), by language.primary like the sign-in page. English is
 * the default and the fallback for an unset or unlisted language; German is
 * complete. The command stays in the code: it is typed, not read. Text the
 * product writes — never matched against user text.
 */
const en = {
  lang: "en",
  title: "Android app: Recall Pulse",
  heading: "The Android app is part of Recall Pulse",
  body: "The web interface stays free in any browser. The Android app is a Recall Pulse feature and is switched off on this Recall.",
  howTo: "To switch it on, run this in a terminal on the Mac that runs Recall:",
};
export type AndroidAppWords = typeof en;

const de: AndroidAppWords = {
  lang: "de",
  title: "Android-App: Recall Pulse",
  heading: "Die Android-App gehört zu Recall Pulse",
  body: "Die Web-Oberfläche bleibt in jedem Browser frei. Die Android-App ist eine Funktion von Recall Pulse und auf diesem Recall ausgeschaltet.",
  howTo: "Zum Einschalten im Terminal auf dem Mac, auf dem Recall läuft:",
};

const WORDS: Readonly<Record<string, AndroidAppWords>> = { en, de };

/** The words in `language`; English for an unset or unlisted one. */
export function androidAppWordsIn(language: string | undefined): AndroidAppWords {
  return WORDS[language ?? "en"] ?? en;
}
