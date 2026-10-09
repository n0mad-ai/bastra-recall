/**
 * bastra-recall local CLI settings — the file itself (split out of
 * settings.ts, #680): the CliSettings shape, key validation, readSettings,
 * the atomic write and the one locked transaction (mutateSettings, #534).
 * The typed per-key accessors stay in settings.ts, which re-exports this
 * module's public surface; see its header for the key reference.
 */
import { parseRetain, parseSize } from "./rm-archive.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { withPathLock } from "./path-lock.js";
import { isSupportedLanguage } from "./learned-recall/language.js";
import { isDaemonEnvKey, type DaemonEnvKey } from "./daemon-spawn-env.js";

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
  // undefined = "no opinion" → daemon falls through to env, else BM25.
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
  // loads a git-synced bridge pool and uses it to widen
  // recall queries. `language` is an optional override for the auto-detected
  // query language (e.g. force "de" when you always search in German).
  sharedRecall?: { enabled: boolean; language?: string; live?: boolean };
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
  // The user's answer to a release's model recommendation (cli/hardware.ts
  // MODEL_RECOMMENDATION), the ONE note every surface that asks shares:
  // `bastra update`, `bastra models`, the SessionStart block and the CLI hint.
  // Keyed by the recommendation's id, so a later recommendation asks again.
  // undefined = not answered. Written by model-recommendation.ts.
  modelRecommendation?: { id: string; answer: ModelRecommendationAnswer; at: string };
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
  // #650: how many days the rm archive keeps a target, per class, as
  // `junk=1,in-git=2,user=2` (rm-archive.ts parseRetain). Env wins:
  // BASTRA_ARCHIVE_RETAIN. `enabled` is the opt-in for bastra's archiving
  // rm and git snapshots (default off); env BASTRA_RM_ARCHIVES wins
  // (bash-pre-patterns.ts archiveMode). #934: `cap` is what the archive may
  // hold in total (default 10 GB), `maxItem` the largest target it takes
  // (default none) — sizes like `5GB`; env BASTRA_ARCHIVE_CAP and
  // BASTRA_ARCHIVE_MAX_ITEM win.
  archive?: { retain?: string; enabled?: boolean; cap?: string; maxItem?: string };
  // #632: battery mode, opt-in (default off). On battery the daemon defers
  // doc2query, skips embedding warm-ups and unloads the model after 60 s idle
  // (power-source.ts). Env BASTRA_BATTERY_SAVER wins.
  battery?: { saver?: boolean };
  // #684: daemon behaviour that exists only as env (DAEMON_ENV_KEYS in
  // daemon-spawn-env.ts), pinned for a daemon the MCP forwarder auto-spawns.
  // Wins over the spawning client's env; a service keeps its own env.
  // Hand-edited, not via `bastra config set` (a map, not a scalar).
  daemon?: { env?: Partial<Record<DaemonEnvKey, string>> };
  // User-Sprache (#231, Language-first recall): primary = 2-stelliger ISO-639-1-
  // Code (lowercase, z.B. "de"). Beim Onboarding aus der identity-Antwort
  // abgeleitet (persistLanguageSetting) oder via `bastra config set
  // language.primary de` gesetzt. Der Session-Hook weist den Agenten an, Memories
  // (Titel, Summary, recall_when) in dieser Sprache zu verfassen — nur echte
  // englische Fachbegriffe (daemon, deploy, hook, …) bleiben als Anker.
  language?: { primary?: string };
  // Code-Awareness (#572-#581): die Repositories, für die ein Graphify-
  // Codegraph gebaut und gelesen wird. undefined/leer = niemand aktiviert,
  // und dann passiert nichts — Recall baut NIE für ein Verzeichnis, das es
  // nur zufällig sieht. Einträge sind absolute, normalisierte Pfade, gesetzt
  // über `bastra code enable/disable`. Env-Notaus: BASTRA_CODE_AWARENESS=off
  // schaltet die Funktion ganz ab, ohne die Liste anzufassen.
  //
  // Bewusst eine Liste in den globalen Settings und keine projektlokale
  // Datei: eine Konfigurationsdatei IM Repo wäre ein Artefakt, das in fremden
  // Checkouts auftaucht und committet werden könnte. Die Aktivierung ist eine
  // Entscheidung dieses Rechners, nicht des Projekts.
  code?: { repos?: string[] };
  // Prompt-lane change-impact delivery (#607): undefined = disabled (default).
  // Resolution + env precedence live in code-graph/prompt-impact-settings.ts,
  // next to the feature; this file only keeps the schema (same split as `code`
  // above).
  promptImpact?: { enabled?: boolean };
}

// "asked" is not an answer: the question was put to the user on a terminal and
// got none (Ctrl-C). It keeps every other surface asking and only stops the
// terminal from asking a second time for the same recommendation.
export const MODEL_RECOMMENDATION_ANSWERS = ["switched", "later", "dismissed", "asked"] as const;
export type ModelRecommendationAnswer = (typeof MODEL_RECOMMENDATION_ANSWERS)[number];

/**
 * Default generation (doc2query + rerank) model: what runs when NO choice was
 * ever stored and no env variable names one.
 *
 * It is not what a new install is offered — that is cli/hardware.ts
 * (tev1:4b from 16 GB, gemma4:12b from 32 GB), and the installer stores the
 * pick it pulled. This constant stays gemma3:4b on purpose: changing it would
 * silently switch every existing install without a stored choice to a model
 * that is not on their disk.
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
 * Jeder Block, den `readSettings` kennt. Alles andere überlebt ein Schreiben
 * NICHT: `readSettings` baut das Objekt neu auf, und `writeSettings`
 * veröffentlicht genau dieses Objekt.
 *
 * #534 verlangt, dass diese Entscheidung ausgesprochen wird statt als
 * Nebenwirkung zu passieren. Sie lautet: unbekannte Schlüssel werden
 * abgelehnt, nicht durchgereicht — eine Einstellung, die dieser Build nicht
 * versteht, kann er auch nicht korrekt fortschreiben. Damit das niemanden
 * still erwischt (etwa nach einem Downgrade), sagt der Leser es auf stderr.
 */
const KNOWN_SETTINGS_KEYS: readonly string[] = [
  "update",
  "embedding",
  "ollama",
  "api",
  "cors",
  "commons",
  "sharedRecall",
  "evidenceGate",
  "experiment",
  "docs",
  "generation",
  "modelRecommendation",
  "ui",
  "reflex",
  "size",
  "language",
  "code",
  "promptImpact",
  "archive",
  "battery",
  "daemon",
];

function warnAboutUnknownKeys(data: unknown, path: string): void {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return;
  const unknown = Object.keys(data).filter((k) => !KNOWN_SETTINGS_KEYS.includes(k));
  if (unknown.length === 0) return;
  process.stderr.write(
    `[bastra-recall] cli-settings.json: unknown key(s) ${unknown.join(", ")} — this build does not understand them and the next write will drop them (${path})\n`,
  );
}

/**
 * True when the file exists, has content, and is not valid JSON — the one
 * state in which `readSettings` hands out defaults for settings that are
 * really there, and a write would replace the file with those defaults. A
 * caller that must not lose the user's other settings asks this first.
 */
export async function settingsFileIsCorrupt(path: string = settingsFilePath()): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return false;
  }
  if (raw.trim() === "") return false;
  try {
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
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

  let data: { update?: { mode?: unknown }; embedding?: { provider?: unknown }; ollama?: { autostart?: unknown }; api?: { token?: unknown }; cors?: { origins?: unknown }; commons?: { enabled?: unknown }; sharedRecall?: { enabled?: unknown; language?: unknown; live?: unknown }; docs?: { mode?: unknown; language?: unknown }; generation?: { model?: unknown }; ui?: { enabled?: unknown }; reflex?: { enabled?: unknown; maxPerTurn?: unknown }; evidenceGate?: { enabled?: unknown } };
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

  warnAboutUnknownKeys(data, path);

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
    const sr: { enabled: boolean; language?: string; live?: boolean } = { enabled: data.sharedRecall.enabled };
    // Bridges owner decision 2026-09-29: live query expansion is opt-in.
    if (typeof data.sharedRecall.live === "boolean") sr.live = data.sharedRecall.live;
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
  const recData = (data as { modelRecommendation?: { id?: unknown; answer?: unknown; at?: unknown } }).modelRecommendation;
  if (
    typeof recData?.id === "string" &&
    typeof recData.at === "string" &&
    (MODEL_RECOMMENDATION_ANSWERS as readonly unknown[]).includes(recData.answer)
  ) {
    settings.modelRecommendation = { id: recData.id, answer: recData.answer as ModelRecommendationAnswer, at: recData.at };
  }
  if (typeof data?.ui?.enabled === "boolean") {
    settings.ui = { enabled: data.ui.enabled };
  }
  // #422: der Block wurde von `setEvidenceGateEnabled` geschrieben, aber hier
  // nie zurückgelesen — die Datei konnte den Entscheid nicht schalten, nur der
  // Env-Schalter. Seit dem Default `true` ist das dauerhafte Aus genau dieser
  // Block, also muss er ankommen.
  if (typeof data?.evidenceGate?.enabled === "boolean") {
    settings.evidenceGate = { enabled: data.evidenceGate.enabled };
  }
  // #425: derselbe Befund eine Stufe weiter — `setEvidenceGateEnabled` hatte
  // ihn für den Evidenzentscheid, der Experimentblock hat ihn bis hierher
  // behalten. Er wurde nie zurückgelesen, also lieferte `getExperimentConfig`
  // auch bei gültiger Datei `null` und jedes Ereignis blieb `unassigned`.
  // Geprüft wird hier genau das, was der Typ verlangt; die fachliche Regel
  // "mindestens zwei Arme" bleibt in getExperimentConfig, wo sie ihre
  // Begründung hat.
  const expData = (data as { experiment?: { name?: unknown; arms?: unknown; registration?: unknown; registration_version?: unknown } }).experiment;
  if (expData !== undefined) {
    const arms = Array.isArray(expData.arms)
      ? expData.arms.filter((a): a is string => typeof a === "string" && a.trim().length > 0).map((a) => a.trim())
      : undefined;
    if (
      typeof expData.name === "string" &&
      expData.name.trim().length > 0 &&
      arms !== undefined &&
      arms.length > 0 &&
      typeof expData.registration === "string" &&
      expData.registration.trim().length > 0 &&
      typeof expData.registration_version === "number" &&
      Number.isFinite(expData.registration_version)
    ) {
      settings.experiment = {
        name: expData.name.trim(),
        arms,
        registration: expData.registration.trim(),
        registration_version: expData.registration_version,
      };
    } else {
      process.stderr.write(
        `[bastra-recall] cli-settings.json: ignoring invalid experiment block (needs name, arms, registration, registration_version) ${JSON.stringify(expData)}\n`,
      );
    }
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
  const archiveData = (data as { archive?: { retain?: unknown; enabled?: unknown; cap?: unknown; maxItem?: unknown } }).archive;
  if (archiveData !== undefined && archiveData !== null) {
    const archive: NonNullable<CliSettings["archive"]> = {};
    if (typeof archiveData.retain === "string" && parseRetain(archiveData.retain)) archive.retain = archiveData.retain;
    if (typeof archiveData.enabled === "boolean") archive.enabled = archiveData.enabled;
    if (typeof archiveData.cap === "string" && parseSize(archiveData.cap)) archive.cap = archiveData.cap;
    if (typeof archiveData.maxItem === "string" && parseSize(archiveData.maxItem)) archive.maxItem = archiveData.maxItem;
    if (Object.keys(archive).length > 0) settings.archive = archive;
  }
  const batterySaver = (data as { battery?: { saver?: unknown } }).battery?.saver;
  if (typeof batterySaver === "boolean") settings.battery = { saver: batterySaver };
  const daemonEnv = (data as { daemon?: { env?: unknown } }).daemon?.env;
  if (daemonEnv !== undefined && daemonEnv !== null && typeof daemonEnv === "object" && !Array.isArray(daemonEnv)) {
    const env: Partial<Record<DaemonEnvKey, string>> = {};
    for (const [k, v] of Object.entries(daemonEnv)) {
      if (isDaemonEnvKey(k) && typeof v === "string") env[k] = v;
      else process.stderr.write(`[bastra-recall] cli-settings.json: ignoring daemon.env.${k} (not a documented daemon key with a string value)\n`);
    }
    if (Object.keys(env).length > 0) settings.daemon = { env };
  }
  const codeData = (data as { code?: { repos?: unknown } }).code;
  if (codeData !== undefined && Array.isArray(codeData.repos)) {
    // Parsed here, or the list would not survive the next write of any other
    // field — parseSettings rebuilds the object and unknown keys are dropped.
    // Blanks and non-strings are filtered rather than rejected: one broken
    // entry must not take the other enabled repositories down with it.
    const repos = codeData.repos
      .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
      .map((r) => r.trim());
    if (repos.length > 0) settings.code = { repos };
  }
  const promptImpactEnabled = (data as { promptImpact?: { enabled?: unknown } }).promptImpact?.enabled;
  if (typeof promptImpactEnabled === "boolean") {
    settings.promptImpact = { enabled: promptImpactEnabled };
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

/**
 * #534: die EINE Settings-Transaktion. Lesen, ändern und Schreiben laufen
 * unter demselben Lock (path-lock.ts, prozessübergreifend — CLI,
 * Onboarding-Assistent und Daemon sind eigene Prozesse), damit zwei Mutationen
 * unterschiedlicher Felder nicht mehr denselben Ausgangsstand lesen und sich
 * gegenseitig überschreiben. JEDER Setter geht hier durch — ein Setter, der an
 * `readSettings` + `writeSettings` vorbei direkt schreibt, bringt das Rennen
 * zurück.
 *
 * `mutate` bekommt den frisch gelesenen Stand und gibt den zu schreibenden
 * zurück, oder `null` für "nichts zu tun" (z.B. ein CORS-Origin, das schon
 * erlaubt ist). Rückgabewerte für den Aufrufer laufen über den Closure.
 *
 * Exportiert (17.09.2026), damit ein Setter auch in seinem Fachmodul stehen
 * kann statt in dieser Datei — sie liegt über dem 800-Zeilen-Deckel der
 * Größenkonvention, und "alle Setter hier" wäre der Grund, aus dem sie weiter
 * wächst. Die Invariante von #534 ändert sich dadurch NICHT: ein Setter
 * außerhalb muss ebenfalls hier durch, nicht an `readSettings` +
 * `writeSettings` vorbei.
 */
export async function mutateSettings(
  path: string,
  mutate: (current: CliSettings) => CliSettings | null,
): Promise<void> {
  await withPathLock(
    path,
    async () => {
      const next = mutate(await readSettings(path));
      if (next !== null) await writeSettings(next, path);
    },
    { crossProcess: true },
  );
}
