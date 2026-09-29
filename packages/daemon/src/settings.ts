/**
 * bastra-recall local CLI settings (#39: auto-update; #79: embedding provider).
 *
 * A small, OSS-owned settings file at ~/.bastra/cli-settings.json — deliberately
 * separate from ~/.bastra/config.json, which is owned by the Pro Mac-app and its
 * onboarding flow. We never touch that file; this one is ours.
 *
 * Keys:
 *   - update.mode      : "notify" (default) | "auto" | "off"  (see #39)
 *   - embedding.provider (optional): "ollama" | "openai" | "none"
 *       Written by `bastra embeddings on|off`, by the `bastra install` end
 *       prompt, or by `bastra config set`. Absent = "no opinion" → the daemon
 *       stays on BM25 unless BASTRA_EMBEDDING_PROVIDER says otherwise; an
 *       OPENAI_API_KEY alone never enables the cloud provider (#520). This is
 *       the file half of the #79 fix;
 *       resolveEmbeddingChoice below is the ONE resolution everyone shares.
 *   - ollama.autostart (optional): boolean (default true)
 *       Whether `bastra install` keeps a local `ollama serve` running at login.
 *   - docs.mode (optional): "off" (default) | "suggest" | "auto"
 *       Product-documentation capture: when a feature area is finished, the
 *       agent updates the per-project product doc in dokumentationen/<scope>/.
 *       "suggest" = propose first, "auto" = write without asking, "off" = the
 *       session hook injects no docs instruction at all.
 *   - docs.language (optional): doc language, e.g. "en" | "de" (default "en").
 *   - promptImpact.enabled (optional): boolean (default false, #607 experimental —
 *       see code-graph/prompt-impact-settings.ts for the resolution + why)
 *
 * The env var BASTRA_UPDATE_CHECK=off is a hard kill-switch over update.mode.
 * The env var BASTRA_EMBEDDING_PROVIDER wins over embedding.provider (the file).
 */
import { randomBytes } from "node:crypto";
import type { EmbeddingSource } from "./embedding-status.js";
import {
  DEFAULT_DOCS_LANGUAGE,
  DEFAULT_DOCS_MODE,
  GENERATION_MODEL_DEFAULT,
  mutateSettings,
  normalizeCorsOrigin,
  readSettings,
  settingsFilePath,
  type DocsMode,
  type EmbeddingProviderName,
  type UpdateMode,
} from "./settings-file.js";

// #680: the file shape, validation and read/write live in settings-file.ts;
// their public surface is re-exported from here unchanged.
export {
  UPDATE_MODES,
  DEFAULT_UPDATE_MODE,
  EMBEDDING_PROVIDERS,
  DOCS_MODES,
  DEFAULT_DOCS_MODE,
  DEFAULT_DOCS_LANGUAGE,
  GENERATION_MODEL_DEFAULT,
  settingsFilePath,
  isDocsMode,
  isDocsLanguage,
  isPrimaryLanguage,
  isEmbeddingProviderName,
  normalizeCorsOrigin,
  readSettings,
  mutateSettings,
} from "./settings-file.js";
export type { UpdateMode, EmbeddingProviderName, DocsMode, CliSettings } from "./settings-file.js";

/** The stored update mode (env-agnostic). */
export async function getUpdateMode(path?: string): Promise<UpdateMode> {
  return (await readSettings(path)).update.mode;
}

/**
 * The effective mode after applying the env kill-switch: if BASTRA_UPDATE_CHECK
 * is set to a falsy value, the mode is forced to "off" regardless of the file.
 */
export async function effectiveUpdateMode(path?: string): Promise<UpdateMode> {
  const env = (process.env.BASTRA_UPDATE_CHECK ?? "").toLowerCase();
  if (env === "off" || env === "0" || env === "false" || env === "no") return "off";
  return getUpdateMode(path);
}

/** Persists a new update mode atomically, merging into existing settings. */
export async function setUpdateMode(mode: UpdateMode, path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({ ...current, update: { ...current.update, mode } }));
}

/** The stored embedding provider, or undefined when unset (no opinion). */
export async function getEmbeddingProvider(path?: string): Promise<EmbeddingProviderName | undefined> {
  return (await readSettings(path)).embedding?.provider;
}

/** Persists the generation (doc2query + rerank) model, merging into existing settings. */
export async function setGenerationModel(model: string, path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({ ...current, generation: { model: model.trim() } }));
}

/**
 * The ONE generation-model resolution, shared by doc2query (index.ts) and the
 * reranker so the precedence can't drift:
 *
 *   1. env BASTRA_EXPAND_MODEL / BASTRA_RERANK_MODEL — always wins
 *   2. cli-settings.json generation.model — the installer's / `bastra models` choice
 *   3. GENERATION_MODEL_DEFAULT — the 16 GB baseline pick
 *
 * Cross-platform by construction: the persisted choice lives in cli-settings.json,
 * not a LaunchAgent env var, so a Windows/Linux daemon reads the same value.
 */
export async function resolveGenerationModel(path?: string): Promise<string> {
  const env = process.env.BASTRA_EXPAND_MODEL ?? process.env.BASTRA_RERANK_MODEL;
  if (typeof env === "string" && env.trim().length > 0) return env.trim();
  const stored = (await readSettings(path)).generation?.model;
  if (typeof stored === "string" && stored.trim().length > 0) return stored.trim();
  return GENERATION_MODEL_DEFAULT;
}

/**
 * The ONE embedding-provider resolution, shared by the OSS daemon (index.ts),
 * the Pro bridge (bridge.ts) and the CLI (embeddings/doctor/status) so the
 * precedence can never drift between them (#79):
 *
 *   1. env BASTRA_EMBEDDING_PROVIDER — always wins (none | ollama | openai)
 *   2. cli-settings.json embedding.provider — when env is unset/invalid
 *   3. none → BM25 keyword search only
 *
 * Cloud embeddings need an EXPLICIT Bastra decision (1 or 2). A generic
 * OPENAI_API_KEY in the environment is a credential, not consent (#520).
 *
 * `provider` is the EFFECTIVE choice (what the daemon will run); `requested`
 * keeps what env/file asked for when it could not be honoured (openai without
 * an API key, or a bare key without an explicit choice → provider "none",
 * requested "openai") so status/doctor can explain the gap instead of
 * reporting a silent "none".
 */
export interface EmbeddingChoice {
  provider: EmbeddingProviderName;
  source: EmbeddingSource;
  requested?: EmbeddingProviderName;
}

export async function resolveEmbeddingChoice(
  opts: {
    path?: string;
    env?: Record<string, string | undefined>;
    /** Called with the raw value when BASTRA_EMBEDDING_PROVIDER is set but invalid (typo). */
    onInvalidEnv?: (raw: string) => void;
  } = {},
): Promise<EmbeddingChoice> {
  const env = opts.env ?? process.env;
  const envRaw = env.BASTRA_EMBEDDING_PROVIDER ?? "";
  const envProvider = envRaw.toLowerCase();
  const hasApiKey = Boolean(env.OPENAI_API_KEY ?? env.BASTRA_EMBEDDING_KEY);

  // Tier 1: explicit env wins over the file.
  if (envProvider === "none") return { provider: "none", source: "env" };
  if (envProvider === "ollama") return { provider: "ollama", source: "env" };
  if (envProvider === "openai") {
    return hasApiKey
      ? { provider: "openai", source: "env" }
      : { provider: "none", source: "env", requested: "openai" };
  }
  // A typo'd env value must NOT silently disable embeddings and shadow a valid
  // file choice — surface it and fall through (treat as "no opinion").
  if (envProvider) opts.onInvalidEnv?.(envRaw);

  // Tier 2: cli-settings.json (env unset or invalid → no opinion).
  const fileProvider = await getEmbeddingProvider(opts.path);
  if (fileProvider === "none") return { provider: "none", source: "cli-settings" };
  if (fileProvider === "ollama") return { provider: "ollama", source: "cli-settings" };
  if (fileProvider === "openai") {
    return hasApiKey
      ? { provider: "openai", source: "cli-settings" }
      : { provider: "none", source: "cli-settings", requested: "openai" };
  }

  // Tier 3 (#520): a bare API key is NOT consent. It used to resolve to
  // "openai", which meant any machine that exported OPENAI_API_KEY for some
  // other tool started POSTing recall queries and the whole backfill corpus to
  // api.openai.com without a single Bastra-specific decision. The effective
  // provider is therefore "none" (BM25 only) — but `source: "api-key"` plus
  // `requested: "openai"` keeps WHY visible, so the daemon, status and doctor
  // can tell an existing user that the old fallback stopped and how to opt in
  // on purpose (`bastra config set embedding.provider openai`).
  if (hasApiKey) return { provider: "none", source: "api-key", requested: "openai" };

  // Tier 4: nothing requested.
  return { provider: "none", source: "none" };
}

/** Persists the embedding provider atomically, merging into existing settings. */
export async function setEmbeddingProvider(provider: EmbeddingProviderName, path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({ ...current, embedding: { provider } }));
}

/** Whether Ollama should be kept running at login. Default true (if you use ollama, you want it up). */
export async function getOllamaAutostart(path?: string): Promise<boolean> {
  return (await readSettings(path)).ollama?.autostart ?? true;
}

/** Persists the Ollama autostart preference atomically. */
export async function setOllamaAutostart(on: boolean, path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({ ...current, ollama: { autostart: on } }));
}

/** The stored REST API token, or undefined when none has been issued. */
export async function getApiToken(path?: string): Promise<string | undefined> {
  return (await readSettings(path)).api?.token;
}

/**
 * The stored browser-bridge CORS origins (empty when none set). The daemon uses
 * these as the allowlist when BASTRA_CORS_ORIGIN is unset/empty (env is the ops
 * override). Values are already normalized + validated by readSettings.
 */
export async function getCorsOrigins(path?: string): Promise<string[]> {
  return (await readSettings(path)).cors?.origins ?? [];
}

/**
 * Additively allows a browser Origin, merging into existing settings. The url is
 * normalized to its bare scheme://host[:port] form and deduped; an invalid one
 * (not an http(s) origin, or carrying a path) is warned about on stderr and
 * dropped — the allowlist is never widened by a malformed value.
 */
export async function addCorsOrigin(url: string, path: string = settingsFilePath()): Promise<void> {
  const origin = normalizeCorsOrigin(url);
  if (origin === null) {
    process.stderr.write(
      `[bastra-recall] ignoring invalid --origin ${JSON.stringify(url)} — expected an origin like https://your.host (scheme + host, no path)\n`,
    );
    return;
  }
  await mutateSettings(path, (current) => {
    const existing = current.cors?.origins ?? [];
    if (existing.includes(origin)) return null; // already allowed — nothing to write
    return { ...current, cors: { origins: [...existing, origin] } };
  });
}

/** Persists an explicit API token atomically (merging into existing settings). */
/** Bastra Commons enabled? Default false (opt-in). */
export async function getCommonsEnabled(path?: string): Promise<boolean> {
  return (await readSettings(path)).commons?.enabled ?? false;
}

export async function setCommonsEnabled(on: boolean, path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({ ...current, commons: { enabled: on } }));
}

/** Vault map web UI (#207) enabled? Default false (opt-in). */
export async function getUiEnabled(path?: string): Promise<boolean> {
  return (await readSettings(path)).ui?.enabled ?? false;
}

export async function setUiEnabled(on: boolean, path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({ ...current, ui: { enabled: on } }));
}

/** Shared learned-recall bridges enabled? Default false (opt-in, privacy-respecting). */
export async function getSharedRecallEnabled(path?: string): Promise<boolean> {
  return (await readSettings(path)).sharedRecall?.enabled ?? false;
}

/**
 * Ist der Evidenzentscheid scharf? Default `true` seit #422 (03.09.2026).
 *
 * Aktiviert nach §18.2: Shadow-Abnahme erreicht (6.544 Entscheidungen, 40
 * Sessions), jede required-/no_answer-Abweichung per Merkmalssignatur
 * erklärt, Komponenten-Gates auf dem vollen Goldsatz innerhalb der Schwellen
 * (Anti-Query 1/28, Falsch-Abstention 0/584, Recall@3-Delta −0,0034).
 *
 * Der Env-Schalter steht daneben, weil ein Betreiber ihn im Zweifel SOFORT
 * ausmachen können muss, ohne eine Datei zu bearbeiten — der Rückfall aufs
 * Legacy-Verhalten ist die wichtigere Richtung. `BASTRA_EVIDENCE_GATE=0`
 * überstimmt deshalb die Einstellung, nicht umgekehrt; `evidenceGate.enabled:
 * false` in den Settings schaltet dauerhaft ab.
 */
export const EVIDENCE_GATE_DEFAULT = true;

export async function getEvidenceGateEnabled(path?: string): Promise<boolean> {
  // #443: Nur erkannte Schreibweisen zählen. Vorher schaltete JEDER Wert
  // außer 0|false|off|no das Gate ein — ein `flase` überstimmte damit sogar
  // `enabled: false` in den Settings, und ein vertipptes Aus wirkte nicht.
  // Ein unbekannter Wert fällt auf die Settings zurück und sagt es.
  const env = process.env.BASTRA_EVIDENCE_GATE?.trim().toLowerCase();
  if (env !== undefined && env !== "") {
    if (["1", "true", "on", "yes"].includes(env)) return true;
    if (["0", "false", "off", "no"].includes(env)) return false;
    console.error(
      `[bastra-recall] BASTRA_EVIDENCE_GATE=${JSON.stringify(process.env.BASTRA_EVIDENCE_GATE)} is not ` +
        `one of 1|true|on|yes|0|false|off|no — ignored, using the settings value (#443)`,
    );
  }
  return (await readSettings(path)).evidenceGate?.enabled ?? EVIDENCE_GATE_DEFAULT;
}

/**
 * Die Experimentkonfiguration, oder `null`.
 *
 * `null` heißt: keine Armzuweisung, jedes Ereignis trägt `unassigned`. Eine
 * unvollständige Konfiguration ergibt ebenfalls `null` — und sagt es, statt
 * still ein halbes Experiment zu fahren.
 */
export async function getExperimentConfig(
  path?: string,
): Promise<{
  experiment: string;
  arms: string[];
  registration: string;
  registration_version: number;
} | null> {
  const cfg = (await readSettings(path)).experiment;
  if (!cfg) return null;
  // Name, Registrierung und Registrierungsversion sind seit #425 schon von
  // readSettings geprüft — hier bleibt die fachliche Regel: unter zwei Armen
  // gibt es nichts zu vergleichen.
  if (cfg.arms.length < 2) {
    console.error(
      "[bastra-recall] experiment config incomplete (needs name, >=2 arms, registration + registration_version) — no arm assignment (#267)",
    );
    return null;
  }
  // #439: Der Verweis auf die Registrierung wird MITGEGEBEN, nicht hier
  // verworfen. Er ist die einzige Identität, über die sich eine historische
  // Zeile nach einer Revision noch der Konfiguration zuordnen lässt, die sie
  // zugewiesen hat — ein Armname allein wird wiederverwendet.
  return {
    experiment: cfg.name,
    arms: cfg.arms,
    registration: cfg.registration,
    registration_version: cfg.registration_version,
  };
}

export async function setEvidenceGateEnabled(
  on: boolean,
  path: string = settingsFilePath(),
): Promise<void> {
  await mutateSettings(path, (current) => ({ ...current, evidenceGate: { enabled: on } }));
}

export async function setSharedRecallEnabled(on: boolean, path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({ ...current, sharedRecall: { ...current.sharedRecall, enabled: on } }));
}

/** Optional override for the auto-detected query language (e.g. "de"). undefined = auto-detect per query. */
export async function getSharedRecallLanguage(path?: string): Promise<string | undefined> {
  return (await readSettings(path)).sharedRecall?.language;
}

export async function setSharedRecallLanguage(language: string, path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({
    ...current,
    sharedRecall: { enabled: current.sharedRecall?.enabled ?? false, language: language.trim().toLowerCase() },
  }));
}

/** Clears the query-language override, restoring per-query auto-detection. Writes
 *  the sharedRecall block WITHOUT a `language` key (a plain spread would preserve it). */
export async function clearSharedRecallLanguage(path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({
    ...current,
    sharedRecall: { enabled: current.sharedRecall?.enabled ?? false },
  }));
}

/** Product-docs capture mode. Default "off" (opt-in). */
export async function getDocsMode(path?: string): Promise<DocsMode> {
  return (await readSettings(path)).docs?.mode ?? DEFAULT_DOCS_MODE;
}

export async function setDocsMode(mode: DocsMode, path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({ ...current, docs: { ...current.docs, mode } }));
}

/** Language product docs are written in. Default "en". */
export async function getDocsLanguage(path?: string): Promise<string> {
  return (await readSettings(path)).docs?.language ?? DEFAULT_DOCS_LANGUAGE;
}

export async function setDocsLanguage(language: string, path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({ ...current, docs: { ...current.docs, language: language.trim().toLowerCase() } }));
}

/** Datei-Größen-Richtwert (Zeilen) für Quellcode; undefined = Default 500. */
export async function getSizeGuide(path?: string): Promise<number | undefined> {
  const v = (await readSettings(path)).size?.guide;
  return typeof v === "number" && Number.isFinite(v) && v >= 100 && v <= 5000 ? Math.round(v) : undefined;
}

export async function setSizeGuide(guide: number, path: string = settingsFilePath()): Promise<void> {
  const n = Math.min(5000, Math.max(100, Math.round(guide)));
  await mutateSettings(path, (current) => ({ ...current, size: { ...current.size, guide: n } }));
}

export async function getArchiveRetain(path?: string): Promise<string | undefined> {
  return (await readSettings(path)).archive?.retain;
}

export async function setArchiveRetain(retain: string, path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({ ...current, archive: { ...current.archive, retain } }));
}

/** #650 opt-in: bastra's archiving rm and git snapshots. Default false. */
export async function getArchiveEnabled(path?: string): Promise<boolean> {
  return (await readSettings(path)).archive?.enabled ?? false;
}

export async function setArchiveEnabled(on: boolean, path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({ ...current, archive: { ...current.archive, enabled: on } }));
}

/** #634: reflex memories on/off in the file (default on; BASTRA_REFLEX wins at runtime). */
export async function getReflexEnabled(path?: string): Promise<boolean> {
  return (await readSettings(path)).reflex?.enabled ?? true;
}

export async function setReflexEnabled(on: boolean, path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({ ...current, reflex: { ...current.reflex, enabled: on } }));
}

export async function setApiToken(token: string, path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({ ...current, api: { token } }));
}

/** The stored primary authoring language (2-letter ISO code), or undefined when unset. */
export async function getPrimaryLanguage(path?: string): Promise<string | undefined> {
  return (await readSettings(path)).language?.primary;
}

/** Persists the primary authoring language, normalized to a lowercase 2-letter code. */
export async function setPrimaryLanguage(code: string, path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({ ...current, language: { ...current.language, primary: code.trim().toLowerCase() } }));
}

/**
 * Returns the stored API token, minting + persisting one on first use. 256-bit,
 * base64url (URL-safe, no padding). `rotate` forces a fresh token, invalidating
 * the old one. The file is written 0600 (see writeSettings).
 */
export async function ensureApiToken(
  opts: { rotate?: boolean } = {},
  path: string = settingsFilePath(),
): Promise<string> {
  let token = "";
  await mutateSettings(path, (current) => {
    if (!opts.rotate && current.api?.token) {
      token = current.api.token;
      return null;
    }
    token = randomBytes(32).toString("base64url");
    return { ...current, api: { token } };
  });
  return token;
}

/**
 * Removes the stored REST API token. After a daemon restart, browser/REST
 * clients that send an Origin are rejected again (back to secure-by-default).
 * Returns true if a token was actually removed, false if none was set.
 */
export async function clearApiToken(path: string = settingsFilePath()): Promise<boolean> {
  let removed = false;
  await mutateSettings(path, (current) => {
    if (!current.api?.token) return null;
    const next = { ...current };
    delete next.api;
    removed = true;
    return next;
  });
  return removed;
}

/** #632: battery mode switch as stored in the file (env is applied by the caller). */
export async function getBatterySaver(path?: string): Promise<boolean | undefined> {
  return (await readSettings(path)).battery?.saver;
}

export async function setBatterySaver(on: boolean, path: string = settingsFilePath()): Promise<void> {
  await mutateSettings(path, (current) => ({ ...current, battery: { ...current.battery, saver: on } }));
}
