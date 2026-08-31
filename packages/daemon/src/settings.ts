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
 *       falls through to env / API-key. This is the file half of the #79 fix;
 *       resolveEmbeddingChoice below is the ONE resolution everyone shares.
 *   - ollama.autostart (optional): boolean (default true)
 *       Whether `bastra install` keeps a local `ollama serve` running at login.
 *   - docs.mode (optional): "off" (default) | "suggest" | "auto"
 *       Product-documentation capture: when a feature area is finished, the
 *       agent updates the per-project product doc in dokumentationen/<scope>/.
 *       "suggest" = propose first, "auto" = write without asking, "off" = the
 *       session hook injects no docs instruction at all.
 *   - docs.language (optional): doc language, e.g. "en" | "de" (default "en").
 *
 * The env var BASTRA_UPDATE_CHECK=off is a hard kill-switch over update.mode.
 * The env var BASTRA_EMBEDDING_PROVIDER wins over embedding.provider (the file).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { isSupportedLanguage } from "./learned-recall/language.js";
import type { EmbeddingSource } from "./embedding-status.js";

export type UpdateMode = "notify" | "auto" | "off";
export const UPDATE_MODES: readonly UpdateMode[] = ["notify", "auto", "off"];
export const DEFAULT_UPDATE_MODE: UpdateMode = "notify";

// Named "...Name" to avoid colliding with core's `EmbeddingProvider` (the
// provider *class* interface). This is just the string id of the choice.
export type EmbeddingProviderName = "ollama" | "openai" | "none";
export const EMBEDDING_PROVIDERS: readonly EmbeddingProviderName[] = ["ollama", "openai", "none"];

export type DocsMode = "off" | "suggest" | "auto";
export const DOCS_MODES: readonly DocsMode[] = ["off", "suggest", "auto"];
export const DEFAULT_DOCS_MODE: DocsMode = "off";
export const DEFAULT_DOCS_LANGUAGE = "en";

export interface CliSettings {
  update: { mode: UpdateMode };
  // undefined = "no opinion" → daemon falls through to env / API-key.
  embedding?: { provider: EmbeddingProviderName };
  // undefined = unset → treated as default (true) by getOllamaAutostart.
  ollama?: { autostart: boolean };
  // undefined = no token issued yet → browser/REST clients that send an Origin
  // are rejected (secure by default). Created on demand by `bastra token`; the
  // daemon reads it at startup as the Bearer the bastra.io web app must present.
  api?: { token: string };
  // Browser-bridge CORS allowlist: undefined = none stored → the daemon falls
  // back to the (empty) env allowlist BASTRA_CORS_ORIGIN, so browser origins stay
  // locked out until opted in. Written additively by `bastra token --origin <url>`
  // (dedupe, origin-validated); the daemon reads it at startup when
  // BASTRA_CORS_ORIGIN is unset/empty — mirroring how api.token backstops
  // BASTRA_API_TOKEN. Each entry is a bare scheme://host[:port] origin (no path).
  cors?: { origins: string[] };
  // Bastra Commons (community recipe vault): undefined = disabled. Enabled via
  // `bastra commons enable`; the daemon then loads the cloned repo as a
  // read-only second BM25 index.
  commons?: { enabled: boolean };
  // Shared learned-recall bridges (#120): undefined = disabled (opt-in,
  // privacy-respecting). Enabled via `bastra bridges enable`; the daemon then
  // loads a git-synced, language-partitioned bridge pool and uses it to widen
  // recall queries. `language` is an optional override for the auto-detected
  // query language (e.g. force "de" when you always search in German).
  sharedRecall?: { enabled: boolean; language?: string };
  /**
   * Der deterministische Evidenzentscheid (#264): `undefined` = AUS, und das
   * ist der Auslieferungszustand.
   *
   * NICHT scharfschalten, bevor beides vorliegt (§18.2, Issue #264):
   *   1. Shadow-Acceptance: ≥14 Kalendertage ODER ≥500 geloggte
   *      Hook-Entscheidungen, und jede `required`/`no_answer`-Abweichung
   *      gegenüber dem Legacy-Verhalten durch Merkmale, Grund oder Review
   *      erklärt — unerklärte Abweichungen blockieren die Freigabe. Die Daten
   *      dafür liegen seit d1abff4 im `evidence_decision`-Event.
   *   2. Die Komponenten-Gates auf dem versionierten Goldset (#262, offen).
   *
   * Solange das Flag aus ist, verhält sich der Recall exakt wie vorher: Der
   * Entscheid läuft, wird geloggt und wirkt auf nichts.
   */
  evidenceGate?: { enabled: boolean };
  /**
   * Die Experimentkonfiguration für die §17.4-Arme (#267): `undefined` = kein
   * Experiment, jedes Ereignis trägt `unassigned`. Das ist der
   * Auslieferungszustand und heute auch der richtige.
   *
   * WARUM HIER UND NICHT AUS DER REGISTRIERUNG. §17.4 verlangt Mindest-N,
   * Zuweisungsfunktion und Konfiguration versioniert abgelegt — das ist
   * `packages/eval/registrations/presentation-experiment.json`. Der Daemon
   * hängt aber nicht an `@bastra-recall/eval` und wird ohne dieses Verzeichnis
   * ausgeliefert; er KANN die Datei im Betrieb nicht lesen. Deshalb trägt die
   * Konfiguration den Verweis auf ihre Registrierung mit: `registration` und
   * `registration_version` sind Pflicht, damit ein laufendes Experiment sich
   * einer versionierten Registrierung zuordnen lässt statt frei zu schweben.
   *
   * Eine Konfiguration ohne diesen Verweis oder mit weniger als zwei Armen wird
   * beim Boot verworfen — keine Stufe ohne ihre Voraussetzungen, dieselbe Regel
   * wie im Registrierungs-Validator.
   */
  experiment?: { name: string; arms: string[]; registration: string; registration_version: number };
  // Product-documentation capture: undefined = off. mode gates the session-hook
  // instruction ("suggest" proposes, "auto" writes without asking); language is
  // the language product docs are written in (free short tag, e.g. "de").
  docs?: { mode?: DocsMode; language?: string };
  // Generation model (#84-adjacent): the Ollama chat model for doc2query +
  // reranking. undefined = daemon falls through to env / GENERATION_MODEL_DEFAULT.
  // Persisted cross-platform here (not a LaunchAgent env var) so Windows/Linux
  // installs carry the choice too. Written by `bastra models` / the install wizard.
  generation?: { model: string };
  // Vault map web UI (#207): undefined = disabled (opt-in). Enabled via the
  // install wizard or `bastra config set ui.enabled true`; the daemon then
  // serves the static viewer on /ui (loopback-only). Read per-request, so
  // toggling does not require a daemon restart.
  ui?: { enabled: boolean };
  // Reflex-Lane (#217): undefined = enabled (Reflex feuert nur auf Memories,
  // die der User explizit auf recall_mode:"reflex" promotet hat — der Opt-in
  // liegt am Memory, nicht am Feature). maxPerTurn deckelt die Injektionen
  // pro Prompt (default 2, clamp 1..5). Env gewinnt: BASTRA_REFLEX=off,
  // BASTRA_REFLEX_MAX_PER_TURN.
  reflex?: { enabled?: boolean; maxPerTurn?: number };
  // Datei-Größen-Konvention (19.07.2026): guide = Richtwert in Zeilen für
  // Quellcode-Dateien (Default 500), critical = harte Warnschwelle (Default
  // 800). Gesetzt vom Onboarding-Interview (conventions_size) oder `bastra
  // config set size.guide N`. Der PreToolUse-Hook (file-size-check) liest
  // beide deterministisch; env gewinnt: BASTRA_SIZE_GUIDE/_CRITICAL.
  // exemptPaths (#280): Pfad-Fragmente, für die der Check GAR nicht feuert —
  // case-insensitive Substring-Match auf dem Schreibpfad, kein Glob. Ergänzt
  // die eingebauten Wegwerf-Kontexte (sandbox/lab/prototype/scratch/
  // experiments, siehe file-size-check.ts) für projekteigene Sandbox-Ordner.
  // Nur hier gepflegt, nicht über `bastra config set` (Skalar-only).
  size?: { guide?: number; critical?: number; exemptPaths?: string[] };
  // User-Sprache (#231, Language-first recall): primary = 2-stelliger ISO-639-1-
  // Code (lowercase, z.B. "de"). Beim Onboarding aus der identity-Antwort
  // abgeleitet (persistLanguageSetting) oder via `bastra config set
  // language.primary de` gesetzt. Der Session-Hook weist den Agenten an, Memories
  // (Titel, Summary, recall_when) in dieser Sprache zu verfassen — nur echte
  // englische Fachbegriffe (daemon, deploy, hook, …) bleiben als Anker.
  language?: { primary?: string };
}

/**
 * Default generation (doc2query + rerank) model — the 16 GB baseline pick.
 * A 4B text model with strong instruction-following, chosen over the older
 * qwen3-vl:4b (a vision-language model doing text work). The install wizard may
 * persist a heavier model for roomier machines (see cli/hardware.ts).
 */
export const GENERATION_MODEL_DEFAULT = "gemma3:4b";

export function settingsFilePath(): string {
  return join(homedir(), ".bastra", "cli-settings.json");
}

function isUpdateMode(v: unknown): v is UpdateMode {
  return typeof v === "string" && (UPDATE_MODES as readonly string[]).includes(v);
}

export function isDocsMode(v: unknown): v is DocsMode {
  return typeof v === "string" && (DOCS_MODES as readonly string[]).includes(v);
}

/** Doc language is a free short tag ("en", "de", "pt-br") — not an enum. */
export function isDocsLanguage(v: unknown): v is string {
  return typeof v === "string" && /^[a-z]{2}(-[a-z]{2,4})?$/i.test(v.trim());
}

/** Primary authoring language: a 2-letter ISO-639-1 code (case-insensitive input). */
export function isPrimaryLanguage(v: unknown): v is string {
  return typeof v === "string" && /^[a-z]{2}$/.test(v.trim().toLowerCase());
}

export function isEmbeddingProviderName(v: unknown): v is EmbeddingProviderName {
  return typeof v === "string" && (EMBEDDING_PROVIDERS as readonly string[]).includes(v);
}

/**
 * Normalizes a CORS origin to its bare `scheme://host[:port]` form (what the
 * browser sends in the Origin header, so http.ts can compare it byte-for-byte
 * against reqOrigin). Returns null for anything that isn't an http(s) origin
 * without a path/query/hash/credentials — those are dropped, never stored.
 */
export function normalizeCorsOrigin(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // Must be JUST an origin: no path (beyond the implicit "/"), query, hash, or
  // embedded credentials — a stored value has to equal what a browser reflects.
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username || u.password) return null;
  return u.origin;
}

/**
 * Reads stored settings. A missing file → silent defaults (normal: not created
 * yet). A *corrupt* file → loud warning + defaults, and we do NOT silently
 * revert (callers that write will repair it). Never throws.
 */
export async function readSettings(path: string = settingsFilePath()): Promise<CliSettings> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { update: { mode: DEFAULT_UPDATE_MODE } };
  }
  if (raw.trim() === "") return { update: { mode: DEFAULT_UPDATE_MODE } };

  let data: { update?: { mode?: unknown }; embedding?: { provider?: unknown }; ollama?: { autostart?: unknown }; api?: { token?: unknown }; cors?: { origins?: unknown }; commons?: { enabled?: unknown }; sharedRecall?: { enabled?: unknown; language?: unknown }; docs?: { mode?: unknown; language?: unknown }; generation?: { model?: unknown }; ui?: { enabled?: unknown }; reflex?: { enabled?: unknown; maxPerTurn?: unknown } };
  try {
    data = JSON.parse(raw);
  } catch (e) {
    // Corrupt is not normal — surface it instead of silently masking the user's
    // real settings behind defaults (that silence was an #79-class footgun).
    process.stderr.write(
      `[bastra-recall] cli-settings.json is corrupt (${(e as Error).message}) — using defaults. Fix or delete ${path}\n`,
    );
    return { update: { mode: DEFAULT_UPDATE_MODE } };
  }

  const settings: CliSettings = {
    update: { mode: isUpdateMode(data?.update?.mode) ? data.update.mode : DEFAULT_UPDATE_MODE },
  };
  // Preserve + validate the optional blocks. Invalid → drop to undefined (NOT a
  // synthesized "none"), so the daemon's fall-through precedence still applies.
  const embProvider = data?.embedding?.provider;
  if (isEmbeddingProviderName(embProvider)) {
    settings.embedding = { provider: embProvider };
  } else if (data?.embedding !== undefined) {
    process.stderr.write(
      `[bastra-recall] cli-settings.json: ignoring invalid embedding.provider ${JSON.stringify(embProvider)}\n`,
    );
  }
  if (typeof data?.ollama?.autostart === "boolean") {
    settings.ollama = { autostart: data.ollama.autostart };
  }
  if (typeof data?.api?.token === "string" && data.api.token.length > 0) {
    settings.api = { token: data.api.token };
  }
  if (data?.cors !== undefined) {
    // Same policy as the other optional blocks: keep the valid entries, drop the
    // rest with a warning — a corrupt origin must never widen the allowlist.
    const rawOrigins = data.cors.origins;
    if (!Array.isArray(rawOrigins)) {
      if (rawOrigins !== undefined) {
        process.stderr.write(
          `[bastra-recall] cli-settings.json: ignoring invalid cors.origins ${JSON.stringify(rawOrigins)} (expected an array)\n`,
        );
      }
    } else {
      const origins: string[] = [];
      for (const raw of rawOrigins) {
        const norm = normalizeCorsOrigin(raw);
        if (norm === null) {
          process.stderr.write(
            `[bastra-recall] cli-settings.json: ignoring invalid cors.origins entry ${JSON.stringify(raw)}\n`,
          );
        } else if (!origins.includes(norm)) {
          origins.push(norm);
        }
      }
      if (origins.length > 0) settings.cors = { origins };
    }
  }
  if (typeof data?.commons?.enabled === "boolean") {
    settings.commons = { enabled: data.commons.enabled };
  }
  if (typeof data?.sharedRecall?.enabled === "boolean") {
    const sr: { enabled: boolean; language?: string } = { enabled: data.sharedRecall.enabled };
    // Validate against the supported pool languages (de/en) — the SAME set the boot
    // gate enforces — not the loose docs-language regex, so the file, CLI, and daemon
    // agree on what a valid override is.
    const lng = typeof data.sharedRecall.language === "string" ? data.sharedRecall.language.trim().toLowerCase() : data.sharedRecall.language;
    if (isSupportedLanguage(lng)) sr.language = lng;
    else if (data.sharedRecall.language !== undefined) {
      process.stderr.write(
        `[bastra-recall] cli-settings.json: ignoring unsupported sharedRecall.language ${JSON.stringify(data.sharedRecall.language)}\n`,
      );
    }
    settings.sharedRecall = sr;
  }
  if (data?.docs !== undefined) {
    // Invalid values drop to undefined (= defaults), same policy as embedding.
    const docs: { mode?: DocsMode; language?: string } = {};
    if (isDocsMode(data.docs.mode)) docs.mode = data.docs.mode;
    else if (data.docs.mode !== undefined) {
      process.stderr.write(
        `[bastra-recall] cli-settings.json: ignoring invalid docs.mode ${JSON.stringify(data.docs.mode)}\n`,
      );
    }
    if (isDocsLanguage(data.docs.language)) docs.language = data.docs.language.trim().toLowerCase();
    else if (data.docs.language !== undefined) {
      process.stderr.write(
        `[bastra-recall] cli-settings.json: ignoring invalid docs.language ${JSON.stringify(data.docs.language)}\n`,
      );
    }
    if (docs.mode !== undefined || docs.language !== undefined) settings.docs = docs;
  }
  if (typeof data?.generation?.model === "string" && data.generation.model.trim().length > 0) {
    settings.generation = { model: data.generation.model.trim() };
  } else if (data?.generation !== undefined) {
    process.stderr.write(
      `[bastra-recall] cli-settings.json: ignoring invalid generation.model ${JSON.stringify(data?.generation?.model)}\n`,
    );
  }
  if (typeof data?.ui?.enabled === "boolean") {
    settings.ui = { enabled: data.ui.enabled };
  }
  if (data?.reflex !== undefined) {
    // Invalid values drop to undefined (= defaults), same policy as docs.
    const reflex: { enabled?: boolean; maxPerTurn?: number } = {};
    if (typeof data.reflex.enabled === "boolean") reflex.enabled = data.reflex.enabled;
    const mpt = data.reflex.maxPerTurn;
    if (typeof mpt === "number" && Number.isInteger(mpt) && mpt >= 1 && mpt <= 5) {
      reflex.maxPerTurn = mpt;
    } else if (mpt !== undefined) {
      process.stderr.write(
        `[bastra-recall] cli-settings.json: ignoring invalid reflex.maxPerTurn ${JSON.stringify(mpt)} (expected integer 1-5)\n`,
      );
    }
    if (reflex.enabled !== undefined || reflex.maxPerTurn !== undefined) settings.reflex = reflex;
  }
  const sizeData = (data as { size?: { guide?: unknown; critical?: unknown; exemptPaths?: unknown } }).size;
  if (sizeData !== undefined) {
    const size: { guide?: number; critical?: number; exemptPaths?: string[] } = {};
    if (typeof sizeData.guide === "number" && Number.isFinite(sizeData.guide)) size.guide = sizeData.guide;
    if (typeof sizeData.critical === "number" && Number.isFinite(sizeData.critical)) size.critical = sizeData.critical;
    // Parsed here so a `bastra config set size.guide N` round-trip does not
    // silently drop a hand-written exemption list (#280) — parseSettings
    // rebuilds the object, unknown keys never survive a write.
    if (Array.isArray(sizeData.exemptPaths)) {
      const paths = sizeData.exemptPaths
        .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        .map((p) => p.trim());
      if (paths.length > 0) size.exemptPaths = paths;
    }
    if (size.guide !== undefined || size.critical !== undefined || size.exemptPaths !== undefined) settings.size = size;
  }
  const langData = (data as { language?: { primary?: unknown } }).language;
  if (langData !== undefined) {
    const primary = typeof langData.primary === "string" ? langData.primary.trim().toLowerCase() : langData.primary;
    if (isPrimaryLanguage(primary)) settings.language = { primary };
    else if (langData.primary !== undefined) {
      process.stderr.write(
        `[bastra-recall] cli-settings.json: ignoring invalid language.primary ${JSON.stringify(langData.primary)}\n`,
      );
    }
  }
  return settings;
}

/** Atomic tmp+rename. Random suffix (not just pid — PIDs recycle on macOS). */
async function writeSettings(next: CliSettings, path: string): Promise<void> {
  // Owner-only perms regardless of umask, matching the repo's temp-file
  // hardening (commit 3af0cc8) — forward-safe if a secret ever lands here.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

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
  const current = await readSettings(path);
  await writeSettings({ ...current, update: { ...current.update, mode } }, path);
}

/** The stored embedding provider, or undefined when unset (no opinion). */
export async function getEmbeddingProvider(path?: string): Promise<EmbeddingProviderName | undefined> {
  return (await readSettings(path)).embedding?.provider;
}

/** Persists the generation (doc2query + rerank) model, merging into existing settings. */
export async function setGenerationModel(model: string, path: string = settingsFilePath()): Promise<void> {
  const current = await readSettings(path);
  await writeSettings({ ...current, generation: { model: model.trim() } }, path);
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
 *   3. backwards-compat — an API key present with no explicit choice → openai
 *   4. none → BM25 keyword search only
 *
 * `provider` is the EFFECTIVE choice (what the daemon will run); `requested`
 * keeps what env/file asked for when it could not be honoured (today: openai
 * without an API key → provider "none", requested "openai") so status/doctor
 * can explain the gap instead of reporting a silent "none".
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

  // Tier 3: backwards-compat — key present, no explicit choice anywhere.
  if (hasApiKey) return { provider: "openai", source: "api-key" };

  // Tier 4: nothing requested.
  return { provider: "none", source: "none" };
}

/** Persists the embedding provider atomically, merging into existing settings. */
export async function setEmbeddingProvider(provider: EmbeddingProviderName, path: string = settingsFilePath()): Promise<void> {
  const current = await readSettings(path);
  await writeSettings({ ...current, embedding: { provider } }, path);
}

/** Whether Ollama should be kept running at login. Default true (if you use ollama, you want it up). */
export async function getOllamaAutostart(path?: string): Promise<boolean> {
  return (await readSettings(path)).ollama?.autostart ?? true;
}

/** Persists the Ollama autostart preference atomically. */
export async function setOllamaAutostart(on: boolean, path: string = settingsFilePath()): Promise<void> {
  const current = await readSettings(path);
  await writeSettings({ ...current, ollama: { autostart: on } }, path);
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
  const current = await readSettings(path);
  const existing = current.cors?.origins ?? [];
  if (existing.includes(origin)) return; // already allowed — nothing to write
  await writeSettings({ ...current, cors: { origins: [...existing, origin] } }, path);
}

/** Persists an explicit API token atomically (merging into existing settings). */
/** Bastra Commons enabled? Default false (opt-in). */
export async function getCommonsEnabled(path?: string): Promise<boolean> {
  return (await readSettings(path)).commons?.enabled ?? false;
}

export async function setCommonsEnabled(on: boolean, path: string = settingsFilePath()): Promise<void> {
  const current = await readSettings(path);
  await writeSettings({ ...current, commons: { enabled: on } }, path);
}

/** Vault map web UI (#207) enabled? Default false (opt-in). */
export async function getUiEnabled(path?: string): Promise<boolean> {
  return (await readSettings(path)).ui?.enabled ?? false;
}

export async function setUiEnabled(on: boolean, path: string = settingsFilePath()): Promise<void> {
  const current = await readSettings(path);
  await writeSettings({ ...current, ui: { enabled: on } }, path);
}

/** Shared learned-recall bridges enabled? Default false (opt-in, privacy-respecting). */
export async function getSharedRecallEnabled(path?: string): Promise<boolean> {
  return (await readSettings(path)).sharedRecall?.enabled ?? false;
}

/**
 * Ist der Evidenzentscheid scharf? Default `false`.
 *
 * Der Env-Schalter steht daneben, weil ein Betreiber ihn im Zweifel SOFORT
 * ausmachen können muss, ohne eine Datei zu bearbeiten — der Rückfall aufs
 * Legacy-Verhalten ist die wichtigere Richtung. `BASTRA_EVIDENCE_GATE=0`
 * überstimmt deshalb die Einstellung, nicht umgekehrt.
 */
export async function getEvidenceGateEnabled(path?: string): Promise<boolean> {
  const env = process.env.BASTRA_EVIDENCE_GATE;
  if (env !== undefined && env !== "") {
    return !["0", "false", "off", "no"].includes(env.toLowerCase());
  }
  return (await readSettings(path)).evidenceGate?.enabled ?? false;
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
): Promise<{ experiment: string; arms: string[] } | null> {
  const cfg = (await readSettings(path)).experiment;
  if (!cfg) return null;
  const complete =
    typeof cfg.name === "string" &&
    cfg.name.length > 0 &&
    Array.isArray(cfg.arms) &&
    cfg.arms.length >= 2 &&
    typeof cfg.registration === "string" &&
    cfg.registration.length > 0 &&
    typeof cfg.registration_version === "number";
  if (!complete) {
    console.error(
      "[bastra-recall] experiment config incomplete (needs name, >=2 arms, registration + registration_version) — no arm assignment (#267)",
    );
    return null;
  }
  return { experiment: cfg.name, arms: cfg.arms };
}

export async function setEvidenceGateEnabled(
  on: boolean,
  path: string = settingsFilePath(),
): Promise<void> {
  const current = await readSettings(path);
  await writeSettings({ ...current, evidenceGate: { enabled: on } }, path);
}

export async function setSharedRecallEnabled(on: boolean, path: string = settingsFilePath()): Promise<void> {
  const current = await readSettings(path);
  await writeSettings({ ...current, sharedRecall: { ...current.sharedRecall, enabled: on } }, path);
}

/** Optional override for the auto-detected query language (e.g. "de"). undefined = auto-detect per query. */
export async function getSharedRecallLanguage(path?: string): Promise<string | undefined> {
  return (await readSettings(path)).sharedRecall?.language;
}

export async function setSharedRecallLanguage(language: string, path: string = settingsFilePath()): Promise<void> {
  const current = await readSettings(path);
  const enabled = current.sharedRecall?.enabled ?? false;
  await writeSettings({ ...current, sharedRecall: { enabled, language: language.trim().toLowerCase() } }, path);
}

/** Clears the query-language override, restoring per-query auto-detection. Writes
 *  the sharedRecall block WITHOUT a `language` key (a plain spread would preserve it). */
export async function clearSharedRecallLanguage(path: string = settingsFilePath()): Promise<void> {
  const current = await readSettings(path);
  const enabled = current.sharedRecall?.enabled ?? false;
  await writeSettings({ ...current, sharedRecall: { enabled } }, path);
}

/** Product-docs capture mode. Default "off" (opt-in). */
export async function getDocsMode(path?: string): Promise<DocsMode> {
  return (await readSettings(path)).docs?.mode ?? DEFAULT_DOCS_MODE;
}

export async function setDocsMode(mode: DocsMode, path: string = settingsFilePath()): Promise<void> {
  const current = await readSettings(path);
  await writeSettings({ ...current, docs: { ...current.docs, mode } }, path);
}

/** Language product docs are written in. Default "en". */
export async function getDocsLanguage(path?: string): Promise<string> {
  return (await readSettings(path)).docs?.language ?? DEFAULT_DOCS_LANGUAGE;
}

export async function setDocsLanguage(language: string, path: string = settingsFilePath()): Promise<void> {
  const current = await readSettings(path);
  await writeSettings({ ...current, docs: { ...current.docs, language: language.trim().toLowerCase() } }, path);
}

/** Datei-Größen-Richtwert (Zeilen) für Quellcode; undefined = Default 500. */
export async function getSizeGuide(path?: string): Promise<number | undefined> {
  const v = (await readSettings(path)).size?.guide;
  return typeof v === "number" && Number.isFinite(v) && v >= 100 && v <= 5000 ? Math.round(v) : undefined;
}

export async function setSizeGuide(guide: number, path: string = settingsFilePath()): Promise<void> {
  const n = Math.min(5000, Math.max(100, Math.round(guide)));
  const current = await readSettings(path);
  await writeSettings({ ...current, size: { ...current.size, guide: n } }, path);
}

export async function setApiToken(token: string, path: string = settingsFilePath()): Promise<void> {
  const current = await readSettings(path);
  await writeSettings({ ...current, api: { token } }, path);
}

/** The stored primary authoring language (2-letter ISO code), or undefined when unset. */
export async function getPrimaryLanguage(path?: string): Promise<string | undefined> {
  return (await readSettings(path)).language?.primary;
}

/** Persists the primary authoring language, normalized to a lowercase 2-letter code. */
export async function setPrimaryLanguage(code: string, path: string = settingsFilePath()): Promise<void> {
  const current = await readSettings(path);
  await writeSettings({ ...current, language: { ...current.language, primary: code.trim().toLowerCase() } }, path);
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
  const current = await readSettings(path);
  if (!opts.rotate && current.api?.token) return current.api.token;
  const token = randomBytes(32).toString("base64url");
  await writeSettings({ ...current, api: { token } }, path);
  return token;
}

/**
 * Removes the stored REST API token. After a daemon restart, browser/REST
 * clients that send an Origin are rejected again (back to secure-by-default).
 * Returns true if a token was actually removed, false if none was set.
 */
export async function clearApiToken(path: string = settingsFilePath()): Promise<boolean> {
  const current = await readSettings(path);
  if (!current.api?.token) return false;
  const next = { ...current };
  delete next.api;
  await writeSettings(next, path);
  return true;
}
