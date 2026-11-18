/**
 * The code-graph lines `bastra doctor` and `bastra code status` print, by
 * language.primary (#1602): the coverage-map status, the paused/stopped
 * refresh, the external-node count, and the `affects_files` offers and
 * unresolved entries. English is the default and the fallback (byte-identical
 * to before), German complete. Only the CLI screen reads these lines. Text the
 * product writes — never matched against user text.
 */
const en = {
  coverageNone: (pending: string) => `coverage map: none yet${pending}`,
  coverageMap: (tests: number, runs: number, age: string, pending: string) =>
    `coverage map: ${tests} test${tests === 1 ? "" : "s"}, ${runs} process${runs === 1 ? "" : "es"} folded, ${age}${pending}`,
  coveragePending: (mb: string) => `, ${mb} MB of raw output waiting for the next fold`,
  ageUnknown: "age unknown",
  ageMinutes: (n: number) => `${n} min old`,
  ageHours: (n: number) => `${n} h old`,
  ageDays: (n: number) => `${n} d old`,
  refreshPaused: (error: string) => `refresh paused${error}`,
  refreshNext: (due: string) => `next automatic attempt ${due} — 'bastra code index' tries now`,
  refreshStopped: (failures: number, error: string) =>
    `refresh stopped${failures > 0 ? ` after ${failures} failed build${failures === 1 ? "" : "s"}` : ""}${error}`,
  refreshNoRetry: "no automatic retry — run 'bastra code index' to retry",
  dueAt: (iso: string) => `at ${iso}`,
  dueNow: "any moment now",
  dueMinutes: (n: number) => `in ${n} min`,
  dueHours: (h: number, rest: number) => (rest === 0 ? `in ${h} h` : `in ${h} h ${rest} min`),
  externalNodes: (total: number, resolved: number) => `${total} external nodes, ${resolved} resolved`,
  externalBlind: (line: string) =>
    `⚠ ${line} — this repository is a workspace, so cross-package ` +
    `impact is not being found. Likely a Graphify id-format change: ` +
    `rebuild with 'bastra code index', and if it stays 0 report it (#582).`,
  offer: (memoryId: string, entry: string, suggested: string, similarity: number | null) =>
    `${memoryId}: ${entry} → ${suggested}${similarity === null ? "" : ` (git: ${similarity}% similar)`} — offered, not applied`,
  unresolved: {
    "not-repo-relative": "not a repository path — nothing to resolve",
    "file-missing": "no such file in this repository",
    "symbol-missing": "file exists, symbol not found in the code graph",
  },
};
export type CodeGraphWords = typeof en;

const de: CodeGraphWords = {
  coverageNone: (pending) => `Abdeckungskarte: noch keine${pending}`,
  coverageMap: (tests, runs, age, pending) =>
    `Abdeckungskarte: ${tests} Test${tests === 1 ? "" : "s"}, ${runs} Prozess${runs === 1 ? "" : "e"} eingearbeitet, ${age}${pending}`,
  coveragePending: (mb) => `, ${mb} MB Rohdaten warten auf das nächste Einarbeiten`,
  ageUnknown: "Alter unbekannt",
  ageMinutes: (n) => `${n} Min. alt`,
  ageHours: (n) => `${n} Std. alt`,
  ageDays: (n) => `${n} Tage alt`,
  refreshPaused: (error) => `Aktualisierung pausiert${error}`,
  refreshNext: (due) => `nächster automatischer Versuch ${due} — 'bastra code index' versucht es sofort`,
  refreshStopped: (failures, error) =>
    `Aktualisierung gestoppt${failures > 0 ? ` nach ${failures} fehlgeschlagenen Build${failures === 1 ? "" : "s"}` : ""}${error}`,
  refreshNoRetry: "kein automatischer neuer Versuch — 'bastra code index' ausführen, um es erneut zu versuchen",
  dueAt: (iso) => `um ${iso}`,
  dueNow: "jeden Moment",
  dueMinutes: (n) => `in ${n} Min.`,
  dueHours: (h, rest) => (rest === 0 ? `in ${h} Std.` : `in ${h} Std. ${rest} Min.`),
  externalNodes: (total, resolved) => `${total} externe Knoten, ${resolved} aufgelöst`,
  externalBlind: (line) =>
    `⚠ ${line} — dieses Repository ist ein Workspace, Auswirkungen über Paketgrenzen ` +
    `werden also nicht gefunden. Wahrscheinlich hat Graphify das Format der IDs geändert: ` +
    `mit 'bastra code index' neu bauen, und wenn es bei 0 bleibt, melden (#582).`,
  offer: (memoryId, entry, suggested, similarity) =>
    `${memoryId}: ${entry} → ${suggested}${similarity === null ? "" : ` (git: ${similarity} % ähnlich)`} — angeboten, nicht übernommen`,
  unresolved: {
    "not-repo-relative": "kein Pfad im Repository — nichts aufzulösen",
    "file-missing": "diese Datei gibt es in diesem Repository nicht",
    "symbol-missing": "Datei vorhanden, Symbol nicht im Code-Graphen gefunden",
  },
};

export const CODE_GRAPH_WORDS: Readonly<Record<string, CodeGraphWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function codeGraphWordsIn(language: string | undefined): CodeGraphWords {
  return CODE_GRAPH_WORDS[language ?? "en"] ?? en;
}
