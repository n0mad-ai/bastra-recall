/** UI projections of existing env settings; daemon.env is their only storage. */
import { z } from "zod";
import { join } from "node:path";
import { bastraDataDir } from "./platform-paths.js";
import { appliedDaemonEnv } from "./daemon-spawn-env.js";
import { isOffValue, isOnValue } from "./env.js";
import type { CliSettings } from "./settings-registry.js";

const text = z
  .string()
  .trim()
  .min(1)
  .refine((v) => !/[\u0000-\u001f]/u.test(v));
const specs = [
  {
    key: "embedding.model",
    envName: "BASTRA_EMBEDDING_MODEL",
    area: "search",
    label: "Embedding-Modell",
    default: "embeddinggemma",
    schema: text,
  },
  {
    key: "ollama.url",
    envName: "BASTRA_OLLAMA_URL",
    area: "search",
    label: "Ollama-URL",
    default: "http://localhost:11434",
    schema: text.refine((v) => {
      try {
        const u = new URL(v);
        return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
      } catch {
        return false;
      }
    }),
  },
  {
    key: "ollama.keepAlive",
    envName: "BASTRA_OLLAMA_KEEP_ALIVE",
    area: "search",
    label: "Modell im Speicher halten",
    default: "10m",
    schema: text.regex(/^(?:-1|0|[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+)$/u),
  },
  {
    key: "recall.floor",
    envName: "BASTRA_RECALL_FLOOR",
    area: "hooks",
    label: "Mindestpunktzahl",
    default: 30,
    min: 0,
    max: 100,
    step: 5,
    schema: z.number().int().min(0).max(100),
  },
  {
    key: "prompt.hookMode",
    envName: "BASTRA_PROMPT_HOOK_MODE",
    area: "hooks",
    label: "Prompt-Hook",
    default: "all",
    schema: z.enum(["all", "retrieval-only"]),
  },
  {
    key: "hint.suppress",
    envName: "BASTRA_HINT_SUPPRESS",
    area: "hooks",
    label: "Hinweise unterdrücken",
    default: "shadow",
    schema: z.enum(["shadow", "off"]),
  },
  {
    key: "hint.suppressAfter",
    envName: "BASTRA_HINT_SUPPRESS_AFTER",
    area: "hooks",
    label: "Unterdrücken nach",
    default: 8,
    min: 0,
    max: 30,
    step: 1,
    unit: "surfaces",
    schema: z.number().int().min(0).max(30),
  },
  {
    key: "scope.filterLanes",
    envName: "BASTRA_SCOPE_FILTER_LANES",
    area: "hooks",
    label: "Scope-Filter",
    default: "shadow",
    schema: z.enum(["shadow", "enforce"]),
  },
  {
    key: "saveNotice",
    envName: "BASTRA_SAVE_NOTICE",
    area: "hooks",
    label: "Speicherhinweise",
    default: true,
    schema: z.boolean(),
  },
  {
    key: "logs.retention",
    envName: "BASTRA_LOG_RETENTION_DAYS",
    area: "general",
    label: "Log-Aufbewahrung",
    default: 90,
    min: 30,
    max: 365,
    step: 1,
    unit: "days",
    schema: z.number().int().min(30).max(365),
  },
  {
    key: "logs.path",
    envName: "BASTRA_LOG_PATH",
    area: "general",
    label: "Log-Ordner",
    default: join(bastraDataDir(), "logs"),
    schema: text,
  },
  {
    key: "training.capture",
    envName: "BASTRA_TRAINING_CAPTURE",
    area: "general",
    label: "Trainingsdaten erfassen",
    default: false,
    schema: z.boolean(),
  },
] as const;
export const envSettingSpecs = specs;
export function envSettingSpec(key: string) {
  return specs.find((s) => s.key === key);
}
function decode(spec: (typeof specs)[number], raw: string | undefined): unknown {
  if (raw === undefined) return spec.default;
  switch (spec.key) {
    case "saveNotice":
      return !isOffValue(raw);
    case "training.capture":
      return isOnValue(raw);
    case "prompt.hookMode":
      return raw === "retrieval-only" ? raw : "all";
    case "hint.suppress":
      return isOffValue(raw) ? "off" : "shadow";
    case "scope.filterLanes":
      return raw === "enforce" ? raw : "shadow";
    case "recall.floor": {
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : 30;
    }
    case "hint.suppressAfter": {
      const n = Number.parseInt(raw, 10);
      return Math.max(0, Number.isFinite(n) ? n : 8);
    }
    case "logs.retention": {
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? Math.max(30, Math.floor(n)) : 90;
    }
    case "logs.path":
      return raw || spec.default;
    default:
      return raw;
  }
}
function externalNames(spec: (typeof specs)[number], env: NodeJS.ProcessEnv, applied: ReadonlySet<string>): string[] {
  const name = spec.envName;
  if (env[name] !== undefined && !applied.has(name)) return [name];
  if (spec.key === "logs.path" && !env[name] && env.NEXUS_LOG_PATH) return ["NEXUS_LOG_PATH"];
  return [];
}
export function envSettingsSnapshot(
  settings: CliSettings,
  env: NodeJS.ProcessEnv = process.env,
  applied: ReadonlySet<string> = appliedDaemonEnv
) {
  return specs.map((spec) => {
    const raw = settings.daemon?.env?.[spec.envName],
      envNames = externalNames(spec, env, applied);
    const { schema, ...metadata } = spec;
    return {
      ...metadata,
      kind: typeof spec.default,
      storage: "daemon.env",
      value: decode(spec, raw),
      effective: decode(spec, spec.key === "logs.path" ? env[spec.envName] || env.NEXUS_LOG_PATH : env[spec.envName]),
      isSet: raw !== undefined,
      readonly: envNames.length > 0,
      secret: false,
      managed: false,
      restartRequired: true,
      source: envNames.length
        ? "environment"
        : applied.has(spec.envName) && env[spec.envName] !== undefined
          ? "daemon.env"
          : "default",
      choices: schema instanceof z.ZodEnum ? schema.options : undefined,
      envOverride: envNames.map((name) => ({ name, value: env[name] })),
    };
  });
}
/** Validate the whole patch before the persistence transaction can commit. */
export function applyEnvSettingChanges(
  current: CliSettings,
  changes: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  applied: ReadonlySet<string> = appliedDaemonEnv
): CliSettings {
  const next = structuredClone(current),
    pins = { ...next.daemon?.env };
  for (const [key, value] of Object.entries(changes)) {
    const spec = envSettingSpec(key);
    if (!spec || externalNames(spec, env, applied).length) throw new Error("Unknown or read-only environment setting");
    if (value === null) delete pins[spec.envName];
    else {
      const parsed = spec.schema.safeParse(value);
      if (!parsed.success) throw new Error("Invalid environment setting");
      pins[spec.envName] = typeof parsed.data === "boolean" ? (parsed.data ? "1" : "0") : String(parsed.data);
    }
  }
  if (Object.keys(pins).length) next.daemon = { ...next.daemon, env: pins };
  else delete next.daemon;
  return next;
}

/** The existing advanced JSON editor replaces pins; validate only its delta. */
export function validateRawEnvInput(value: unknown): void {
  if (value === null) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid environment record");
  for (const spec of specs) {
    if (Object.hasOwn(value, spec.envName) && typeof (value as Record<string, unknown>)[spec.envName] !== "string")
      throw new Error("Environment pins must be strings");
  }
}
export function validateEnvPinChanges(
  before: CliSettings,
  after: CliSettings,
  env: NodeJS.ProcessEnv = process.env,
  applied: ReadonlySet<string> = appliedDaemonEnv
): void {
  for (const spec of specs) {
    const previous = before.daemon?.env?.[spec.envName],
      raw = after.daemon?.env?.[spec.envName];
    if (previous === raw) continue;
    if (externalNames(spec, env, applied).length) throw new Error("Read-only environment setting");
    if (raw === undefined) continue;
    let value: unknown = raw;
    if (typeof spec.default === "boolean") {
      if (!isOnValue(raw) && !isOffValue(raw)) throw new Error("Invalid boolean environment setting");
      value = isOnValue(raw);
    } else if (typeof spec.default === "number") value = raw.trim() ? Number(raw) : NaN;
    if (!spec.schema.safeParse(value).success) throw new Error("Invalid environment setting");
  }
}
