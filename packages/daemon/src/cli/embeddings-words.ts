/**
 * The words `bastra embeddings`, the install-end semantic-recall step and the
 * doctor's semantic-recall block print, by language.primary (#1602): English
 * is the default and the fallback (byte-identical to before), German
 * complete. Text the product writes — never matched against user text.
 */
const ENABLE_HINT = "bastra embeddings on";

/** #103: what keyword-only costs, measured on one real vault (see embeddings-cmd.ts). */
const OFF_COST = "keyword-only finds 61% of notes where semantic recall finds 80% (#103)";

const en = {
  /** #520: what the EXPLICIT cloud choice actually does with your data. */
  cloudEgress: "your recall queries and the memory text being indexed are sent to api.openai.com",
  /** #520: why a bare OPENAI_API_KEY no longer turns cloud embeddings on. */
  cloudConsent:
    "OPENAI_API_KEY is set, but a generic key is not consent to send vault text to OpenAI — " +
    "cloud embeddings stay OFF. Local semantic recall: `bastra embeddings on`. " +
    "OpenAI on purpose: `bastra config set embedding.provider openai`",
  recallOff: `Semantic recall is OFF — recall is keyword-only (BM25). Measured on a real vault: ${OFF_COST}, and the gap is widest when your wording differs from the note's. Enable: ${ENABLE_HINT}`,
  installOffHint: `→ semantic recall: OFF — recall is keyword-only (BM25). Measured: ${OFF_COST}. Enable: ${ENABLE_HINT}`,
  installQuestion:
    "Enable semantic recall (multilingual vector search)? It finds notes when your wording has drifted from theirs — " +
    "on a real vault 80% of notes found, against 61% keyword-only (#103). " +
    "Downloads the embeddinggemma model (~620 MB) via Ollama (installed with Homebrew if missing). " +
    "It also starts background paraphrasing (doc2query): a local generation model rewrites every memory's triggers, " +
    "hours of CPU on a machine without a GPU — BASTRA_TRIGGER_EXPAND=0 in the daemon's environment leaves it off.",
  paraphrasing: (model: string) => [
    `→ background paraphrasing (doc2query): starts with Ollama embeddings — ${model} rewrites every memory's triggers in the background`,
    "  (a generation model, not the embedding model: hours of CPU on a machine without a GPU).",
    "  Leave it off: BASTRA_TRIGGER_EXPAND=0 in the daemon's environment, then restart the daemon.",
  ],
  paraphraseModelMissing: (model: string) =>
    `  ⚠ ${model} is not pulled, so every paraphrase would fail: ollama pull ${model}  (or switch it off as above)`,
  usageLines:
    `  on      enable semantic recall (persists the setting + sets up Ollama/embeddinggemma)\n` +
    `  off     disable semantic recall (recall = BM25 keyword search only)\n` +
    `  status  show the effective provider, how it was resolved, and model presence\n`,
  storedIn: (path: string) => `  stored in ${path}`,
  semanticResult: (message: string) => `→ semantic recall: ${message}`,
  restartAlreadyActive: "  restart the daemon to apply (restart your AI client, or it applies on the next boot).",
  onPending:
    "  setting saved — semantic recall turns ON once Ollama + the embeddinggemma model are ready;\n" +
    `  recall stays keyword-only (BM25) until then. Finish setup, then re-run: ${ENABLE_HINT}`,
  offDone: `  semantic recall OFF — recall is keyword-only (BM25). Re-enable: ${ENABLE_HINT}`,
  envOverridesOff: (env: string) =>
    `  ⚠ BASTRA_EMBEDDING_PROVIDER=${env} (env) overrides this — unset it for the setting to take effect.`,
  restartOff: "  restart the daemon to apply (activates on next boot).",
  effectiveProvider: (provider: string) => `effective provider: ${provider}`,
  resolvedVia: (label: string) => `  resolved via: ${label}`,
  configuredEndpoint: "the configured endpoint",
  runningDaemon: (label: string, recall: string) => `  running daemon at ${label}: semantic recall ${recall}`,
  runningMode: (mode: string, source: string) => ` (${mode}, source: ${source})`,
  daemonOwnEnv:
    "  note: the daemon runs with its own environment (e.g. LaunchAgent plist) — this shell's view only governs newly spawned daemons.",
  openaiNoKey:
    "  ⚠ openai is requested but no API key is set (OPENAI_API_KEY / BASTRA_EMBEDDING_KEY) — falling back to none",
  egress: (text: string) => `  egress: ${text}`,
  egressLocal: "  egress: none — embeddings run on your machine via Ollama (loopback only)",
  envOverridesFile: (env: string, file: string) =>
    `  note: BASTRA_EMBEDDING_PROVIDER=${env} (env) overrides embedding.provider=${file} (cli-settings)`,
  ollamaDown: (detail: string) => `  ⚠ ${detail} — recall falls back to BM25. Fix: ${ENABLE_HINT}`,
  modelLine: (present: boolean) =>
    `  model embeddinggemma: ${present ? "present" : `MISSING — recall falls back to BM25. Fix: ${ENABLE_HINT}`}`,
  sourceEnv: (env: string) => `BASTRA_EMBEDDING_PROVIDER=${env} (env — wins over cli-settings)`,
  sourceApiKey: "default (OPENAI_API_KEY present, but no explicit provider chosen — #520)",
  sourceNone: "default (nothing configured)",
  installSaved: `  setting saved — finish setup, then re-run: ${ENABLE_HINT}`,
  doctorHeader: "→ semantic recall",
  doctorDaemonOn: (mode: string | undefined, source: string | undefined) =>
    `  ✓ ok: running daemon uses ${mode ?? "semantic recall"}` + ` (source: ${source ?? "daemon environment"})`,
  note: (text: string) => `  note: ${text}`,
  doctorOpenaiNoKey: (source: string) =>
    `  note: openai is requested (source: ${source}) but no API key is set (OPENAI_API_KEY / BASTRA_EMBEDDING_KEY)`,
  doctorOllamaDown: (source: string, detail: string) =>
    `  ⚠ configured (ollama, source: ${source}) but ${detail} — recall falls back to BM25. Fix: ${ENABLE_HINT}`,
  doctorModelMissing: (source: string) =>
    `  ⚠ configured (ollama, source: ${source}) but the embeddinggemma model is missing — recall falls back to BM25. Fix: ${ENABLE_HINT}`,
  doctorOllamaOk: (detail: string | undefined, source: string) =>
    `  ✓ ok: ollama ${detail ?? "configured"}, model embeddinggemma present (source: ${source})`,
  doctorOpenaiOk: (source: string, egress: string) => `  ✓ ok: openai (source: ${source}) — ${egress}`,
  doctorWindows:
    "  note: Windows includes no bundled Ollama or automatic model setup (#84). " +
    "Install and start external Ollama, run `ollama pull embeddinggemma`, then `bastra embeddings on`; " +
    "or explicitly configure OpenAI with `bastra config set embedding.provider openai` and OPENAI_API_KEY / BASTRA_EMBEDDING_KEY. " +
    "Without a working embedding provider, recall is keyword-only (BM25).",
};
export type EmbeddingsWords = typeof en;

const de: EmbeddingsWords = {
  cloudEgress: "deine Recall-Anfragen und der zu indexierende Text der Erinnerungen gehen an api.openai.com",
  cloudConsent:
    "OPENAI_API_KEY ist gesetzt, aber ein allgemeiner Schlüssel ist keine Zustimmung, Vault-Text an OpenAI zu senden — " +
    "Cloud-Embeddings bleiben AUS. Lokale semantische Suche: `bastra embeddings on`. " +
    "OpenAI mit Absicht: `bastra config set embedding.provider openai`",
  recallOff: `Semantische Suche ist AUS — Recall nutzt nur die Stichwortsuche (BM25). Gemessen an einem echten Vault: Stichwortsuche findet 61 % der Notizen, semantische Suche 80 % (#103); der Abstand ist am größten, wenn deine Worte von denen der Notiz abweichen. Einschalten: ${ENABLE_HINT}`,
  installOffHint: `→ semantische Suche: AUS — Recall nutzt nur die Stichwortsuche (BM25). Gemessen: Stichwortsuche findet 61 % der Notizen, semantische Suche 80 % (#103). Einschalten: ${ENABLE_HINT}`,
  installQuestion:
    "Semantische Suche einschalten (mehrsprachige Vektorsuche)? Sie findet Notizen auch, wenn deine Worte von ihren abweichen — " +
    "an einem echten Vault 80 % der Notizen gefunden, gegenüber 61 % mit Stichwortsuche (#103). " +
    "Lädt das Modell embeddinggemma (~620 MB) über Ollama (bei Bedarf mit Homebrew installiert). " +
    "Außerdem startet die Umschreibung im Hintergrund (doc2query): Ein lokales Textmodell formuliert die Auslöser jeder Erinnerung neu, " +
    "auf einem Rechner ohne GPU stundenlange CPU-Last — BASTRA_TRIGGER_EXPAND=0 in der Umgebung des Daemons lässt sie aus.",
  paraphrasing: (model) => [
    `→ Umschreibung im Hintergrund (doc2query): startet mit Ollama-Embeddings — ${model} formuliert im Hintergrund die Auslöser jeder Erinnerung neu`,
    "  (ein Textmodell, nicht das Embedding-Modell: auf einem Rechner ohne GPU stundenlange CPU-Last).",
    "  Auslassen: BASTRA_TRIGGER_EXPAND=0 in der Umgebung des Daemons, dann den Daemon neu starten.",
  ],
  paraphraseModelMissing: (model) =>
    `  ⚠ ${model} ist nicht geladen, jede Umschreibung würde scheitern: ollama pull ${model}  (oder wie oben abschalten)`,
  usageLines:
    `  on      semantische Suche einschalten (speichert die Einstellung + richtet Ollama/embeddinggemma ein)\n` +
    `  off     semantische Suche ausschalten (Recall = nur Stichwortsuche BM25)\n` +
    `  status  wirksamen Anbieter, seine Herkunft und das Vorhandensein des Modells zeigen\n`,
  storedIn: (path) => `  gespeichert in ${path}`,
  semanticResult: (message) => `→ semantische Suche: ${message}`,
  restartAlreadyActive:
    "  Daemon neu starten, damit es wirkt (KI-Client neu starten, sonst gilt es beim nächsten Start).",
  onPending:
    "  Einstellung gespeichert — die semantische Suche wird AN, sobald Ollama + das Modell embeddinggemma bereit sind;\n" +
    `  bis dahin nutzt Recall nur die Stichwortsuche (BM25). Einrichtung abschließen, dann erneut: ${ENABLE_HINT}`,
  offDone: `  semantische Suche AUS — Recall nutzt nur die Stichwortsuche (BM25). Wieder einschalten: ${ENABLE_HINT}`,
  envOverridesOff: (env) =>
    `  ⚠ BASTRA_EMBEDDING_PROVIDER=${env} (Umgebung) hat Vorrang — entferne die Variable, damit die Einstellung wirkt.`,
  restartOff: "  Daemon neu starten, damit es wirkt (gilt beim nächsten Start).",
  effectiveProvider: (provider) => `wirksamer Anbieter: ${provider}`,
  resolvedVia: (label) => `  ermittelt über: ${label}`,
  configuredEndpoint: "dem eingestellten Endpunkt",
  runningDaemon: (label, recall) => `  laufender Daemon an ${label}: semantische Suche ${recall}`,
  runningMode: (mode, source) => ` (${mode}, Quelle: ${source})`,
  daemonOwnEnv:
    "  Hinweis: Der Daemon läuft mit eigener Umgebung (z. B. LaunchAgent-plist) — die Sicht dieser Shell gilt nur für neu gestartete Daemons.",
  openaiNoKey:
    "  ⚠ openai ist gewählt, aber kein API-Schlüssel gesetzt (OPENAI_API_KEY / BASTRA_EMBEDDING_KEY) — Rückfall auf none",
  egress: (text) => `  Datenabfluss: ${text}`,
  egressLocal: "  Datenabfluss: keiner — Embeddings laufen über Ollama auf deinem Rechner (nur Loopback)",
  envOverridesFile: (env, file) =>
    `  Hinweis: BASTRA_EMBEDDING_PROVIDER=${env} (Umgebung) hat Vorrang vor embedding.provider=${file} (cli-settings)`,
  ollamaDown: (detail) => `  ⚠ ${detail} — Recall fällt auf BM25 zurück. Beheben: ${ENABLE_HINT}`,
  modelLine: (present) =>
    `  Modell embeddinggemma: ${present ? "vorhanden" : `FEHLT — Recall fällt auf BM25 zurück. Beheben: ${ENABLE_HINT}`}`,
  sourceEnv: (env) => `BASTRA_EMBEDDING_PROVIDER=${env} (Umgebung — hat Vorrang vor cli-settings)`,
  sourceApiKey: "Standard (OPENAI_API_KEY vorhanden, aber kein Anbieter ausdrücklich gewählt — #520)",
  sourceNone: "Standard (nichts eingestellt)",
  installSaved: `  Einstellung gespeichert — Einrichtung abschließen, dann erneut: ${ENABLE_HINT}`,
  doctorHeader: "→ semantische Suche",
  doctorDaemonOn: (mode, source) =>
    `  ✓ ok: laufender Daemon nutzt ${mode ?? "semantische Suche"}` + ` (Quelle: ${source ?? "Umgebung des Daemons"})`,
  note: (text) => `  Hinweis: ${text}`,
  doctorOpenaiNoKey: (source) =>
    `  Hinweis: openai ist gewählt (Quelle: ${source}), aber kein API-Schlüssel gesetzt (OPENAI_API_KEY / BASTRA_EMBEDDING_KEY)`,
  doctorOllamaDown: (source, detail) =>
    `  ⚠ eingerichtet (ollama, Quelle: ${source}), aber ${detail} — Recall fällt auf BM25 zurück. Beheben: ${ENABLE_HINT}`,
  doctorModelMissing: (source) =>
    `  ⚠ eingerichtet (ollama, Quelle: ${source}), aber das Modell embeddinggemma fehlt — Recall fällt auf BM25 zurück. Beheben: ${ENABLE_HINT}`,
  doctorOllamaOk: (detail, source) =>
    `  ✓ ok: ollama ${detail ?? "eingerichtet"}, Modell embeddinggemma vorhanden (Quelle: ${source})`,
  doctorOpenaiOk: (source, egress) => `  ✓ ok: openai (Quelle: ${source}) — ${egress}`,
  doctorWindows:
    "  Hinweis: Windows bringt kein Ollama und keine automatische Modell-Einrichtung mit (#84). " +
    "Externes Ollama installieren und starten, `ollama pull embeddinggemma` ausführen, dann `bastra embeddings on`; " +
    "oder OpenAI ausdrücklich einstellen mit `bastra config set embedding.provider openai` und OPENAI_API_KEY / BASTRA_EMBEDDING_KEY. " +
    "Ohne funktionierenden Embedding-Anbieter nutzt Recall nur die Stichwortsuche (BM25).",
};

export const EMBEDDINGS_WORDS: Readonly<Record<string, EmbeddingsWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function embeddingsWordsIn(language: string | undefined): EmbeddingsWords {
  return EMBEDDINGS_WORDS[language ?? "en"] ?? en;
}
