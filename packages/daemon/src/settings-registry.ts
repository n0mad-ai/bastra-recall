import {
  DEFAULT_UPDATE_MODE,
  DEFAULT_DOCS_MODE,
  DEFAULT_DOCS_LANGUAGE,
  GENERATION_MODEL_DEFAULT,
  TASKS_DEFAULT,
  TELEMETRY_DEFAULT,
  EVIDENCE_GATE_DEFAULT,
} from "./settings-defaults.js";
export {
  DEFAULT_UPDATE_MODE,
  DEFAULT_DOCS_MODE,
  DEFAULT_DOCS_LANGUAGE,
  GENERATION_MODEL_DEFAULT,
} from "./settings-defaults.js";
/** The settings contract: type, validation, defaults and presentation share one entry. */
import { z } from "zod";
import { normalizeAssistantName, normalizeAssistantDisplayName } from "./assistant-address-name.js";
import { parseRetain, parseSize } from "./rm-archive-reconcile.js";
import { isDaemonEnvKey, type DaemonEnvKey } from "./daemon-spawn-env.js";
import { isSupportedLanguage } from "./learned-recall/language.js";
import { SOUL_DIRECTIONS, SOUL_TEXT_MAX } from "./soul.js";
import { webUiOnByDefault } from "./local-account-access.js";
import { parseReportUndo, REPORT_UNDO_DEFAULT } from "./task-report-undo-window.js";

export const UPDATE_MODES = ["notify", "auto", "off"] as const;
export const EMBEDDING_PROVIDERS = ["ollama", "openai", "none"] as const;
export const DOCS_MODES = ["off", "suggest", "auto"] as const;
export const MODEL_RECOMMENDATION_ANSWERS = ["switched", "later", "dismissed", "asked"] as const;
/** Background image of the web UI: "none", a preset shipped with the UI, or a local upload (ui-backdrop.ts). */
export const BACKDROP_PRESETS = ["none", "aurora", "deepsea", "ember", "topo", "grid", "dusk"] as const;
export const BACKDROP_UPLOAD_ID = /^up-[0-9a-f]{16}$/;
const BACKDROP_ID = new RegExp(`^(?:${BACKDROP_PRESETS.join("|")}|up-[0-9a-f]{16})$`);
export type UpdateMode = (typeof UPDATE_MODES)[number];
export type EmbeddingProviderName = (typeof EMBEDDING_PROVIDERS)[number];
export type DocsMode = (typeof DOCS_MODES)[number];
export type ModelRecommendationAnswer = (typeof MODEL_RECOMMENDATION_ANSWERS)[number];

type Area = "general" | "search" | "hooks" | "code" | "archive" | "tasks" | "access" | "updates";
interface Metadata {
  area: Area;
  label: string;
  default: unknown;
  env?: string;
  restartRequired?: boolean;
  secret?: boolean;
  required?: true;
  readonly?: boolean;
  alias?: string;
}
/** Property descriptors are copied, not values, so a getter default (ui.enabled) is read on every access. */
function setting<S extends z.ZodType, M extends Metadata>(schema: S, metadata: M): { schema: S } & M {
  return Object.defineProperties({ schema }, Object.getOwnPropertyDescriptors(metadata)) as { schema: S } & M;
}
const bool = z.boolean(),
  text = z.string().trim().min(1),
  finite = z.number().finite();
const tag = z
  .string()
  .trim()
  .regex(/^[a-z]{2}(-[a-z]{2,4})?$/i)
  .transform((s) => s.toLowerCase());
const primary = z
  .string()
  .trim()
  .regex(/^[a-z]{2}$/i)
  .transform((s) => s.toLowerCase());
const strings = z
  .array(z.unknown())
  .transform((rows) =>
    rows.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
  );
const nonemptyStrings = strings.refine((rows) => rows.length > 0);
/** Zod schema from a throwing normalizer (assistant names). */
function normalized(normalize: (value: string) => string, message: string) {
  return z.string().transform((value, ctx) => {
    try {
      return normalize(value);
    } catch {
      ctx.addIssue({ code: "custom", message });
      return z.NEVER;
    }
  });
}
export function normalizeCorsOrigin(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v.trim());
    if (
      !["http:", "https:"].includes(u.protocol) ||
      (u.pathname !== "/" && u.pathname !== "") ||
      u.search ||
      u.hash ||
      u.username ||
      u.password
    )
      return null;
    return u.origin;
  } catch {
    return null;
  }
}
/**
 * #1198 `ui.public_origin`: exactly an `https://` origin (no path, query,
 * fragment or user info) whose host is not a loopback name; returned in the
 * normalized `https://host[:port]` form. Anything else is refused.
 */
export function normalizePublicUiOrigin(v: unknown): string | null {
  if (typeof v !== "string" || v !== v.trim()) return null;
  try {
    const u = new URL(v);
    if (
      u.protocol !== "https:" ||
      (u.pathname !== "/" && u.pathname !== "") ||
      u.search ||
      u.hash ||
      v.includes("?") ||
      v.includes("#") ||
      u.username ||
      u.password ||
      /^(?:localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)
    )
      return null;
    return u.origin;
  } catch {
    return null;
  }
}
function publicUiOrigin(value: string, ctx: z.RefinementCtx): string {
  const origin = normalizePublicUiOrigin(value);
  if (origin === null) {
    ctx.addIssue({ code: "custom", message: "Invalid public web UI origin" });
    return z.NEVER;
  }
  return origin;
}
const corsOrigins = z
  .array(z.unknown())
  .transform((rows) => [...new Set(rows.map(normalizeCorsOrigin).filter((v): v is string => v !== null))])
  .refine((rows) => rows.length > 0);
const daemonEnv = z
  .record(z.string(), z.unknown())
  .transform(
    (raw) =>
      Object.fromEntries(Object.entries(raw).filter(([k, v]) => isDaemonEnvKey(k) && typeof v === "string")) as Partial<
        Record<DaemonEnvKey, string>
      >
  )
  .refine((v) => Object.keys(v).length > 0);

export const SETTINGS_REGISTRY = {
  update: {
    mode: setting(z.enum(UPDATE_MODES), {
      area: "updates",
      label: "Aktualisierungen",
      default: DEFAULT_UPDATE_MODE,
      env: "BASTRA_UPDATE_CHECK",
      required: true,
    }),
  },
  embedding: {
    provider: setting(z.enum(EMBEDDING_PROVIDERS), {
      area: "search",
      label: "Embedding-Anbieter",
      default: null,
      env: "BASTRA_EMBEDDING_PROVIDER",
      restartRequired: true,
      required: true,
    }),
  },
  ollama: {
    autostart: setting(bool, {
      area: "search",
      label: "Ollama automatisch starten",
      default: true,
      restartRequired: true,
      required: true,
    }),
  },
  api: {
    token: setting(z.string().min(1), {
      area: "access",
      label: "API-Zugangsschlüssel",
      default: null,
      env: "BASTRA_API_TOKEN",
      restartRequired: true,
      secret: true,
      required: true,
    }),
  },
  cors: {
    origins: setting(corsOrigins, {
      area: "access",
      label: "Erlaubte Browser-Ursprünge",
      default: [],
      env: "BASTRA_CORS_ORIGIN",
      restartRequired: true,
      required: true,
    }),
  },
  commons: {
    enabled: setting(bool, {
      area: "search",
      label: "Bastra Commons",
      default: false,
      restartRequired: true,
      required: true,
    }),
  },
  sharedRecall: {
    enabled: setting(bool, {
      area: "search",
      label: "Gelernte Brücken",
      default: false,
      restartRequired: true,
    }),
    language: setting(
      z
        .string()
        .trim()
        .toLowerCase()
        .refine((v): boolean => isSupportedLanguage(v)),
      { area: "search", label: "Brückensprache", default: null, restartRequired: true }
    ),
    live: setting(bool, { area: "search", label: "Live-Brückenerweiterung", default: false, restartRequired: true }),
  },
  evidenceGate: {
    enabled: setting(bool, {
      area: "hooks",
      label: "Evidenzentscheid",
      default: EVIDENCE_GATE_DEFAULT,
      env: "BASTRA_EVIDENCE_GATE",
      restartRequired: true,
      required: true,
    }),
  },
  experiment: {
    name: setting(text, { area: "hooks", label: "Experiment", restartRequired: true, default: null, required: true }),
    arms: setting(nonemptyStrings, {
      area: "hooks",
      label: "Experiment-Arme",
      restartRequired: true,
      default: [],
      required: true,
    }),
    registration: setting(text, {
      area: "hooks",
      label: "Experiment-Registrierung",
      restartRequired: true,
      default: null,
      required: true,
    }),
    registration_version: setting(finite, {
      area: "hooks",
      label: "Registrierungsversion",
      restartRequired: true,
      default: null,
      required: true,
    }),
  },
  docs: {
    mode: setting(z.enum(DOCS_MODES), { area: "general", label: "Produktanleitungen", default: DEFAULT_DOCS_MODE }),
    language: setting(tag, { area: "general", label: "Sprache der Anleitungen", default: DEFAULT_DOCS_LANGUAGE }),
  },
  generation: {
    model: setting(text, {
      area: "search",
      label: "Generierungsmodell",
      default: GENERATION_MODEL_DEFAULT,
      env: "BASTRA_EXPAND_MODEL",
      restartRequired: true,
      required: true,
    }),
  },
  modelRecommendation: {
    id: setting(z.string(), {
      area: "updates",
      label: "Modell-Empfehlung",
      default: null,
      readonly: true,
      required: true,
    }),
    answer: setting(z.enum(MODEL_RECOMMENDATION_ANSWERS), {
      area: "updates",
      label: "Empfehlungsantwort",
      default: null,
      readonly: true,
      required: true,
    }),
    at: setting(z.string(), {
      area: "updates",
      label: "Antwortzeitpunkt",
      default: null,
      readonly: true,
      required: true,
    }),
  },
  ui: {
    // On where the web UI is bound to the vault owner's account (macOS), off elsewhere.
    enabled: setting(bool, {
      area: "general",
      label: "Web-Oberfläche",
      // Not `required`: the default below is recomputed per platform on every
      // read (getUiEnabled, the gateway, effectiveSetting), so storing it would
      // pin today's default over a later change of `webUiOnByDefault()`.
      // Nothing is stored until the user picks a side.
      get default() {
        return webUiOnByDefault();
      },
    }),
    backdrop: setting(z.string().trim().regex(BACKDROP_ID), {
      area: "general",
      label: "Hintergrundbild",
      default: "none",
    }),
    backdropDim: setting(z.number().int().min(50).max(95).multipleOf(5), {
      area: "general",
      label: "Abdunkeln des Hintergrundbilds (%)",
      default: 80,
    }),
    backdropBlur: setting(bool, { area: "general", label: "Hintergrundbild weichzeichnen", default: false }),
    // #1198: the tunnel's https origin for the web UI sign-in; unset = no access through the tunnel.
    public_origin: setting(z.string().transform(publicUiOrigin), {
      area: "access",
      label: "Öffentliche Adresse der Web-Oberfläche",
      default: null,
    }),
    // The Android app (WebView shell) on /ui is a Recall Pulse feature, off by default (ui-android-app.ts).
    android_app: setting(bool, {
      area: "access",
      label: "Android-App (Recall Pulse)",
      default: false,
    }),
  },
  assistant: {
    // Address name (ASCII DNS label). Optional: a display name that derives no address may stand alone.
    name: setting(normalized(normalizeAssistantName, "Invalid assistant name"), {
      area: "general",
      label: "Name des Assistenten",
      default: null,
    }),
    // Written with the name through the address endpoint; the UI shows it in place of the address name.
    displayName: setting(normalized(normalizeAssistantDisplayName, "Invalid assistant display name"), {
      area: "general",
      label: "Anzeigename des Assistenten",
      default: null,
      readonly: true,
    }),
  },
  soul: {
    direction: setting(z.enum(SOUL_DIRECTIONS), { area: "general", label: "Persönlichkeit", default: "balanced" }),
    text: setting(z.string().trim().max(SOUL_TEXT_MAX), {
      area: "general",
      label: "Gewünschter Umgang in eigenen Worten",
      default: "",
    }),
  },
  reflex: {
    enabled: setting(bool, { area: "hooks", label: "Reflex", default: true, env: "BASTRA_REFLEX" }),
    maxPerTurn: setting(z.number().int().min(1).max(5), {
      area: "hooks",
      label: "Reflex-Treffer je Runde",
      default: 2,
      env: "BASTRA_REFLEX_MAX_PER_TURN",
    }),
  },
  size: {
    guide: setting(finite, { area: "hooks", label: "Dateigröße: Richtwert", default: 500, env: "BASTRA_SIZE_GUIDE" }),
    critical: setting(finite, {
      area: "hooks",
      label: "Dateigröße: Warnschwelle",
      default: 800,
      env: "BASTRA_SIZE_CRITICAL",
    }),
    exemptPaths: setting(nonemptyStrings, { area: "hooks", label: "Ausgenommene Pfadteile", default: [] }),
  },
  archive: {
    retain: setting(
      z.string().refine((v) => !!parseRetain(v)),
      {
        area: "archive",
        label: "Aufbewahrung je Klasse",
        default: "junk=1,in-git=2,user=2",
        env: "BASTRA_ARCHIVE_RETAIN",
      }
    ),
    enabled: setting(bool, { area: "archive", label: "Archivierung", default: false, env: "BASTRA_RM_ARCHIVES" }),
    cap: setting(
      z.string().refine((v) => !!parseSize(v)),
      { area: "archive", label: "Archiv: Gesamtgröße", default: "10GB", env: "BASTRA_ARCHIVE_CAP" }
    ),
    maxItem: setting(
      z.string().refine((v) => !!parseSize(v)),
      {
        area: "archive",
        label: "Archiv: Grenze je Datei",
        default: null,
        env: "BASTRA_ARCHIVE_MAX_ITEM",
        alias: "archive.max-item",
      }
    ),
  },
  battery: {
    saver: setting(bool, {
      area: "general",
      label: "Akkumodus",
      default: false,
      env: "BASTRA_BATTERY_SAVER",
      restartRequired: true,
    }),
  },
  daemon: {
    env: setting(daemonEnv, {
      area: "general",
      label: "Daemon-Umgebung",
      default: {},
      restartRequired: true,
      secret: true,
    }),
  },
  language: { primary: setting(primary, { area: "general", label: "Eigene Sprache", default: null }) },
  code: {
    repos: setting(nonemptyStrings, {
      area: "code",
      label: "Aktivierte Repositories",
      default: [],
      restartRequired: true,
    }),
  },
  promptImpact: {
    enabled: setting(bool, {
      area: "code",
      label: "Änderungsfolgen im Prompt",
      default: false,
      env: "BASTRA_PROMPT_IMPACT",
    }),
  },
  coverageMap: {
    enabled: setting(bool, {
      area: "code",
      label: "Testabdeckung erfassen",
      default: false,
      env: "BASTRA_COVERAGE_MAP",
    }),
  },
  tasks: {
    enabled: setting(bool, {
      area: "tasks",
      label: "Aufgaben",
      default: TASKS_DEFAULT,
      env: "BASTRA_TASKS",
      restartRequired: true,
    }),
    notifications: setting(bool, { area: "tasks", label: "Mac-Mitteilungen bei fälligen Aufgaben", default: true }),
    chatActiveMinutes: setting(z.number().int().min(1).max(1440), {
      area: "tasks",
      label: "Chat aktiv nach letzter Nutzernachricht (Minuten)",
      default: 30,
    }),
    reportUndo: setting(
      z
        .string()
        .trim()
        .toLowerCase()
        .refine((v) => parseReportUndo(v) !== null),
      { area: "tasks", label: "Berichte: Rückgängig nach dem Löschen", default: REPORT_UNDO_DEFAULT }
    ),
    chatConsent: setting(z.enum(["accepted", "declined", "blocked"]), {
      area: "tasks",
      label: "Claude-Chat-Empfang (Einrichtungsantwort)",
      default: null,
      readonly: true,
    }),
  },
  // Credential redaction in user content (drafts, notes, documents, tasks, reports).
  // Off keeps the text byte for byte; logs and learning data stay redacted.
  redaction: {
    enabled: setting(bool, { area: "general", label: "Zugangsdaten schwärzen", default: true, required: true }),
  },
  telemetry: {
    enabled: setting(bool, {
      area: "general",
      label: "Lokale Telemetrie",
      default: TELEMETRY_DEFAULT,
      env: "BASTRA_TELEMETRY",
      restartRequired: true,
      required: true,
    }),
  },
} as const;

type Registry = typeof SETTINGS_REGISTRY;
type Value<E> = E extends { schema: infer S extends z.ZodType } ? z.output<S> : never;
type RequiredKeys<G> = { [K in keyof G]: G[K] extends { required: true } ? K : never }[keyof G];
type Block<G> = { [K in RequiredKeys<G>]: Value<G[K]> } & { [K in Exclude<keyof G, RequiredKeys<G>>]?: Value<G[K]> };
export type CliSettings = { update: Block<Registry["update"]> } & {
  [K in Exclude<keyof Registry, "update">]?: Block<Registry[K]>;
};
export type SettingsGroup = keyof CliSettings;
export type SettingsField<G extends SettingsGroup> = keyof NonNullable<CliSettings[G]> & string;
export type StoredSettingValue<G extends SettingsGroup, F extends SettingsField<G>> = Exclude<
  NonNullable<CliSettings[G]>[F],
  undefined
>;
export interface SettingEntry extends Metadata {
  key: string;
  path: readonly [string, string];
  schema: z.ZodType;
  kind: "boolean" | "number" | "string" | "json";
  choices?: readonly string[];
}
export function settingEntries(): SettingEntry[] {
  return Object.entries(SETTINGS_REGISTRY).flatMap(([group, fields]) =>
    Object.entries(fields).map(([field, spec]) => {
      const example = spec.schema.safeParse(spec.default);
      const type = example.success ? typeof example.data : spec.schema.type;
      const kind =
        type === "boolean"
          ? "boolean"
          : type === "number"
            ? "number"
            : Array.isArray(spec.default) ||
                (spec.default !== null && typeof spec.default === "object") ||
                (example.success && typeof example.data === "object")
              ? "json"
              : "string";
      const choices = spec.schema instanceof z.ZodEnum ? (spec.schema.options as string[]) : undefined;
      return {
        ...spec,
        key: "alias" in spec ? spec.alias : `${group}.${field}`,
        path: [group, field] as const,
        kind,
        ...(choices ? { choices } : {}),
      } as SettingEntry;
    })
  );
}
export function settingEntry(key: string): SettingEntry | undefined {
  return settingEntries().find((e) => e.key === key || e.path.join(".") === key);
}
export function parseSettingValue(key: string, value: unknown): unknown {
  const entry = settingEntry(key);
  if (!entry || entry.readonly) throw new Error("Unknown or read-only setting");
  const parsed = entry.schema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid value for ${entry.key}`);
  return parsed.data;
}
/**
 * Lenient legacy normalization: invalid leaves are dropped, required blocks stay atomic.
 * `required` marks a field without which its stored block means nothing (no usable default),
 * or the only field of its group. A field with a usable default beside other fields is not
 * required: missing means default, so neither its siblings get dropped nor its default stored.
 */
export function parseStoredSettings(raw: unknown): CliSettings {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { update: { mode: DEFAULT_UPDATE_MODE } };
  for (const [group, fields] of Object.entries(SETTINGS_REGISTRY)) {
    const input = source[group];
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    const block: Record<string, unknown> = {};
    for (const [field, spec] of Object.entries(fields)) {
      const parsed = spec.schema.safeParse((input as Record<string, unknown>)[field]);
      if (parsed.success) block[field] = parsed.data;
    }
    const incomplete = Object.entries(fields).some(
      ([field, spec]) => "required" in spec && spec.required && !(field in block)
    );
    if (Object.keys(block).length && !incomplete) out[group] = block;
  }
  return out as CliSettings;
}
/** Project a field from settings already normalized by the registry. */
export function storedSettingAt<G extends SettingsGroup, F extends SettingsField<G>>(
  settings: CliSettings,
  group: G,
  field: F
): StoredSettingValue<G, F> | undefined;
export function storedSettingAt(settings: CliSettings, group: string, field: string): unknown;
export function storedSettingAt(settings: CliSettings, group: string, field: string): unknown {
  return (settings as unknown as Record<string, Record<string, unknown> | undefined>)[group]?.[field];
}

export function storedSetting(settings: CliSettings, entry: SettingEntry): unknown {
  return storedSettingAt(settings, entry.path[0], entry.path[1]);
}
export function applySettingChanges(current: CliSettings, changes: Record<string, unknown>): CliSettings {
  const next = structuredClone(current) as unknown as Record<string, Record<string, unknown>>;
  for (const [key, value] of Object.entries(changes)) {
    const entry = settingEntry(key);
    if (!entry || entry.readonly) throw new Error("Unknown or read-only setting");
    const [group, field] = entry.path;
    if (value === null) {
      if (next[group]) delete next[group][field];
      continue;
    }
    next[group] ??= {};
    next[group][field] = parseSettingValue(key, value);
  }
  const normalized = parseStoredSettings(next);
  assertNothingLost(current, changes, normalized);
  return normalized;
}
/** Every set value and every untouched stored value must still be stored: a change that would
 *  leave an atomic block incomplete is refused instead of silently dropping the rest (#1582). */
function assertNothingLost(current: CliSettings, changes: Record<string, unknown>, normalized: CliSettings): void {
  const changed = new Map(Object.entries(changes).map(([key, value]) => [settingEntry(key)!.path.join("."), value]));
  for (const entry of settingEntries()) {
    const path = entry.path.join(".");
    const wanted = changed.has(path) ? changed.get(path) : storedSetting(current, entry);
    if (wanted !== null && wanted !== undefined && storedSetting(normalized, entry) === undefined)
      throw new Error("Incomplete settings block");
  }
}
