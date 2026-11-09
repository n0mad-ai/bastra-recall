/** Local settings persistence. Registry owns the shape and validation. */
import { bastraDataDir } from "./platform-paths.js";
import { join } from "node:path";
import { withPathLock } from "./path-lock.js";
import { readAppRecord, writeAppRecord } from "./app-record-store.js";
import { SETTINGS_REGISTRY, parseStoredSettings, DEFAULT_UPDATE_MODE, type CliSettings, type DocsMode, type EmbeddingProviderName } from "./settings-registry.js";
export * from "./settings-registry.js";

export function settingsFilePath(): string {
  return join(bastraDataDir(), "cli-settings.json");
}

export function isDocsMode(v: unknown): v is DocsMode {
  return typeof v === "string" && SETTINGS_REGISTRY.docs.mode.schema.safeParse(v).success;
}

/** Doc language is a free short tag ("en", "de", "pt-br") — not an enum. */
export function isDocsLanguage(v: unknown): v is string {
  return typeof v === "string" && SETTINGS_REGISTRY.docs.language.schema.safeParse(v).success;
}

/** Primary authoring language: a 2-letter ISO-639-1 code (case-insensitive input). */
export function isPrimaryLanguage(v: unknown): v is string {
  return typeof v === "string" && SETTINGS_REGISTRY.language.primary.schema.safeParse(v).success;
}

export function isEmbeddingProviderName(v: unknown): v is EmbeddingProviderName {
  return typeof v === "string" && SETTINGS_REGISTRY.embedding.provider.schema.safeParse(v).success;
}

/**
 * Normalizes a CORS origin to its bare `scheme://host[:port]` form (what the
 * browser sends in the Origin header, so http.ts can compare it byte-for-byte
 * against reqOrigin). Returns null for anything that isn't an http(s) origin
 * without a path/query/hash/credentials — those are dropped, never stored.
 */
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
const KNOWN_SETTINGS_KEYS = Object.keys(SETTINGS_REGISTRY);

function warnAboutUnknownKeys(data: unknown, path: string): void {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return;
  const unknown = Object.keys(data).filter((k) => !KNOWN_SETTINGS_KEYS.includes(k));
  if (unknown.length === 0) return;
  process.stderr.write(
    `[bastra-recall] cli-settings.json: unknown key(s) ${unknown.join(", ")} — this build does not understand them and the next write will drop them (${path})\n`,
  );
}

/**
 * What is on disk, as far as a WRITER has to know before it replaces the file:
 *
 *   - "ok"          readable, valid JSON
 *   - "missing"     not there (or empty) — defaults are the truth
 *   - "corrupt"     there, readable, not valid JSON
 *   - { unreadable } there, but it could not be read (EACCES, EISDIR, EIO …)
 *
 * `readSettings` hands out defaults in the last two cases as well, and for a
 * reader that is the right fallback. For a writer it is not: defaults plus one
 * changed field, written back, erase every setting that IS in the file. Only
 * "the file does not exist" (ENOENT, or a missing parent: ENOTDIR) may be read
 * as "there are no settings".
 */
export type SettingsFileState = "ok" | "missing" | "corrupt" | { unreadable: string };

export async function settingsFileState(path: string = settingsFilePath()): Promise<SettingsFileState> {
  const file = await readSettingsText(path);
  if (file.state !== "text") return file.state;
  try {
    JSON.parse(file.raw);
    return "ok";
  } catch {
    return "corrupt";
  }
}

/** The ONE read of the file: its text, or why there is none. */
async function readSettingsText(
  path: string,
): Promise<{ state: "missing" } | { state: { unreadable: string } } | { state: "text"; raw: string }> {
  let raw: string;
  try {
    raw = readAppRecord("settings", path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "read failed";
    return code === "ENOENT" || code === "ENOTDIR" ? { state: "missing" } : { state: { unreadable: code } };
  }
  return raw.trim() === "" ? { state: "missing" } : { state: "text", raw };
}

/**
 * The file as ONE consistent snapshot: what state it is in, and the settings
 * parsed from the very text that state was judged on.
 *
 * This is what a writer has to work from. Judging the file with one read and
 * taking the settings from a second leaves a gap: a transient error (EAGAIN,
 * EBUSY, EIO) or a file damaged in between gives the second read defaults,
 * and the writer puts them back over the user's settings. With a single read
 * there is no second answer to disagree with the first.
 */
async function readSettingsSnapshot(path: string): Promise<{ state: SettingsFileState; settings: CliSettings }> {
  const file = await readSettingsText(path);
  if (file.state !== "text") return { state: file.state, settings: { update: { mode: DEFAULT_UPDATE_MODE } } };
  const parsed = parseSettingsText(file.raw, path);
  return { state: parsed.corrupt ? "corrupt" : "ok", settings: parsed.settings };
}

/** Why a writer that must not lose settings refuses this file, or null. No
 *  path in the text: it is printed, and may end up in a chat transcript. */
export function settingsFileRefusal(state: SettingsFileState, opts: { refuseCorrupt?: boolean } = {}): string | null {
  if (typeof state === "object") return `the settings file exists but cannot be read (${state.unreadable}) — nothing was written to it`;
  if (state === "corrupt" && opts.refuseCorrupt) return "the settings file is not valid JSON — fix or delete it first (bastra names the file on every run)";
  return null;
}

/**
 * Reads stored settings. A missing file → silent defaults (normal: not created
 * yet). A *corrupt* file → loud warning + defaults, and we do NOT silently
 * revert (callers that write will repair it). Never throws.
 */
export async function readSettings(path: string = settingsFilePath()): Promise<CliSettings> {
  return (await readSettingsSnapshot(path)).settings;
}

/** Validates the file's text into settings. `corrupt` = not JSON at all (and
 *  said so on stderr); the settings are the defaults then. */
function parseSettingsText(raw: string, path: string): { settings: CliSettings; corrupt: boolean } {
  let data: unknown;
  try { data = JSON.parse(raw); }
  catch {
    // Never include JSON parser snippets: they may contain API tokens.
    process.stderr.write(`[bastra-recall] cli-settings.json is corrupt — using defaults. Fix or restore ${path}\n`);
    return { settings: { update: { mode: DEFAULT_UPDATE_MODE } }, corrupt: true };
  }
  warnAboutUnknownKeys(data, path);
  return { settings: parseStoredSettings(data), corrupt: false };
}

/** A committed DB record; imported originals remain at <path>.pre-db. */
async function writeSettings(next: CliSettings, path: string): Promise<void> {
  writeAppRecord("settings", path, JSON.stringify(next, null, 2) + "\n");
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
 * Eine vorhandene, aber NICHT LESBARE Datei (EACCES, EISDIR …) wird nie
 * überschrieben: `readSettings` liefert dafür Defaults, und Defaults plus ein
 * geändertes Feld zurückzuschreiben löscht jede Einstellung, die in der Datei
 * steht (Gegenreview #1118: Modus 0200, ein Setter, und Generation/Embedding/
 * API-Token waren weg). Das gilt für JEDEN Setter — der Fehler ist nicht
 * modellspezifisch. Geprüft wird unter dem Lock, und zwar an GENAU DER einen
 * Lesung, deren geparster Inhalt danach mutiert wird — eine zweite Lesung
 * (`readSettings`) kommt im Schreibpfad nicht vor, denn ihre Leser-Defaults
 * wären bei einem kurzzeitigen Lesefehler wieder das, was zurückgeschrieben wird. Eine KORRUPTE Datei reparieren die bisherigen Setter
 * weiterhin (dokumentiertes Verhalten von `readSettings`); wer auch das nicht
 * darf, setzt `refuseCorrupt`.
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
  opts: { refuseCorrupt?: boolean; requireLock?: boolean } = {},
): Promise<void> {
  await withPathLock(
    path,
    async () => {
      // One read: the state that decides whether to write and the settings
      // that get changed come from the same text (readSettingsSnapshot).
      const { state, settings } = await readSettingsSnapshot(path);
      const refusal = settingsFileRefusal(state, opts);
      if (refusal) throw new Error(refusal);
      const next = mutate(settings);
      if (next !== null) await writeSettings(next, path);
    },
    // `requireLock`: reject instead of writing without the cross-process lock
    // (path-lock.ts). For the model answers and the question claim; every
    // other setter keeps path-lock's fail-open.
    { crossProcess: true, requireLock: opts.requireLock },
  );
}
