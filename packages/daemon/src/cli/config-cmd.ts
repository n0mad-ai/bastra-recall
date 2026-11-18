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
import { usageWords } from "./usage-words.js";

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

  if (action !== "get" && action !== "set") {
    process.stderr.write((await usageWords()).config);
    process.stderr.write(`known keys: ${configKeys.join(", ")}\n`);
    return 2;
  }

  if (!isKnownKey(key)) {
    process.stderr.write(`error: unknown config key '${key ?? ""}'\n`);
    process.stderr.write(`known keys: ${configKeys.join(", ")}\n`);
    return 2;
  }

  return action === "get" ? cmdConfigGet(key) : cmdConfigSet(key, value);
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
const storedIn = () => `  stored in ${settingsFilePath()}\n`;

/** `get`: names an environment variable that overrides the stored value. */
function envNote(name: string): void {
  const env = process.env[name];
  if (env) out(`  note: ${name}=${env} (env) overrides this file at runtime\n`);
}

/** `set`: warns that an environment variable overrides what was just stored. */
function envWarning(name: string): void {
  const env = process.env[name];
  if (env) out(`  ⚠ ${name}=${env} (env) is set and OVERRIDES this — unset it for the file to take effect.\n`);
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

async function cmdConfigGet(key: KnownKey): Promise<number> {
  if (envSettingSpec(key)) {
    const entry = envSettingsSnapshot(await readSettings()).find((item) => item.key === key)!;
    out(`${entry.value}\n`);
    if (entry.readonly) out(`  note: ${entry.envName} overrides this setting at runtime\n`);
    return 0;
  }
  const special = GETTERS[key];
  if (special) {
    out(`${await special.read()}\n`);
    if (special.env) envNote(special.env);
    return 0;
  }
  const entry = settingEntry(key)!;
  const value = storedSetting(await readSettings(), entry) ?? entry.default;
  out(
    `${entry.secret && value ? "(configured — masked)" : typeof value === "object" ? JSON.stringify(value) : (value ?? "(unset)")}\n`
  );
  if (entry.env && process.env[entry.env] !== undefined)
    out(`  note: ${entry.env} overrides this setting at runtime\n`);
  return 0;
}

type Setter = (value: string | null) => Promise<number>;

/** An on/off key: parse, store, confirm with `after(on)`, then warn about an env override. */
function booleanSetter(
  key: string,
  store: (on: boolean) => Promise<void>,
  after: (on: boolean) => string,
  env?: string
): Setter {
  return async (value) => {
    const on = parseBool(value);
    if (on === null) return fail(`error: ${key} must be one of: true | false (also on|off)\n`);
    await store(on);
    out(`✓ ${key} = ${on}\n${storedIn()}${after(on)}`);
    if (env) envWarning(env);
    return 0;
  };
}

/** Keys with their own validation and confirmation text; every other key goes through the registry. */
const SETTERS: Record<string, Setter> = {
  "assistant.name": async (value) => {
    if (value === null || value === "") return fail("Name angeben; entfernen mit bastra address remove.\n");
    await configureAssistantName(value);
    out(await assistantNameReport(value));
    return 0;
  },
  "update.mode": async (value) => {
    if (value === null || !(UPDATE_MODES as readonly string[]).includes(value))
      return fail(`error: update.mode must be one of: ${UPDATE_MODES.join(" | ")} (default: ${DEFAULT_UPDATE_MODE})\n`);
    await setUpdateMode(value as UpdateMode);
    out(`✓ update.mode = ${value}\n${storedIn()}`);
    if (value === "auto") out("  bastra will now stage updates at session start (no restart mid-session).\n");
    return 0;
  },
  "embedding.provider": async (value) => {
    if (!isEmbeddingProviderName(value))
      return fail(`error: embedding.provider must be one of: ${EMBEDDING_PROVIDERS.join(" | ")}\n`);
    await setEmbeddingProvider(value);
    out(`✓ embedding.provider = ${value}\n${storedIn()}`);
    const env = process.env.BASTRA_EMBEDDING_PROVIDER;
    if (env && env.toLowerCase() !== value) envWarning("BASTRA_EMBEDDING_PROVIDER");
    out("  restart the daemon to apply (activates on next boot).\n");
    if (value === "ollama")
      out("  needs Ollama + the embeddinggemma model — run `bastra embeddings on` if not set up.\n");
    return 0;
  },
  "ollama.autostart": booleanSetter("ollama.autostart", setOllamaAutostart, () => ""),
  "docs.mode": async (value) => {
    if (!isDocsMode(value))
      return fail(`error: docs.mode must be one of: ${DOCS_MODES.join(" | ")} (default: ${DEFAULT_DOCS_MODE})\n`);
    await setDocsMode(value);
    out(`✓ docs.mode = ${value}\n${storedIn()}`);
    if (value !== "off")
      out(
        `  product docs land in dokumentationen/<project>/ in your vault ` +
          `(${value === "auto" ? "written autonomously on feature completion" : "proposed first, written after you agree"}).\n`
      );
    return 0;
  },
  "docs.language": async (value) => {
    if (!isDocsLanguage(value)) return fail("error: docs.language must be a short tag like 'en', 'de', 'pt-br'\n");
    await setDocsLanguage(value);
    out(`✓ docs.language = ${value.trim().toLowerCase()}\n${storedIn()}`);
    return 0;
  },
  // #531 — one line, naming THE configured endpoint.
  "ui.enabled": booleanSetter(
    "ui.enabled",
    async (on) => {
      await setUiEnabled(on);
      await notifyAssistantAddressDaemon();
    },
    (on) => (on ? `  vault map: ${mapUrl()} (or just: bastra map — no daemon restart needed)\n` : "")
  ),
  "archive.enabled": booleanSetter(
    "archive.enabled",
    setArchiveEnabled,
    (on) =>
      (on
        ? `  Claude Code's rm -r and lossy git acts now run through bastra's archive and are allowed without a prompt (docs/hooks.md).\n`
        : `  rm -r and the lossy git acts get the plain STOP again.\n`) +
      `  the next Bash call uses it (no restart needed).\n`
  ),
  "reflex.enabled": booleanSetter(
    "reflex.enabled",
    setReflexEnabled,
    () => "  the next prompt uses it (no restart needed).\n",
    "BASTRA_REFLEX"
  ),
  "battery.saver": booleanSetter(
    "battery.saver",
    setBatterySaver,
    (on) =>
      (on
        ? `  on battery, background paraphrasing waits for AC, model warm-ups are skipped and the model unloads after 60 s idle (macOS).\n`
        : `  background model work runs the same on battery as on AC.\n`) + `  restart the daemon to apply.\n`,
    "BASTRA_BATTERY_SAVER"
  ),
  "promptImpact.enabled": booleanSetter(
    "promptImpact.enabled",
    setPromptImpactEnabled,
    () => "  the next prompt uses it (no restart needed).\n",
    "BASTRA_PROMPT_IMPACT"
  ),
  "coverageMap.enabled": booleanSetter(
    "coverageMap.enabled",
    setCoverageMapEnabled,
    (on) =>
      on
        ? "  test commands in repositories with code awareness now run with NODE_V8_COVERAGE; the next Bash call uses it (no restart needed).\n"
        : "  test commands run untouched again.\n",
    "BASTRA_COVERAGE_MAP"
  ),
  "archive.retain": async (value) => {
    const parsed = value === null ? null : parseRetain(value);
    if (!parsed || Object.keys(parsed).length === 0)
      return fail("error: archive.retain is days per class, e.g. junk=1,in-git=2,user=2 (fractions allowed)\n");
    await setArchiveRetain(value as string);
    const r = retainDays({}, value as string);
    out(
      `✓ archive.retain = junk=${r.junk},in-git=${r["in-git"]},user=${r.user}\n${storedIn()}` +
        `  the next hourly reconcile uses it (no restart needed).\n`
    );
    return 0;
  },
  "archive.cap": async (value) => {
    const bytes = value === null ? null : parseSize(value);
    if (bytes === null)
      return fail(
        `error: archive.cap is a size above zero, e.g. 5GB or 500MB (units KB, MB, GB, TB) — got '${value ?? ""}'\n`
      );
    await setArchiveCap(value as string);
    out(
      `✓ archive.cap = ${formatSize(bytes)}\n${storedIn()}` +
        `  the next hourly reconcile uses it (no restart needed): over the cap, build junk goes first, then clean git-tracked files.\n`
    );
    envWarning("BASTRA_ARCHIVE_CAP");
    return 0;
  },
  "archive.max-item": async (value) => {
    const off = value === "off" || value === "none";
    const bytes = value === null || off ? null : parseSize(value);
    if (bytes === null && !off)
      return fail(
        `error: archive.max-item is a size above zero, e.g. 2GB or 500MB (units KB, MB, GB, TB), or off for no limit — got '${value ?? ""}'\n`
      );
    await setArchiveMaxItem(off ? null : (value as string));
    out(
      `✓ archive.max-item = ${bytes === null ? "off (no per-target limit)" : formatSize(bytes)}\n${storedIn()}` +
        (bytes === null
          ? `  rm archives a target of any size again.\n`
          : `  a larger target is neither archived nor deleted: rm refuses and names /bin/rm and this setting.\n`) +
        `  the next Bash call uses it (no restart needed).\n`
    );
    envWarning("BASTRA_ARCHIVE_MAX_ITEM");
    return 0;
  },
  "size.guide": async (value) => {
    const n = value === null ? NaN : Number(value);
    if (!Number.isFinite(n) || n < 100 || n > 5000)
      return fail("error: size.guide must be a line count between 100 and 5000 (default 500)\n");
    await setSizeGuide(n);
    out(
      `✓ size.guide = ${Math.round(n)}\n${storedIn()}` +
        `  the PreToolUse hook now flags source files near/over this guide value (no restart needed).\n`
    );
    return 0;
  },
  "language.primary": async (value) => {
    if (!isPrimaryLanguage(value))
      return fail("error: language.primary must be a 2-letter ISO code like 'de', 'en', 'ru'\n");
    await setPrimaryLanguage(value);
    out(
      `✓ language.primary = ${value.trim().toLowerCase()}\n${storedIn()}` +
        `  new memories are now authored in this language (English tech terms kept as anchors, no restart needed).\n`
    );
    return 0;
  },
};

/** Keys stored in daemon.env (settings-env.ts); typed by their default. */
async function setEnvBacked(key: string, value: string | null): Promise<number> {
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
    out(`✓ ${key} updated in daemon.env; restart the daemon to apply\n`);
    return 0;
  } catch {
    return fail(`error: invalid or environment-controlled value for ${key}\n`);
  }
}

/** Any other registry key, typed by its registry kind. */
async function setRegistryValue(key: string, value: string | null): Promise<number> {
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
    out(`✓ ${key} updated${entry.restartRequired ? "; restart the daemon and clients to apply" : ""}\n`);
    return 0;
  } catch {
    return fail(`error: invalid value for ${key}\n`);
  }
}

async function cmdConfigSet(key: KnownKey, value: string | null): Promise<number> {
  if (envSettingSpec(key)) return setEnvBacked(key, value);
  const special = SETTERS[key];
  return special ? special(value) : setRegistryValue(key, value);
}

function parseBool(v: string | null): boolean | null {
  if (v === null) return null;
  const s = v.toLowerCase();
  if (["true", "on", "yes", "1"].includes(s)) return true;
  if (["false", "off", "no", "0"].includes(s)) return false;
  return null;
}
