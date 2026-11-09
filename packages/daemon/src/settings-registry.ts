import { DEFAULT_UPDATE_MODE, DEFAULT_DOCS_MODE, DEFAULT_DOCS_LANGUAGE, GENERATION_MODEL_DEFAULT, TASKS_DEFAULT, TELEMETRY_DEFAULT, EVIDENCE_GATE_DEFAULT } from "./settings-defaults.js";
export { DEFAULT_UPDATE_MODE, DEFAULT_DOCS_MODE, DEFAULT_DOCS_LANGUAGE, GENERATION_MODEL_DEFAULT } from "./settings-defaults.js";
/** The settings contract: type, validation, defaults and presentation share one entry. */
import { z } from "zod";
import { normalizeAssistantName } from "./assistant-address-name.js";
import { parseRetain, parseSize } from "./rm-archive-reconcile.js";
import { isDaemonEnvKey, type DaemonEnvKey } from "./daemon-spawn-env.js";

export const UPDATE_MODES = ["notify", "auto", "off"] as const;
export const EMBEDDING_PROVIDERS = ["ollama", "openai", "none"] as const;
export const DOCS_MODES = ["off", "suggest", "auto"] as const;
export const MODEL_RECOMMENDATION_ANSWERS = ["switched", "later", "dismissed", "asked"] as const;
export type UpdateMode = (typeof UPDATE_MODES)[number];
export type EmbeddingProviderName = (typeof EMBEDDING_PROVIDERS)[number];
export type DocsMode = (typeof DOCS_MODES)[number];
export type ModelRecommendationAnswer = (typeof MODEL_RECOMMENDATION_ANSWERS)[number];

type Area = "general" | "search" | "hooks" | "code" | "archive" | "tasks" | "access" | "updates";
interface Metadata { area: Area; label: string; default: unknown; env?: string; restartRequired?: boolean; secret?: boolean; required?: true; readonly?: boolean; alias?: string; }
function setting<S extends z.ZodType, M extends Metadata>(schema: S, metadata: M) { return { schema, ...metadata }; }
const bool = z.boolean(), text = z.string().trim().min(1), finite = z.number().finite();
const tag = z.string().trim().regex(/^[a-z]{2}(-[a-z]{2,4})?$/i).transform(s => s.toLowerCase());
const primary = z.string().trim().regex(/^[a-z]{2}$/i).transform(s => s.toLowerCase());
const strings = z.array(z.unknown()).transform(rows => rows.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map(v => v.trim()));
const nonemptyStrings = strings.refine(rows => rows.length > 0);
export function normalizeCorsOrigin(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try { const u = new URL(v.trim());
    if (!["http:", "https:"].includes(u.protocol) || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username || u.password) return null;
    return u.origin;
  } catch { return null; }
}
const corsOrigins = z.array(z.unknown()).transform(rows => [...new Set(rows.map(normalizeCorsOrigin).filter((v): v is string => v !== null))]).refine(rows => rows.length > 0);
const daemonEnv = z.record(z.string(), z.unknown()).transform(raw => Object.fromEntries(Object.entries(raw).filter(([k,v]) => isDaemonEnvKey(k) && typeof v === "string")) as Partial<Record<DaemonEnvKey,string>>).refine(v => Object.keys(v).length > 0);

export const SETTINGS_REGISTRY = {
  update: { mode: setting(z.enum(UPDATE_MODES), { area: "updates", label: "Aktualisierungen", default: DEFAULT_UPDATE_MODE, env: "BASTRA_UPDATE_CHECK", required: true }) },
  embedding: { provider: setting(z.enum(EMBEDDING_PROVIDERS), { area: "search", label: "Embedding-Anbieter", default: null, env: "BASTRA_EMBEDDING_PROVIDER", restartRequired: true, required: true }) },
  ollama: { autostart: setting(bool, { area: "search", label: "Ollama automatisch starten", default: true, restartRequired: true, required: true }) },
  api: { token: setting(z.string().min(1), { area: "access", label: "API-Zugangsschlüssel", default: null, env: "BASTRA_API_TOKEN", restartRequired: true, secret: true, required: true }) },
  cors: { origins: setting(corsOrigins, { area: "access", label: "Erlaubte Browser-Ursprünge", default: [], env: "BASTRA_CORS_ORIGIN", restartRequired: true, required: true }) },
  commons: { enabled: setting(bool, { area: "search", label: "Bastra Commons", default: false, restartRequired: true, required: true }) },
  sharedRecall: {
    enabled: setting(bool, { area: "search", label: "Gelernte Brücken", default: false, restartRequired: true, required: true }),
    language: setting(z.string().trim().toLowerCase().refine((v): boolean => v === "de" || v === "en"), { area: "search", label: "Brückensprache", default: null, restartRequired: true }),
    live: setting(bool, { area: "search", label: "Live-Brückenerweiterung", default: false, restartRequired: true }),
  },
  evidenceGate: { enabled: setting(bool, { area: "hooks", label: "Evidenzentscheid", default: EVIDENCE_GATE_DEFAULT, env: "BASTRA_EVIDENCE_GATE", restartRequired: true, required: true }) },
  experiment: {
    name: setting(text, { area: "hooks", label: "Experiment", restartRequired: true, default: null, required: true }),
    arms: setting(nonemptyStrings, { area: "hooks", label: "Experiment-Arme", restartRequired: true, default: [], required: true }),
    registration: setting(text, { area: "hooks", label: "Experiment-Registrierung", restartRequired: true, default: null, required: true }),
    registration_version: setting(finite, { area: "hooks", label: "Registrierungsversion", restartRequired: true, default: null, required: true }),
  },
  docs: {
    mode: setting(z.enum(DOCS_MODES), { area: "general", label: "Produktanleitungen", default: DEFAULT_DOCS_MODE }),
    language: setting(tag, { area: "general", label: "Sprache der Anleitungen", default: DEFAULT_DOCS_LANGUAGE }),
  },
  generation: { model: setting(text, { area: "search", label: "Generierungsmodell", default: GENERATION_MODEL_DEFAULT, env: "BASTRA_EXPAND_MODEL", restartRequired: true, required: true }) },
  modelRecommendation: {
    id: setting(z.string(), { area: "updates", label: "Modell-Empfehlung", default: null, readonly: true, required: true }),
    answer: setting(z.enum(MODEL_RECOMMENDATION_ANSWERS), { area: "updates", label: "Empfehlungsantwort", default: null, readonly: true, required: true }),
    at: setting(z.string(), { area: "updates", label: "Antwortzeitpunkt", default: null, readonly: true, required: true }),
  },
  ui: { enabled: setting(bool, { area: "general", label: "Web-Oberfläche", default: false, required: true }) },
  assistant: { name: setting(z.string().transform((value,ctx) => { try { return normalizeAssistantName(value); } catch { ctx.addIssue({code:"custom",message:"Invalid assistant name"}); return z.NEVER; } }), { area: "general", label: "Name des Assistenten", default: null, required: true }) },
  reflex: {
    enabled: setting(bool, { area: "hooks", label: "Reflex", default: true, env: "BASTRA_REFLEX" }),
    maxPerTurn: setting(z.number().int().min(1).max(5), { area: "hooks", label: "Reflex-Treffer je Runde", default: 2, env: "BASTRA_REFLEX_MAX_PER_TURN" }),
  },
  size: {
    guide: setting(finite, { area: "hooks", label: "Dateigröße: Richtwert", default: 500, env: "BASTRA_SIZE_GUIDE" }),
    critical: setting(finite, { area: "hooks", label: "Dateigröße: Warnschwelle", default: 800, env: "BASTRA_SIZE_CRITICAL" }),
    exemptPaths: setting(nonemptyStrings, { area: "hooks", label: "Ausgenommene Pfadteile", default: [] }),
  },
  archive: {
    retain: setting(z.string().refine(v => !!parseRetain(v)), { area: "archive", label: "Aufbewahrung je Klasse", default: "junk=1,in-git=2,user=2", env: "BASTRA_ARCHIVE_RETAIN" }),
    enabled: setting(bool, { area: "archive", label: "Archivierung", default: false, env: "BASTRA_RM_ARCHIVES" }),
    cap: setting(z.string().refine(v => !!parseSize(v)), { area: "archive", label: "Archiv: Gesamtgröße", default: "10GB", env: "BASTRA_ARCHIVE_CAP" }),
    maxItem: setting(z.string().refine(v => !!parseSize(v)), { area: "archive", label: "Archiv: Grenze je Datei", default: null, env: "BASTRA_ARCHIVE_MAX_ITEM", alias: "archive.max-item" }),
  },
  battery: { saver: setting(bool, { area: "general", label: "Akkumodus", default: false, env: "BASTRA_BATTERY_SAVER", restartRequired: true }) },
  daemon: { env: setting(daemonEnv, { area: "general", label: "Daemon-Umgebung", default: {}, restartRequired: true, secret: true }) },
  language: { primary: setting(primary, { area: "general", label: "Eigene Sprache", default: null }) },
  code: { repos: setting(nonemptyStrings, { area: "code", label: "Aktivierte Repositories", default: [], restartRequired: true }) },
  promptImpact: { enabled: setting(bool, { area: "code", label: "Änderungsfolgen im Prompt", default: false, env: "BASTRA_PROMPT_IMPACT" }) },
  coverageMap: { enabled: setting(bool, { area: "code", label: "Testabdeckung erfassen", default: false, env: "BASTRA_COVERAGE_MAP" }) },
  tasks: { enabled: setting(bool, { area: "tasks", label: "Aufgaben (Vorschau)", default: TASKS_DEFAULT, env: "BASTRA_TASKS", restartRequired: true, required: true }) },
  telemetry: { enabled: setting(bool, { area: "general", label: "Lokale Telemetrie", default: TELEMETRY_DEFAULT, env: "BASTRA_TELEMETRY", restartRequired: true, required: true }) },
} as const;

type Registry = typeof SETTINGS_REGISTRY;
type Value<E> = E extends { schema: infer S extends z.ZodType } ? z.output<S> : never;
type RequiredKeys<G> = { [K in keyof G]: G[K] extends { required: true } ? K : never }[keyof G];
type Block<G> = { [K in RequiredKeys<G>]: Value<G[K]> } & { [K in Exclude<keyof G,RequiredKeys<G>>]?: Value<G[K]> };
export type CliSettings = { update: Block<Registry["update"]> } & { [K in Exclude<keyof Registry,"update">]?: Block<Registry[K]> };
export interface SettingEntry extends Metadata { key: string; path: readonly [string,string]; schema: z.ZodType; kind: "boolean" | "number" | "string" | "json"; choices?: readonly string[]; }
export function settingEntries(): SettingEntry[] {
  return Object.entries(SETTINGS_REGISTRY).flatMap(([group,fields]) => Object.entries(fields).map(([field,spec]) => {
    const example = spec.schema.safeParse(spec.default);
    const type = example.success ? typeof example.data : spec.schema.type;
    const kind = type === "boolean" ? "boolean" : type === "number" ? "number" : (Array.isArray(spec.default) || (spec.default !== null && typeof spec.default === "object")) || (example.success && typeof example.data === "object") ? "json" : "string";
    const choices = spec.schema instanceof z.ZodEnum ? spec.schema.options as string[] : undefined;
    return { ...spec, key: "alias" in spec ? spec.alias : `${group}.${field}`, path: [group,field] as const, kind, ...(choices ? {choices} : {}) } as SettingEntry;
  }));
}
export function settingEntry(key: string): SettingEntry | undefined { return settingEntries().find(e => e.key === key || e.path.join(".") === key); }
export function parseSettingValue(key: string, value: unknown): unknown {
  const entry = settingEntry(key);
  if (!entry || entry.readonly) throw new Error("Unknown or read-only setting");
  const parsed = entry.schema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid value for ${entry.key}`);
  return parsed.data;
}
/** Lenient legacy normalization: invalid leaves are dropped, required blocks stay atomic. */
export function parseStoredSettings(raw: unknown): CliSettings {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string,unknown> : {};
  const out: Record<string,unknown> = { update: { mode: DEFAULT_UPDATE_MODE } };
  for (const [group,fields] of Object.entries(SETTINGS_REGISTRY)) {
    const input = source[group];
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    const block: Record<string,unknown> = {};
    for (const [field,spec] of Object.entries(fields)) {
      const parsed = spec.schema.safeParse((input as Record<string,unknown>)[field]);
      if (parsed.success) block[field] = parsed.data;
    }
    const incomplete = Object.entries(fields).some(([field,spec]) => "required" in spec && spec.required && !(field in block));
    if (Object.keys(block).length && !incomplete) out[group] = block;
  }
  return out as CliSettings;
}
export function storedSetting(settings: CliSettings, entry: SettingEntry): unknown {
  return (settings as unknown as Record<string,Record<string,unknown> | undefined>)[entry.path[0]]?.[entry.path[1]];
}
export function applySettingChanges(current: CliSettings, changes: Record<string,unknown>): CliSettings {
  const next = structuredClone(current) as unknown as Record<string,Record<string,unknown>>;
  for (const [key,value] of Object.entries(changes)) {
    const entry = settingEntry(key);
    if (!entry || entry.readonly) throw new Error("Unknown or read-only setting");
    const [group,field] = entry.path;
    if (value === null) { if (next[group]) delete next[group][field]; continue; }
    const parsed = parseSettingValue(key,value);
    next[group] ??= {};
    next[group][field] = parsed;
    for (const required of settingEntries().filter(e => e.path[0] === group && e.required)) {
      if (!(required.path[1] in next[group]) && required.default !== null) next[group][required.path[1]] = required.default;
    }
  }
  const normalized = parseStoredSettings(next);
  for (const [key,value] of Object.entries(changes)) {
    if(value !== null && storedSetting(normalized, settingEntry(key)!) === undefined) throw new Error("Incomplete settings block");
  }
  return normalized;
}
