/**
 * The words Ollama provisioning reports to the CLI (`bastra embeddings`,
 * `install`, `doctor`, the setup wizard), by language.primary (#1602): English
 * is the default and the fallback (byte-identical to before), German
 * complete. The server-start details (ensureServing) stay English: the
 * daemon's boot log reads the same text. Text the product writes — never
 * matched against user text.
 */
const en = {
  skipped: "skipped (--no-ollama) — semantic recall uses BM25 keyword search",
  envOverride: (provider: string) =>
    `BASTRA_EMBEDDING_PROVIDER=${provider} (env) overrides the config file — not setting up Ollama. Unset it (or set it to ollama) first.`,
  ready: (version: string, dryRun: boolean) =>
    `Ollama ready (${version})${dryRun ? "; would enable semantic recall" : "; semantic recall ON"}`,
  unsupported:
    "automatic Ollama setup is macOS-only today; Windows has no bundled Ollama (#84). Manual: install + start external Ollama (https://ollama.com), run `ollama pull embeddinggemma`, then re-run: bastra embeddings on. Alternatively configure embedding.provider=openai with an API key. Until a provider works, recall is keyword-only (BM25).",
  wouldInstall: "would: brew install ollama (if missing) → start service → pull embeddinggemma (~620 MB) → activate",
  settingUp: "  → setting up Ollama: Homebrew install (if needed) + ~620 MB model + local login service\n",
  noBrew:
    "Ollama not found and Homebrew unavailable — install Ollama from https://ollama.com, then `bastra config set embedding.provider ollama`",
  brewFailed: (detail: string) => `brew install ollama failed (${detail})`,
  notOnPath: "brew reported success but `ollama` is not on PATH — restart your shell, then retry",
  serverDidNotStart: (detail: string) =>
    `Ollama installed but the server didn't start (${detail}) — try \`ollama serve\` manually`,
  downloadInterrupted: "model download was interrupted — re-run `bastra embeddings on` when ready",
  pullFailed: (model: string, detail: string) => `\`ollama pull ${model}\` failed (${detail})`,
  embedModelMissing: (model: string) => `model not present after pull — re-run \`ollama pull ${model}\``,
  activated: (detail: string) =>
    `Ollama ready (${detail}); semantic recall ON — restart the daemon to apply (first recall re-indexes the vault once, may take a minute on large vaults)`,
  setupError: (message: string) => `Ollama setup error: ${message}`,
  staysOff: (message: string) => `${message} — semantic recall stays OFF (BM25 keyword search still works)`,
  wouldPull: (model: string) => `would pull ${model} + persist generation.model`,
  cannotCheck: (model: string, reason: string) =>
    `${model} cannot be checked with a test call: ${reason} — use 'bastra models set ${model}' to switch without it`,
  serverNotRunning:
    "Ollama isn't running — enable semantic recall first (that installs + starts it), then set the text model",
  pulling: (model: string) => `  → pulling ${model} (text model for doc2query + rerank)\n`,
  pullInterrupted: (model: string) => `pull of ${model} was interrupted — re-run when ready`,
  textModelMissing: (model: string) => `${model} not present after pull — re-run \`ollama pull ${model}\``,
  checking: (model: string) => `  → checking ${model} with a short test call\n`,
  noTestAnswer: (model: string, failure: string) =>
    `${model} is downloaded but did not answer a test call (${failure})`,
  notSaved: (model: string, reason: string) => `${model} is ready, but the setting could not be saved (${reason})`,
  textModelReady: (model: string) => `text model ${model} ready + saved — restart the daemon to apply`,
  urlUnreadable: "the configured Ollama URL cannot be read",
  urlNotHttp: "the configured Ollama URL is not an http(s) URL",
  urlCredentials: "the configured Ollama URL carries credentials, which the test call cannot use",
  urlNotLocal: (host: string) => `the test call only runs against a local Ollama, not ${host}`,
  notInstalled: "ollama not installed",
  installedNotRunning: "installed but server not running",
  running: (version: string) => `running (${version})`,
};
export type OllamaWords = typeof en;

const de: OllamaWords = {
  skipped: "übersprungen (--no-ollama) — die semantische Suche nutzt die Stichwortsuche BM25",
  envOverride: (provider) =>
    `BASTRA_EMBEDDING_PROVIDER=${provider} (Umgebung) hat Vorrang vor der Einstellungsdatei — Ollama wird nicht eingerichtet. Entferne die Variable (oder setze sie auf ollama) und versuche es erneut.`,
  ready: (version, dryRun) =>
    `Ollama bereit (${version})${dryRun ? "; würde die semantische Suche einschalten" : "; semantische Suche AN"}`,
  unsupported:
    "Die automatische Ollama-Einrichtung gibt es bisher nur unter macOS; Windows bringt kein Ollama mit (#84). Von Hand: externes Ollama installieren und starten (https://ollama.com), `ollama pull embeddinggemma` ausführen, dann erneut: bastra embeddings on. Alternativ embedding.provider=openai mit einem API-Schlüssel einstellen. Bis ein Anbieter funktioniert, nutzt Recall nur die Stichwortsuche (BM25).",
  wouldInstall:
    "würde: brew install ollama (falls fehlend) → Dienst starten → embeddinggemma laden (~620 MB) → einschalten",
  settingUp: "  → richte Ollama ein: Homebrew-Installation (falls nötig) + Modell ~620 MB + lokaler Anmeldedienst\n",
  noBrew:
    "Ollama nicht gefunden und Homebrew nicht verfügbar — Ollama von https://ollama.com installieren, dann `bastra config set embedding.provider ollama`",
  brewFailed: (detail) => `brew install ollama fehlgeschlagen (${detail})`,
  notOnPath: "brew meldet Erfolg, aber `ollama` liegt nicht im PATH — Shell neu starten, dann erneut versuchen",
  serverDidNotStart: (detail) =>
    `Ollama installiert, aber der Server ist nicht gestartet (${detail}) — \`ollama serve\` von Hand versuchen`,
  downloadInterrupted: "Download des Modells unterbrochen — `bastra embeddings on` erneut ausführen, wenn es passt",
  pullFailed: (model, detail) => `\`ollama pull ${model}\` fehlgeschlagen (${detail})`,
  embedModelMissing: (model) => `Modell nach dem Laden nicht vorhanden — \`ollama pull ${model}\` erneut ausführen`,
  activated: (detail) =>
    `Ollama bereit (${detail}); semantische Suche AN — Daemon neu starten, damit es wirkt (der erste Recall indexiert den Vault einmal neu, bei großen Vaults kann das eine Minute dauern)`,
  setupError: (message) => `Fehler bei der Ollama-Einrichtung: ${message}`,
  staysOff: (message) => `${message} — semantische Suche bleibt AUS (die Stichwortsuche BM25 funktioniert weiter)`,
  wouldPull: (model) => `würde ${model} laden + generation.model speichern`,
  cannotCheck: (model, reason) =>
    `${model} lässt sich nicht mit einem Testaufruf prüfen: ${reason} — mit 'bastra models set ${model}' ohne Prüfung umstellen`,
  serverNotRunning:
    "Ollama läuft nicht — zuerst die semantische Suche einschalten (das installiert und startet es), dann das Textmodell setzen",
  pulling: (model) => `  → lade ${model} (Textmodell für doc2query + Rerank)\n`,
  pullInterrupted: (model) => `Laden von ${model} unterbrochen — erneut ausführen, wenn es passt`,
  textModelMissing: (model) => `${model} nach dem Laden nicht vorhanden — \`ollama pull ${model}\` erneut ausführen`,
  checking: (model) => `  → prüfe ${model} mit einem kurzen Testaufruf\n`,
  noTestAnswer: (model, failure) =>
    `${model} ist geladen, hat aber auf einen Testaufruf nicht geantwortet (${failure})`,
  notSaved: (model, reason) => `${model} ist bereit, aber die Einstellung ließ sich nicht speichern (${reason})`,
  textModelReady: (model) => `Textmodell ${model} bereit + gespeichert — Daemon neu starten, damit es wirkt`,
  urlUnreadable: "die eingestellte Ollama-URL ist nicht lesbar",
  urlNotHttp: "die eingestellte Ollama-URL ist keine http(s)-URL",
  urlCredentials: "die eingestellte Ollama-URL enthält Zugangsdaten, die der Testaufruf nicht verwenden kann",
  urlNotLocal: (host) => `der Testaufruf läuft nur gegen ein lokales Ollama, nicht gegen ${host}`,
  notInstalled: "ollama nicht installiert",
  installedNotRunning: "installiert, aber der Server läuft nicht",
  running: (version) => `läuft (${version})`,
};

export const OLLAMA_WORDS: Readonly<Record<string, OllamaWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function ollamaWordsIn(language: string | undefined): OllamaWords {
  return OLLAMA_WORDS[language ?? "en"] ?? en;
}
