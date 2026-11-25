/**
 * #1510: every registry setting pinned with a fixed expected value, per path.
 *
 * The table below is written out by hand. It is the contract: a new registry key
 * fails the first test until it is added here, and a changed default or
 * validation rule fails the test of that key. Nothing in it is derived from the
 * registry, so it cannot drift with it.
 *
 * Paths per key: the registry default, the lenient file reader, the effective
 * value (presentation), the named getter where one exists, the web settings API
 * (accepted, rejected, reset) and the stored result.
 *
 * Everything runs in temp directories; the user's real settings are never read
 * or written, `redaction.enabled` included.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { dispatchSettingsUi } from "../src/settings-ui.js";
import { mutateSettings, readSettings } from "../src/settings-file.js";
import { effectiveSetting } from "../src/settings-effective.js";
import { parseSettingValue, settingEntries, storedSetting, type SettingEntry } from "../src/settings-registry.js";
import * as getters from "../src/settings.js";
import { runtimeFeatureSetting } from "../src/runtime-feature-settings.js";
import { redactionEnabled } from "../src/user-text-redaction.js";
import { SOUL_TEXT_MAX } from "../src/soul.js";

/** `valid` goes in, `stored` is what lands in the file; `invalid` must be refused. */
interface Row {
  key: string;
  def: unknown;
  valid?: unknown;
  stored?: unknown;
  invalid?: unknown;
  /** Readonly: refused by the registry and the web API. */
  locked?: true;
  /** Saved through its own endpoint: the registry accepts it, the web settings API refuses it. */
  managed?: true;
  /** Part of an atomic block: the web API takes all fields of the block together. */
  group?: true;
  /** Named reader in settings.ts and what it returns on an empty file. */
  getter?: (path: string) => Promise<unknown>;
  unset?: unknown;
}

// ui.enabled follows the platform: on where the account binding runs (macOS).
const UI_DEFAULT = process.platform === "darwin";

/** update.mode is the one key the file reader always fills in (its group is required). */
const storedWhenUnset = (key: string): unknown => (key === "update.mode" ? "notify" : undefined);
/** Without a choice the effective embedding provider is "none" (BM25 only); the 10GB cap is shown as bytes. */
const EFFECTIVE_OVERRIDE: Record<string, unknown> = { "embedding.provider": "none", "archive.cap": 10 * 1024 ** 3 };

const ROWS: Row[] = [
  {
    key: "update.mode",
    def: "notify",
    valid: "auto",
    stored: "auto",
    invalid: "bogus",
    getter: getters.getUpdateMode,
    unset: "notify",
  },
  {
    key: "embedding.provider",
    def: null,
    valid: "ollama",
    stored: "ollama",
    invalid: "bogus",
    getter: getters.getEmbeddingProvider,
    unset: undefined,
  },
  {
    key: "ollama.autostart",
    def: true,
    valid: false,
    stored: false,
    invalid: "maybe",
    getter: getters.getOllamaAutostart,
    unset: true,
  },
  {
    key: "api.token",
    def: null,
    valid: "tok-1",
    stored: "tok-1",
    invalid: "",
    getter: getters.getApiToken,
    unset: undefined,
  },
  {
    key: "cors.origins",
    def: [],
    valid: ["http://localhost:3000/", "http://localhost:3000"],
    stored: ["http://localhost:3000"],
    invalid: ["not a url"],
    getter: getters.getCorsOrigins,
    unset: [],
  },
  {
    key: "commons.enabled",
    def: false,
    valid: true,
    stored: true,
    invalid: "yes",
    getter: getters.getCommonsEnabled,
    unset: false,
  },
  {
    key: "sharedRecall.enabled",
    def: false,
    valid: true,
    stored: true,
    invalid: 1,
    getter: getters.getSharedRecallEnabled,
    unset: false,
  },
  {
    key: "sharedRecall.language",
    def: null,
    valid: " DE ",
    stored: "de",
    invalid: "xx-not-supported",
    getter: getters.getSharedRecallLanguage,
    unset: undefined,
  },
  {
    key: "sharedRecall.live",
    def: false,
    valid: true,
    stored: true,
    invalid: "on",
    getter: getters.getSharedRecallLive,
    unset: false,
  },
  {
    key: "evidenceGate.enabled",
    def: true,
    valid: false,
    stored: false,
    invalid: "no",
    getter: getters.getEvidenceGateEnabled,
    unset: true,
  },
  // experiment.* is one atomic block: its four fields are set together (see the group test).
  { key: "experiment.name", def: null, valid: " exp-1 ", stored: "exp-1", invalid: "", group: true },
  { key: "experiment.arms", def: [], valid: [" a ", "b"], stored: ["a", "b"], invalid: [], group: true },
  { key: "experiment.registration", def: null, valid: "reg-1", stored: "reg-1", invalid: "", group: true },
  { key: "experiment.registration_version", def: null, valid: 2, stored: 2, invalid: "2", group: true },
  {
    key: "docs.mode",
    def: "off",
    valid: "auto",
    stored: "auto",
    invalid: "bogus",
    getter: getters.getDocsMode,
    unset: "off",
  },
  {
    key: "docs.language",
    def: "en",
    valid: "PT-BR",
    stored: "pt-br",
    invalid: "not a tag",
    getter: getters.getDocsLanguage,
    unset: "en",
  },
  {
    key: "generation.model",
    def: "gemma3:4b",
    valid: " llama3:8b ",
    stored: "llama3:8b",
    invalid: "   ",
    getter: (p) => getters.resolveGenerationModel(p),
    unset: "gemma3:4b",
  },
  // Answer fields of the model recommendation are written by the daemon only.
  { key: "modelRecommendation.id", def: null, locked: true },
  { key: "modelRecommendation.answer", def: null, locked: true },
  { key: "modelRecommendation.at", def: null, locked: true },
  {
    key: "ui.enabled",
    def: UI_DEFAULT,
    valid: true,
    stored: true,
    invalid: "x",
    getter: getters.getUiEnabled,
    unset: UI_DEFAULT,
  },
  { key: "ui.backdrop", def: "none", valid: "aurora", stored: "aurora", invalid: "nope" },
  { key: "ui.backdropDim", def: 80, valid: 65, stored: 65, invalid: 52 },
  { key: "ui.backdropBlur", def: false, valid: true, stored: true, invalid: "x" },
  // The address name starts the address setup; the web API refuses it (see below).
  { key: "assistant.name", def: null, valid: " Jarvis ", stored: "jarvis", invalid: "", managed: true },
  { key: "assistant.displayName", def: null, locked: true },
  { key: "soul.direction", def: "balanced", valid: "warm", stored: "warm", invalid: "bogus" },
  {
    key: "soul.text",
    def: "",
    valid: " be brief ",
    stored: "be brief",
    invalid: "x".repeat(SOUL_TEXT_MAX + 1),
  },
  {
    key: "reflex.enabled",
    def: true,
    valid: false,
    stored: false,
    invalid: "maybe",
    getter: getters.getReflexEnabled,
    unset: true,
  },
  { key: "reflex.maxPerTurn", def: 2, valid: 3, stored: 3, invalid: 6 },
  {
    key: "size.guide",
    def: 500,
    valid: 300,
    stored: 300,
    invalid: "x",
    getter: getters.getSizeGuide,
    unset: undefined,
  },
  { key: "size.critical", def: 800, valid: 900, stored: 900, invalid: "x" },
  { key: "size.exemptPaths", def: [], valid: [" a/** "], stored: ["a/**"], invalid: [] },
  {
    key: "archive.retain",
    def: "junk=1,in-git=2,user=2",
    valid: "junk=1,in-git=3,user=4",
    stored: "junk=1,in-git=3,user=4",
    invalid: "bogus",
    getter: getters.getArchiveRetain,
    unset: undefined,
  },
  {
    key: "archive.enabled",
    def: false,
    valid: true,
    stored: true,
    invalid: 1,
    getter: getters.getArchiveEnabled,
    unset: false,
  },
  {
    key: "archive.cap",
    def: "10GB",
    valid: "5GB",
    stored: "5GB",
    invalid: "0",
    getter: getters.getArchiveCap,
    unset: undefined,
  },
  {
    key: "archive.max-item",
    def: null,
    valid: "2GB",
    stored: "2GB",
    invalid: "bogus",
    getter: getters.getArchiveMaxItem,
    unset: undefined,
  },
  {
    key: "battery.saver",
    def: false,
    valid: true,
    stored: true,
    invalid: "x",
    getter: getters.getBatterySaver,
    unset: undefined,
  },
  {
    key: "daemon.env",
    def: {},
    valid: { BASTRA_LOG_RETENTION_DAYS: "60" },
    stored: { BASTRA_LOG_RETENTION_DAYS: "60" },
    invalid: { NOT_A_DAEMON_KEY: "1" },
  },
  {
    key: "language.primary",
    def: null,
    valid: " DE ",
    stored: "de",
    invalid: "deu",
    getter: getters.getPrimaryLanguage,
    unset: undefined,
  },
  { key: "code.repos", def: [], valid: [" /tmp/repo "], stored: ["/tmp/repo"], invalid: [] },
  { key: "promptImpact.enabled", def: false, valid: true, stored: true, invalid: "x" },
  { key: "coverageMap.enabled", def: false, valid: true, stored: true, invalid: "x" },
  { key: "tasks.enabled", def: true, valid: false, stored: false, invalid: "maybe" },
  { key: "tasks.notifications", def: true, valid: false, stored: false, invalid: "x" },
  { key: "tasks.chatActiveMinutes", def: 30, valid: 45, stored: 45, invalid: 0 },
  { key: "tasks.reportUndo", def: "10m", valid: " 2H ", stored: "2h", invalid: "bogus" },
  { key: "tasks.chatConsent", def: null, locked: true },
  { key: "redaction.enabled", def: true, valid: false, stored: false, invalid: "x" },
  { key: "telemetry.enabled", def: true, valid: false, stored: false, invalid: "x" },
];

const ENV_NAMES = [
  ...new Set([
    ...settingEntries().flatMap((e) => (e.env ? [e.env] : [])),
    "BASTRA_RERANK_MODEL",
    "NEXUS_TELEMETRY",
    "OPENAI_API_KEY",
    "BASTRA_EMBEDDING_KEY",
  ]),
];

/** Run `fn` with HOME and the database in a temp dir and every setting env variable unset. */
async function isolated<T>(fn: (dir: string, path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-settings-paths-"));
  const saved = { ...process.env };
  process.env.HOME = dir;
  process.env.BASTRA_DB_PATH = join(dir, "recall.db");
  for (const name of ENV_NAMES) delete process.env[name];
  try {
    return await fn(dir, join(dir, "cli-settings.json"));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    await rm(dir, { recursive: true, force: true });
  }
}

const entryOf = (key: string): SettingEntry => settingEntries().find((e) => e.key === key)!;

test("#1510: the table names exactly the 50 registry keys", () => {
  const keys = settingEntries().map((e) => e.key);
  assert.equal(ROWS.length, 50);
  assert.deepEqual(
    ROWS.map((r) => r.key),
    keys
  );
});

test("#1510: registry defaults are the pinned values", () => {
  for (const row of ROWS) assert.deepEqual(entryOf(row.key).default, row.def, row.key);
});

test("#1510: an empty file reads back as the default through every reader", async () => {
  await isolated(async (_dir, path) => {
    const settings = await readSettings(path);
    for (const row of ROWS) {
      const entry = entryOf(row.key);
      assert.equal(storedSetting(settings, entry), storedWhenUnset(row.key), `${row.key} stored`);
      const eff = effectiveSetting(entry, settings, {}).value;
      assert.deepEqual(eff, EFFECTIVE_OVERRIDE[row.key] ?? row.def, `${row.key} effective`);
      if (row.getter) assert.deepEqual(await row.getter(path), row.unset, `${row.key} getter`);
    }
    // The readers that do not go through settings.ts.
    assert.equal(runtimeFeatureSetting("tasks", true), true, "tasks reader");
    assert.equal(runtimeFeatureSetting("telemetry", true), true, "telemetry reader");
    assert.equal(redactionEnabled(), true, "redaction reader");
    assert.equal(await getters.getExperimentConfig(path), null, "experiment reader");
  });
});

test("#1510: valid values parse to the stored form, invalid values are refused", () => {
  for (const row of ROWS) {
    if (row.locked) {
      assert.throws(() => parseSettingValue(row.key, "x"), /read-only/, `${row.key} locked`);
      continue;
    }
    assert.deepEqual(parseSettingValue(row.key, row.valid), row.stored, `${row.key} valid`);
    assert.throws(() => parseSettingValue(row.key, row.invalid), /Invalid value/, `${row.key} invalid`);
  }
});

interface Api {
  post(changes: Record<string, unknown>): Promise<{ status: number; entries?: Array<Record<string, unknown>> }>;
}

async function withApi(path: string, run: (api: Api) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    if (!dispatchSettingsUi(req, res, req.method!, req.url!, { path })) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const session = await fetch(origin + "/ui/settings/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: "{}",
    });
    const cookie = session.headers.get("set-cookie")!.split(";")[0];
    const csrf = ((await session.json()) as { csrf: string }).csrf;
    await run({
      async post(changes) {
        const res = await fetch(origin + "/ui/settings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: origin,
            Cookie: cookie,
            "X-Bastra-Settings-CSRF": csrf,
          },
          body: JSON.stringify({ changes }),
        });
        const body = (await res.json()) as { entries?: Array<Record<string, unknown>> };
        return { status: res.status, entries: body.entries };
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

test("#1510: the web settings API accepts, refuses and resets every key", async () => {
  await isolated(async (_dir, path) => {
    await withApi(path, async (api) => {
      const stored = async (key: string) => storedSetting(await readSettings(path), entryOf(key));
      const group = ROWS.filter((r) => r.group);
      const settable = ROWS.filter((r) => !r.locked && !r.managed && !r.group);

      for (const row of ROWS.filter((r) => r.locked || r.managed)) {
        const res = await api.post({ [row.key]: row.valid ?? "x" });
        assert.equal(res.status, 400, `${row.key} refused`);
        assert.equal(await stored(row.key), storedWhenUnset(row.key), `${row.key} still unset`);
      }

      for (const row of settable) {
        const bad = await api.post({ [row.key]: row.invalid });
        assert.equal(bad.status, 400, `${row.key} invalid refused`);
        assert.equal(await stored(row.key), storedWhenUnset(row.key), `${row.key} not stored after refusal`);

        const ok = await api.post({ [row.key]: row.valid });
        assert.equal(ok.status, 200, `${row.key} valid accepted`);
        assert.deepEqual(await stored(row.key), row.stored, `${row.key} stored`);
        const shown = ok.entries!.find((e) => e.key === row.key)!;
        assert.equal(shown.isSet, true, `${row.key} isSet`);
        assert.deepEqual(
          shown.default,
          entryOf(row.key).secret && row.def !== null ? "••••••••" : row.def,
          `${row.key} default shown`
        );

        const reset = await api.post({ [row.key]: null });
        assert.equal(reset.status, 200, `${row.key} reset`);
        assert.equal(await stored(row.key), storedWhenUnset(row.key), `${row.key} back to unset`);
      }

      // One atomic block: a single field alone is refused, all four together are stored.
      const one = await api.post({ [group[0].key]: group[0].valid });
      assert.equal(one.status, 400, "a lone experiment field is refused");
      const all = await api.post(Object.fromEntries(group.map((r) => [r.key, r.valid])));
      assert.equal(all.status, 200, "experiment block accepted");
      for (const row of group) assert.deepEqual(await stored(row.key), row.stored, row.key);
      for (const row of group) {
        const bad = await api.post({ [row.key]: row.invalid });
        assert.equal(bad.status, 400, `${row.key} invalid refused`);
        assert.deepEqual(await stored(row.key), row.stored, `${row.key} unchanged after refusal`);
      }
    });
  });
});

test("#1510: the stored value is what the named reader and the effective value return", async () => {
  await isolated(async (_dir, path) => {
    for (const row of ROWS.filter((r) => !r.locked && !r.managed && !r.group)) {
      await mutateSettings(path, (current) => ({
        ...current,
        ...Object.fromEntries([
          [
            entryOf(row.key).path[0],
            { ...(current as never)[entryOf(row.key).path[0]], [entryOf(row.key).path[1]]: row.stored },
          ],
        ]),
      }));
      const settings = await readSettings(path);
      assert.deepEqual(storedSetting(settings, entryOf(row.key)), row.stored, `${row.key} round trip`);
      if (row.getter) assert.deepEqual(await row.getter(path), row.stored, `${row.key} getter after store`);
    }
  });
});
