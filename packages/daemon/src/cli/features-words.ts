/**
 * The words of the "features" block in `bastra doctor` (features-note.ts), by
 * language.primary (#1602). English is the default and the fallback,
 * byte-identical to before; German complete. Commands, setting names and
 * product names stay in the code: they are typed, not read. Only doctor's
 * screen reads these lines. Text the product writes — never matched against
 * user text.
 */
const en = {
  header: "→ features",
  on: "on",
  off: "off",
  offBecause: (why: string) => `off (${why})`,
  recallHooks: (surface: string) => `${surface}: recall hooks`,
  removeSetting: "remove that setting",
  autoSave: (surface: string) => `${surface}: auto-save suggestions (Stop hook)`,
  skill: (surface: string) => `${surface}: skill`,
  savingFromAgent: (surface: string) => `${surface}: saving from the agent`,
  searchSurfaceOff: "off (BASTRA_TOOL_SURFACE=search: recall only, no save tools)",
  searchSurfaceHint: (config: string | undefined) =>
    `set BASTRA_TOOL_SURFACE=write in the bastra-recall entry of ${config}`,
  sessionContext: (surface: string) => `${surface}: session context on the first tool call`,
  sessionContextHint: (config: string | undefined) =>
    `remove BASTRA_MCP_SESSION_CONTEXT from the bastra-recall entry of ${config}`,
  rulebookGate: (surface: string) => `${surface}: rulebook gate`,
  gateBlocking: (version: string | null) => `blocking (verified for Codex ${version})`,
  gateAdvisory: (version: string | null, verified: string) =>
    `advisory only: Codex ${version ?? "version unknown"} is not verified (verified: ${verified})`,
  gateHint: "nothing to switch on; the gate blocks once this Codex version is verified",
  memoryLanguage: "memory language",
  languageUnset: "not set, memories are written in English",
  languageHint: "bastra config set language.primary <code>  (e.g. de)",
  onboarding: "onboarding",
  done: "done",
  neverDone: "never done",
  neverDoneOptional: "never done (optional for a vault that already has memories)",
  semanticRecall: "semantic recall",
  semanticOn: (detail: string) => `on (${detail})`,
  semanticNotOn: (state: "off" | "degraded", detail: string) => `${state} (${detail})`,
  keywordOnly: "keyword search only",
  runningDaemon: "running daemon",
  providerFrom: (provider: string, source: string) => `${provider}, from ${source}`,
  paraphrasing: "background paraphrasing (doc2query)",
  paraphraseNotPulled: (model: string | undefined) => `on, but ${model} is not pulled, so every paraphrase fails`,
  paraphrasePullHint: (model: string | undefined) =>
    `ollama pull ${model}  (or BASTRA_TRIGGER_EXPAND=0 in the daemon's environment)`,
  paraphraseOn: (model: string | undefined) =>
    `on (${model} keeps rewriting memory triggers in the background; BASTRA_TRIGGER_EXPAND=0 stops it)`,
  reflex: "reflex memories",
  unsetReflex: "unset BASTRA_REFLEX",
  redaction: "credential redaction",
  redactionOff: "off — notes, documents, drafts, tasks and reports keep credentials as written",
  optionalHeading: "  optional, off by default on purpose:",
  proactive: "proactive task cards",
  proactiveOn:
    "client credential configured; next-contact only while daemon runs; validate: bastra tasks client-status",
  proactiveOff: "no client credential; hooks cannot show task cards",
  codeAwareness: "code awareness (experimental)",
  unsetCodeAwareness: "unset BASTRA_CODE_AWARENESS",
  codeAwarenessOn: (repos: number) => `on for ${repos} ${repos === 1 ? "repository" : "repositories"}`,
  codeEnableHint: "bastra code enable  (inside a repository)",
  promptImpact: "change impact in prompts (experimental)",
  promptImpactOff: "off, not shown to help yet",
  coverageMap: "coverage map from test runs (experimental)",
  coverageMapOn: "on — test commands run with NODE_V8_COVERAGE in enabled repositories",
  productDocs: "product docs",
  bridges: "shared recall bridges",
  vaultMap: "vault map",
  archive: "archiving rm + git snapshots (Claude Code)",
  archiveUnusable: (problem: string) => `on, but not usable: ${problem}`,
  archiveOn: (cap: string, maxItem: string | null) =>
    "on (rm -r and lossy git acts run through ~/.bastra/archive without a prompt; " +
    `cap ${cap}, per-target limit ${maxItem ?? "off"}; bastra archive list)`,
  archiveHost: "host (BASTRA_RM_ARCHIVES=host: the host's own archiving rm, receipt text only)",
  documentWrite: "document writing (Recall Pulse)",
  documentWriteOn: "on (this shell's environment; the daemon reads its own)",
  documentWriteHint: "BASTRA_DOCUMENT_WRITE=1 in the daemon's environment",
  battery: "battery saver (macOS)",
  batterySaving: "on, on battery now: paraphrasing waits for AC, no warm-ups, model unloads after 60 s idle",
  batteryLive: (source: string) => `on (power source: ${source})`,
};
export type FeaturesWords = typeof en;

const de: FeaturesWords = {
  header: "→ Funktionen",
  on: "an",
  off: "aus",
  offBecause: (why) => `aus (${why})`,
  recallHooks: (surface) => `${surface}: Recall-Hooks`,
  removeSetting: "diese Einstellung entfernen",
  autoSave: (surface) => `${surface}: automatische Speichervorschläge (Stop-Hook)`,
  skill: (surface) => `${surface}: Skill`,
  savingFromAgent: (surface) => `${surface}: Speichern durch den Agenten`,
  searchSurfaceOff: "aus (BASTRA_TOOL_SURFACE=search: nur Suche, keine Speicherwerkzeuge)",
  searchSurfaceHint: (config) => `BASTRA_TOOL_SURFACE=write im Eintrag bastra-recall von ${config} setzen`,
  sessionContext: (surface) => `${surface}: Sitzungskontext beim ersten Werkzeugaufruf`,
  sessionContextHint: (config) => `BASTRA_MCP_SESSION_CONTEXT aus dem Eintrag bastra-recall von ${config} entfernen`,
  rulebookGate: (surface) => `${surface}: Regelbuch-Sperre`,
  gateBlocking: (version) => `blockiert (geprüft für Codex ${version})`,
  gateAdvisory: (version, verified) =>
    `nur Hinweise: Codex ${version ?? "Version unbekannt"} ist nicht geprüft (geprüft: ${verified})`,
  gateHint: "nichts einzuschalten; die Sperre blockiert, sobald diese Codex-Version geprüft ist",
  memoryLanguage: "Sprache der Memories",
  languageUnset: "nicht gesetzt, Memories werden auf Englisch geschrieben",
  languageHint: "bastra config set language.primary <code>  (z. B. de)",
  onboarding: "Onboarding",
  done: "erledigt",
  neverDone: "nie durchgeführt",
  neverDoneOptional: "nie durchgeführt (freiwillig für einen Vault, der schon Memories hat)",
  semanticRecall: "Semantische Suche",
  semanticOn: (detail) => `an (${detail})`,
  semanticNotOn: (state, detail) => `${state === "off" ? "aus" : "eingeschränkt"} (${detail})`,
  keywordOnly: "nur Stichwortsuche",
  runningDaemon: "laufender Daemon",
  providerFrom: (provider, source) => `${provider}, aus ${source}`,
  paraphrasing: "Umschreibung im Hintergrund (doc2query)",
  paraphraseNotPulled: (model) => `an, aber ${model} ist nicht geladen, deshalb scheitert jede Umschreibung`,
  paraphrasePullHint: (model) => `ollama pull ${model}  (oder BASTRA_TRIGGER_EXPAND=0 in der Umgebung des Daemons)`,
  paraphraseOn: (model) =>
    `an (${model} formuliert im Hintergrund laufend die Auslöser der Memories neu; BASTRA_TRIGGER_EXPAND=0 stoppt es)`,
  reflex: "Reflex-Memories",
  unsetReflex: "BASTRA_REFLEX entfernen",
  redaction: "Zugangsdaten schwärzen",
  redactionOff:
    "aus — Notizen, Dokumente, Entwürfe, Aufgaben und Berichte behalten Zugangsdaten so, wie sie geschrieben wurden",
  optionalHeading: "  optional, mit Absicht standardmäßig aus:",
  proactive: "proaktive Aufgabenkarten",
  proactiveOn:
    "Client-Zugang eingerichtet; nächster Kontakt nur, solange der Daemon läuft; prüfen: bastra tasks client-status",
  proactiveOff: "kein Client-Zugang; Hooks können keine Aufgabenkarten zeigen",
  codeAwareness: "Code-Wissen (experimentell)",
  unsetCodeAwareness: "BASTRA_CODE_AWARENESS entfernen",
  codeAwarenessOn: (repos) => `an für ${repos} ${repos === 1 ? "Repository" : "Repositorys"}`,
  codeEnableHint: "bastra code enable  (in einem Repository)",
  promptImpact: "Auswirkungen von Änderungen in Prompts (experimentell)",
  promptImpactOff: "aus, ein Nutzen ist noch nicht belegt",
  coverageMap: "Abdeckungskarte aus Testläufen (experimentell)",
  coverageMapOn: "an — Testbefehle laufen in eingeschalteten Repositorys mit NODE_V8_COVERAGE",
  productDocs: "Produktdokumente",
  bridges: "Brücken der gemeinsamen Suche",
  vaultMap: "Vault-Karte",
  archive: "Archivierendes rm + git-Schnappschüsse (Claude Code)",
  archiveUnusable: (problem) => `an, aber nicht nutzbar: ${problem}`,
  archiveOn: (cap, maxItem) =>
    "an (rm -r und verlustbehaftete git-Befehle laufen ohne Rückfrage über ~/.bastra/archive; " +
    `Obergrenze ${cap}, Grenze je Ziel ${maxItem ?? "aus"}; bastra archive list)`,
  archiveHost: "Host (BASTRA_RM_ARCHIVES=host: das archivierende rm des Hosts, nur Quittungstext)",
  documentWrite: "Dokumente schreiben (Recall Pulse)",
  documentWriteOn: "an (Umgebung dieser Shell; der Daemon liest seine eigene)",
  documentWriteHint: "BASTRA_DOCUMENT_WRITE=1 in der Umgebung des Daemons",
  battery: "Akku-Sparmodus (macOS)",
  batterySaving:
    "an, gerade im Akkubetrieb: die Umschreibung wartet auf Netzstrom, kein Vorwärmen, das Modell wird nach 60 s Leerlauf entladen",
  batteryLive: (source) => `an (Stromquelle: ${source})`,
};

export const FEATURES_WORDS: Readonly<Record<string, FeaturesWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function featuresWordsIn(language: string | undefined): FeaturesWords {
  return FEATURES_WORDS[language ?? "en"] ?? en;
}
