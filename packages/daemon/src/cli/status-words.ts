/**
 * The words `bastra status` prints, by language.primary (#1602): English is
 * the default and the fallback (byte-identical to before), German complete.
 * Text the product writes — never matched against user text.
 *
 * `bastra status --json` keeps English values; the adapters' messages, the
 * daemon probe's detail and the local-patches line stay English on screen too
 * (they are also JSON values and come from other modules).
 */
const en = {
  label: {
    daemon: "daemon",
    daemons: "daemons",
    semanticRecall: "semantic recall",
    apiToken: "api token",
    localPatches: "local patches",
    vaultMap: "vault map",
  },
  tokenSet: "✓ set (browser/REST enabled)",
  tokenUnset: "· not set (loopback only)",
  mapOff: "· off (open + enable: bastra map)",
  mapDown: (url: string) => `· ${url} (daemon down — open it with: bastra map)`,
  failedToCheck: (message: string) => `failed to check: ${message}`,
  extraDaemons: (count: number, list: string, pids: string) =>
    `${count} further daemon process(es) running on other ports: ${list}. ` +
    `Harmless for recall — the port keeps them apart — but they hold a vault index in memory. ` +
    `Stop with: kill ${pids}`,
  // semantic recall
  ollamaReady: "ollama ready",
  modelMissing: "model embeddinggemma MISSING — fix: bastra embeddings on",
  downWithOllama: (detail: string) => `· daemon not reachable; configured=ollama (${detail})`,
  down: (configured: string) => `· daemon not reachable; configured=${configured}`,
  predates: "· (daemon predates this field — restart it to report)",
  onModelMissing: (mode: string) =>
    `⚠ on (${mode}) but the embeddinggemma model is MISSING — recall falls back to BM25. Fix: bastra embeddings on`,
  onOllamaDown: (mode: string, detail: string) =>
    `⚠ on (${mode}) but Ollama is unreachable (${detail}) — recall falls back to BM25`,
  on: (mode: string, source: string | undefined) => `✓ on (${mode}${source ? `, source: ${source}` : ""})`,
  degraded: (mode: string, error: string | undefined) =>
    `⚠ degraded (${mode})${error ? ` — last error: ${error}` : ""} — recall falls back to BM25. Check: ollama list / ollama serve`,
  offEnvOverride: "· off — BASTRA_EMBEDDING_PROVIDER (env) overrides your config=ollama; unset it",
  offPending:
    "· off — configured=ollama, daemon hasn't picked it up yet; restart pending (restart your AI client, or auto after idle)",
  off: "· off — BM25 keyword search only. Enable: bastra embeddings on",
};
export type StatusWords = typeof en;

const de: StatusWords = {
  label: {
    daemon: "Daemon",
    daemons: "Daemons",
    semanticRecall: "Bedeutungssuche",
    apiToken: "API-Token",
    localPatches: "lokale Patches",
    vaultMap: "Vault-Karte",
  },
  tokenSet: "✓ gesetzt (Browser/REST an)",
  tokenUnset: "· nicht gesetzt (nur lokal)",
  mapOff: "· aus (öffnen und einschalten: bastra map)",
  mapDown: (url) => `· ${url} (Daemon läuft nicht — öffnen mit: bastra map)`,
  failedToCheck: (message) => `Prüfung fehlgeschlagen: ${message}`,
  extraDaemons: (count, list, pids) =>
    `${count} weitere(r) Daemon-Prozess(e) auf anderen Ports: ${list}. ` +
    `Für Recall harmlos — der Port hält sie auseinander —, aber sie halten einen Vault-Index im Speicher. ` +
    `Beenden mit: kill ${pids}`,
  ollamaReady: "Ollama bereit",
  modelMissing: "Modell embeddinggemma FEHLT — beheben: bastra embeddings on",
  downWithOllama: (detail) => `· Daemon nicht erreichbar; eingestellt=ollama (${detail})`,
  down: (configured) => `· Daemon nicht erreichbar; eingestellt=${configured}`,
  predates: "· (der Daemon kennt dieses Feld noch nicht — neu starten, damit er es meldet)",
  onModelMissing: (mode) =>
    `⚠ an (${mode}), aber das Modell embeddinggemma FEHLT — die Suche fällt auf BM25 zurück. Beheben: bastra embeddings on`,
  onOllamaDown: (mode, detail) =>
    `⚠ an (${mode}), aber Ollama ist nicht erreichbar (${detail}) — die Suche fällt auf BM25 zurück`,
  on: (mode, source) => `✓ an (${mode}${source ? `, Quelle: ${source}` : ""})`,
  degraded: (mode, error) =>
    `⚠ eingeschränkt (${mode})${error ? ` — letzter Fehler: ${error}` : ""} — die Suche fällt auf BM25 zurück. Prüfen: ollama list / ollama serve`,
  offEnvOverride:
    "· aus — BASTRA_EMBEDDING_PROVIDER (Umgebung) übersteuert deine Einstellung ollama; entferne die Variable",
  offPending:
    "· aus — eingestellt ist ollama, der Daemon hat es noch nicht übernommen; Neustart steht aus (KI-Client neu starten oder automatisch nach Leerlauf)",
  off: "· aus — nur Stichwortsuche (BM25). Einschalten: bastra embeddings on",
};

export const STATUS_WORDS: Readonly<Record<string, StatusWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function statusWordsIn(language: string | undefined): StatusWords {
  return STATUS_WORDS[language ?? "en"] ?? en;
}
