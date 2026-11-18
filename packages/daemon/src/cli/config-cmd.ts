import { settingEntries, settingEntry, storedSetting, applySettingChanges } from "../settings-registry.js";
import { readSettings, mutateSettings } from "../settings.js";
import {
  envSettingSpecs,
  envSettingSpec,
  envSettingsSnapshot,
  applyEnvSettingChanges,
  validateEnvPinChanges,
  validateRawEnvInput,
} from "../settings-env.js";
import { notifyAssistantAddressDaemon, assistantAddressFor } from "../assistant-address.js";
import { configureAssistantName } from "./address-cmd.js";
import { getAssistantDisplayName, getAssistantName } from "../assistant-address-settings.js";
import { assistantUrls } from "../assistant-address-name.js";
import { addressLanguage, addressWords } from "../assistant-address-words.js";
/**
 * `bastra config get|set <key> [value]` — settings access from the CLI.
 *
 * Keys: update.mode, embedding.provider, ollama.autostart, docs.mode,
 * docs.language, archive.retain, archive.enabled, archive.cap, archive.max-item, reflex.enabled,
 * promptImpact.enabled, battery.saver. The store is the local app database (legacy key cli-settings.json)
 * (never the Pro-app's config.json). Browsing/editing memories stays in
 * the Pro app — this is flags only.
 */
import {
  DEFAULT_UPDATE_MODE,
  UPDATE_MODES,
  EMBEDDING_PROVIDERS,
  DOCS_MODES,
  DEFAULT_DOCS_MODE,
  getUpdateMode,
  setUpdateMode,
  getEmbeddingProvider,
  setEmbeddingProvider,
  getOllamaAutostart,
  setOllamaAutostart,
  getDocsMode,
  setDocsMode,
  getDocsLanguage,
  setDocsLanguage,
  getUiEnabled,
  setUiEnabled,
  getSizeGuide,
  setSizeGuide,
  getPrimaryLanguage,
  setPrimaryLanguage,
  getArchiveRetain,
  setArchiveRetain,
  getArchiveEnabled,
  getArchiveCap,
  setArchiveCap,
  getArchiveMaxItem,
  setArchiveMaxItem,
  setArchiveEnabled,
  getReflexEnabled,
  setReflexEnabled,
  getBatterySaver,
  setBatterySaver,
  isEmbeddingProviderName,
  isDocsMode,
  isDocsLanguage,
  isPrimaryLanguage,
  settingsFilePath,
  type UpdateMode,
} from "../settings.js";
import type { ParsedArgs } from "./types.js";
import { mapUrl } from "./map-cmd.js";
import { archiveCap, archiveMaxItem, formatSize, parseRetain, parseSize, retainDays } from "../rm-archive.js";
import { getPromptImpactEnabled, setPromptImpactEnabled } from "../code-graph/prompt-impact-settings.js";
import { getCoverageMapEnabled, setCoverageMapEnabled } from "../code-graph/coverage-map-settings.js";
import { usageWordsIn } from "./usage-words.js";
import { configWordsIn, type ConfigWords } from "./config-words.js";
import { taskCliLanguage } from "./task-cli-words.js";

const configKeys = [
  ...settingEntries()
    .filter((entry) => !entry.readonly)
    .map((entry) => entry.key),
  ...envSettingSpecs.map((entry) => entry.key),
];
type KnownKey = string;
function isKnownKey(k: string | null): k is KnownKey {
  return k !== null && configKeys.includes(k);
}

export async function cmdConfig(args: ParsedArgs): Promise<number> {
  // positional: ["config", action, key, value?]
  const action = args.positional[1] ?? null;
  const key = args.positional[2] ?? null;
  const value = args.positional[3] ?? null;

  // The language is read once per command (#1602).
  const language = await taskCliLanguage().catch(() => "en");
  const w = configWordsIn(language);
  if (action !== "get" && action !== "set") {
    process.stderr.write(usageWordsIn(language).config);
    process.stderr.write(w.knownKeys(configKeys.join(", ")));
    return 2;
  }

  if (!isKnownKey(key)) {
    process.stderr.write(w.unknownKey(key ?? ""));
    process.stderr.write(w.knownKeys(configKeys.join(", ")));
    return 2;
  }

  return action === "get" ? cmdConfigGet(key, w) : cmdConfigSet(key, value, w);
}

/** Confirmation after `config set assistant.name`: the name as saved and which address applies. */
async function assistantNameReport(value: string): Promise<string> {
  const derived = assistantAddressFor(value),
    name = await getAssistantName(),
    head = `✓ assistant.name = ${await getAssistantDisplayName()}\n`;
  const w = addressWords(await addressLanguage());
  if (derived !== null) return `${head}  ${assistantUrls(derived).local}\n  ${w.oneTimeSetup}\n`;
  const current = name ? w.stillApplies(assistantUrls(name).local) : w.noAddressSet;
  return `${head}  ${w.noBrowserAddress(current)}\n`;
}

const out = (text: string) => process.stdout.write(text);
const fail = (text: string): number => (process.stderr.write(text), 2);
const storedIn = (w: ConfigWords) => w.storedIn(settingsFilePath());

/** `get`: names an environment variable that overrides the stored value. */
function envNote(name: string, w: ConfigWords): void {
  const env = process.env[name];
  if (env) out(w.envNote(name, env));
}

/** `set`: warns that an environment variable overrides what was just stored. */
function envWarning(name: string, w: ConfigWords): void {
  const env = process.env[name];
  if (env) out(w.envWarning(name, env));
}

/** Keys whose `get` shows more than the registry value: a readable default or the env override. */
const GETTERS: Record<string, { read: () => Promise<string>; env?: string }> = {
  "assistant.name": { read: async () => (await getAssistantDisplayName()) ?? "(unset)" },
  "update.mode": { read: async () => `${await getUpdateMode()}` },
  "embedding.provider": {
    read: async () => (await getEmbeddingProvider()) ?? "(unset — falls through to env, else BM25)",
    env: "BASTRA_EMBEDDING_PROVIDER",
  },
  "ollama.autostart": { read: async () => `${await getOllamaAutostart()}` },
  "docs.mode": { read: async () => `${await getDocsMode()}` },
  "docs.language": { read: async () => `${await getDocsLanguage()}` },
  "ui.enabled": { read: async () => `${await getUiEnabled()}` },
  "archive.enabled": { read: async () => `${await getArchiveEnabled()}`, env: "BASTRA_RM_ARCHIVES" },
  "reflex.enabled": { read: async () => `${await getReflexEnabled()}`, env: "BASTRA_REFLEX" },
  "battery.saver": { read: async () => `${(await getBatterySaver()) ?? false}`, env: "BASTRA_BATTERY_SAVER" },
  // The file value alone: the env override is named below, not folded in.
  "promptImpact.enabled": {
    read: async () => `${await getPromptImpactEnabled(settingsFilePath(), {})}`,
    env: "BASTRA_PROMPT_IMPACT",
  },
  "coverageMap.enabled": {
    read: async () => `${await getCoverageMapEnabled(settingsFilePath(), {})}`,
    env: "BASTRA_COVERAGE_MAP",
  },
  "archive.retain": {
    read: async () => {
      const r = retainDays(process.env, await getArchiveRetain());
      const stored = await getArchiveRetain();
      return `junk=${r.junk},in-git=${r["in-git"]},user=${r.user}${stored ? "" : "  (default)"}`;
    },
    env: "BASTRA_ARCHIVE_RETAIN",
  },
  "archive.cap": {
    read: async () => {
      const stored = await getArchiveCap();
      return `${formatSize(archiveCap({}, stored))}${stored ? "" : "  (default)"}`;
    },
    env: "BASTRA_ARCHIVE_CAP",
  },
  "archive.max-item": {
    read: async () => {
      const limit = archiveMaxItem({}, await getArchiveMaxItem());
      return limit === null ? "(unset — no per-target limit)" : formatSize(limit);
    },
    env: "BASTRA_ARCHIVE_MAX_ITEM",
  },
  "size.guide": { read: async () => `${(await getSizeGuide()) ?? "(unset — default 500)"}`, env: "BASTRA_SIZE_GUIDE" },
  "language.primary": {
    read: async () => (await getPrimaryLanguage()) ?? "(unset — memories authored in English by default)",
  },
};

async function cmdConfigGet(key: KnownKey, w: ConfigWords): Promise<number> {
  if (envSettingSpec(key)) {
    const entry = envSettingsSnapshot(await readSettings()).find((item) => item.key === key)!;
    out(`${entry.value}\n`);
    if (entry.readonly) out(w.overrides(entry.envName));
    return 0;
  }
  const special = GETTERS[key];
  if (special) {
    out(`${await special.read()}\n`);
    if (special.env) envNote(special.env, w);
    return 0;
  }
  const entry = settingEntry(key)!;
  const value = storedSetting(await readSettings(), entry) ?? entry.default;
  out(
    `${entry.secret && value ? "(configured — masked)" : typeof value === "object" ? JSON.stringify(value) : (value ?? "(unset)")}\n`
  );
  if (entry.env && process.env[entry.env] !== undefined) out(w.overrides(entry.env));
  return 0;
}

type Setter = (value: string | null, w: ConfigWords) => Promise<number>;

/** An on/off key: parse, store, confirm with `after(on)`, then warn about an env override. */
function booleanSetter(
  key: string,
  store: (on: boolean) => Promise<void>,
  after: (on: boolean, w: ConfigWords) => string,
  env?: string
): Setter {
  return async (value, w) => {
    const on = parseBool(value);
    if (on === null) return fail(w.mustBeBool(key));
    await store(on);
    out(`✓ ${key} = ${on}\n${storedIn(w)}${after(on, w)}`);
    if (env) envWarning(env, w);
    return 0;
  };
}

/** Keys with their own validation and confirmation text; every other key goes through the registry. */
const SETTERS: Record<string, Setter> = {
  "assistant.name": async (value, w) => {
    if (value === null || value === "") return fail(w.nameMissing);
    await configureAssistantName(value);
    out(await assistantNameReport(value));
    return 0;
  },
  "update.mode": async (value, w) => {
    if (value === null || !(UPDATE_MODES as readonly string[]).includes(value))
      return fail(w.updateModeOneOf(UPDATE_MODES.join(" | "), DEFAULT_UPDATE_MODE));
    await setUpdateMode(value as UpdateMode);
    out(`✓ update.mode = ${value}\n${storedIn(w)}`);
    if (value === "auto") out(w.updateAuto);
    return 0;
  },
  "embedding.provider": async (value, w) => {
    if (!isEmbeddingProviderName(value)) return fail(w.providerOneOf(EMBEDDING_PROVIDERS.join(" | ")));
    await setEmbeddingProvider(value);
    out(`✓ embedding.provider = ${value}\n${storedIn(w)}`);
    const env = process.env.BASTRA_EMBEDDING_PROVIDER;
    if (env && env.toLowerCase() !== value) envWarning("BASTRA_EMBEDDING_PROVIDER", w);
    out(w.restartOnBoot);
    if (value === "ollama") out(w.needsOllama);
    return 0;
  },
  "ollama.autostart": booleanSetter("ollama.autostart", setOllamaAutostart, () => ""),
  "docs.mode": async (value, w) => {
    if (!isDocsMode(value)) return fail(w.docsModeOneOf(DOCS_MODES.join(" | "), DEFAULT_DOCS_MODE));
    await setDocsMode(value);
    out(`✓ docs.mode = ${value}\n${storedIn(w)}`);
    if (value !== "off") out(w.docsLand(value === "auto"));
    return 0;
  },
  "docs.language": async (value, w) => {
    if (!isDocsLanguage(value)) return fail(w.docsLanguage);
    await setDocsLanguage(value);
    out(`✓ docs.language = ${value.trim().toLowerCase()}\n${storedIn(w)}`);
    return 0;
  },
  // #531 — one line, naming THE configured endpoint.
  "ui.enabled": booleanSetter(
    "ui.enabled",
    async (on) => {
      await setUiEnabled(on);
      await notifyAssistantAddressDaemon();
    },
    (on, w) => (on ? w.vaultMap(mapUrl()) : "")
  ),
  "archive.enabled": booleanSetter(
    "archive.enabled",
    setArchiveEnabled,
    (on, w) => (on ? w.archiveOn : w.archiveOff) + w.nextBash
  ),
  "reflex.enabled": booleanSetter("reflex.enabled", setReflexEnabled, (_on, w) => w.nextPrompt, "BASTRA_REFLEX"),
  "battery.saver": booleanSetter(
    "battery.saver",
    setBatterySaver,
    (on, w) => (on ? w.batteryOn : w.batteryOff) + w.restart,
    "BASTRA_BATTERY_SAVER"
  ),
  "promptImpact.enabled": booleanSetter(
    "promptImpact.enabled",
    setPromptImpactEnabled,
    (_on, w) => w.nextPrompt,
    "BASTRA_PROMPT_IMPACT"
  ),
  "coverageMap.enabled": booleanSetter(
    "coverageMap.enabled",
    setCoverageMapEnabled,
    (on, w) => (on ? w.coverageOn : w.coverageOff),
    "BASTRA_COVERAGE_MAP"
  ),
  "archive.retain": async (value, w) => {
    const parsed = value === null ? null : parseRetain(value);
    if (!parsed || Object.keys(parsed).length === 0) return fail(w.retainFormat);
    await setArchiveRetain(value as string);
    const r = retainDays({}, value as string);
    out(`✓ archive.retain = junk=${r.junk},in-git=${r["in-git"]},user=${r.user}\n${storedIn(w)}` + w.nextReconcile);
    return 0;
  },
  "archive.cap": async (value, w) => {
    const bytes = value === null ? null : parseSize(value);
    if (bytes === null) return fail(w.capFormat(value ?? ""));
    await setArchiveCap(value as string);
    out(`✓ archive.cap = ${formatSize(bytes)}\n${storedIn(w)}` + w.capNext);
    envWarning("BASTRA_ARCHIVE_CAP", w);
    return 0;
  },
  "archive.max-item": async (value, w) => {
    const off = value === "off" || value === "none";
    const bytes = value === null || off ? null : parseSize(value);
    if (bytes === null && !off) return fail(w.maxItemFormat(value ?? ""));
    await setArchiveMaxItem(off ? null : (value as string));
    out(
      `✓ archive.max-item = ${bytes === null ? w.maxItemOff : formatSize(bytes)}\n${storedIn(w)}` +
        (bytes === null ? w.maxItemAny : w.maxItemRefuses) +
        w.nextBash
    );
    envWarning("BASTRA_ARCHIVE_MAX_ITEM", w);
    return 0;
  },
  "size.guide": async (value, w) => {
    const n = value === null ? NaN : Number(value);
    if (!Number.isFinite(n) || n < 100 || n > 5000) return fail(w.sizeGuideRange);
    await setSizeGuide(n);
    out(`✓ size.guide = ${Math.round(n)}\n${storedIn(w)}` + w.sizeGuideNext);
    return 0;
  },
  "language.primary": async (value, w) => {
    if (!isPrimaryLanguage(value)) return fail(w.languageCode);
    await setPrimaryLanguage(value);
    out(`✓ language.primary = ${value.trim().toLowerCase()}\n${storedIn(w)}` + w.languageNext);
    return 0;
  },
};

/** Keys stored in daemon.env (settings-env.ts); typed by their default. */
async function setEnvBacked(key: string, value: string | null, w: ConfigWords): Promise<number> {
  const envEntry = envSettingSpec(key)!;
  try {
    if (value === null) throw new Error("Expected a value");
    let parsed: unknown = value;
    if (typeof envEntry.default === "boolean") parsed = parseBool(value);
    else if (typeof envEntry.default === "number") parsed = Number(value);
    if (parsed === null) throw new Error("Expected boolean");
    await mutateSettings(settingsFilePath(), (current) => applyEnvSettingChanges(current, { [key]: parsed }), {
      refuseCorrupt: true,
      requireLock: true,
    });
    out(w.envUpdated(key));
    return 0;
  } catch {
    return fail(w.envInvalid(key));
  }
}

/** Any other registry key, typed by its registry kind. */
async function setRegistryValue(key: string, value: string | null, w: ConfigWords): Promise<number> {
  const entry = settingEntry(key)!;
  try {
    if (value === null) throw new Error("Expected a value");
    let parsed: unknown = value;
    if (entry.kind === "boolean") {
      parsed = parseBool(value);
      if (parsed === null) throw new Error("Expected boolean");
    } else if (entry.kind === "number") parsed = Number(value);
    else if (entry.kind === "json") parsed = JSON.parse(value);
    if (key === "daemon.env") validateRawEnvInput(parsed);
    await mutateSettings(settingsFilePath(), (current) => {
      const next = applySettingChanges(current, { [key]: parsed });
      if (key === "daemon.env") validateEnvPinChanges(current, next);
      return next;
    });
    out(w.updated(key, entry.restartRequired === true));
    return 0;
  } catch {
    return fail(w.invalid(key));
  }
}

async function cmdConfigSet(key: KnownKey, value: string | null, w: ConfigWords): Promise<number> {
  if (envSettingSpec(key)) return setEnvBacked(key, value, w);
  const special = SETTERS[key];
  return special ? special(value, w) : setRegistryValue(key, value, w);
}

function parseBool(v: string | null): boolean | null {
  if (v === null) return null;
  const s = v.toLowerCase();
  if (["true", "on", "yes", "1"].includes(s)) return true;
  if (["false", "off", "no", "0"].includes(s)) return false;
  return null;
}
