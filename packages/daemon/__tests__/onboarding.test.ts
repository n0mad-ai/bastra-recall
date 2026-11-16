/**
 * Tests für das Onboarding-Interview:
 *   - questionsFor — Persona steuert den Katalog (mixed = je erste Frage)
 *   - buildOnboardingMemories — Templates, user-directed, leere Antworten raus
 *   - Marker / isOnboardingNeeded — frisch vs. groß vs. erledigt
 *   - GET/POST /ui/onboarding — ui.enabled-Gating, Save-Pfad, skip
 *
 * Runner: `tsx --test __tests__/onboarding.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import {
  questionsFor,
  buildOnboardingMemories,
  saveOnboardingMemories,
  isOnboardingNeeded,
  isOnboardingDone,
  markOnboardingDone,
  handleUiOnboarding,
  ONBOARD_MARKER,
  FRESH_VAULT_MAX,
} from "../src/onboarding.js";
import { setUiEnabled } from "../src/settings.js";

test("questionsFor: persona steers the catalog, mixed gets one follow-up per persona", () => {
  assert.deepEqual(
    questionsFor("developer").map((q) => q.id),
    ["identity", "rules", "stack", "projects", "workflow", "conventions_size", "conventions_structure", "freeform"]
  );
  assert.deepEqual(
    questionsFor("mixed").map((q) => q.id),
    ["identity", "rules", "stack", "role", "world", "freeform"]
  );
  assert.deepEqual(
    questionsFor("personal").map((q) => q.id),
    ["identity", "rules", "world", "remember", "goals", "freeform"]
  );
});

test("buildOnboardingMemories: usage-profile always, one memory per answer, all user-directed", () => {
  const memories = buildOnboardingMemories("developer", {
    identity: "Daniel · German, informal · terse and technical",
    stack: "TypeScript + Node, no ORMs",
    workflow: "   ", // whitespace-only → skipped
  });
  assert.deepEqual(
    memories.map((m) => m.id),
    ["profile-recall-usage", "profile-how-to-address-me", "profile-stack"]
  );
  for (const m of memories) {
    assert.equal(m.write_origin, "user-directed");
    assert.equal(m.overwrite, true);
    assert.equal(m.scope, "user-preference");
    assert.ok((m.recall_when?.length ?? 0) >= 2, `${m.id} needs concrete triggers`);
  }
  assert.match(memories[1].summary, /German, informal/);
});

test("saveOnboardingMemories: CLI answers share one user-authored audit run", async () => {
  const vaultDir = await mkdtemp(join(tmpdir(), "bastra-onboard-cli-vault-"));
  try {
    const memories = buildOnboardingMemories("developer", {
      identity: "Sam · English · terse",
      stack: "TypeScript and Node",
    });
    await saveOnboardingMemories(vaultDir, memories, "cli:onboard");

    const raw = await readFile(join(vaultDir, ".bastra", "audit-log.ndjson"), "utf8");
    const entries = raw
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            actor: string;
            actor_detail?: string;
            session_id?: string;
          }
      );
    assert.equal(entries.length, memories.length);
    assert.ok(entries.every((entry) => entry.actor === "user"));
    assert.ok(entries.every((entry) => entry.actor_detail === "cli:onboard"));
    assert.equal(new Set(entries.map((entry) => entry.session_id)).size, 1);
    assert.ok(entries[0].session_id);
  } finally {
    await rm(vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("marker: fresh vault needs onboarding, done or big vault does not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-onboard-"));
  try {
    assert.equal(await isOnboardingNeeded(dir, 3), true);
    assert.equal(await isOnboardingNeeded(dir, FRESH_VAULT_MAX), false, "big vault never nudges");
    await markOnboardingDone(dir, "cli");
    assert.equal(await isOnboardingDone(dir), true);
    assert.equal(await isOnboardingNeeded(dir, 3), false);
    assert.match(await readFile(join(dir, ONBOARD_MARKER), "utf8"), /via cli/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("GET/POST /ui/onboarding: gated on ui.enabled, saves user-directed memories, skip sets marker only", async () => {
  const vaultDir = await mkdtemp(join(tmpdir(), "bastra-onboard-ui-vault-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "bastra-onboard-ui-settings-"));
  const settingsPath = join(settingsDir, "cli-settings.json");
  const server = createServer((req, res) => {
    void handleUiOnboarding(req, res, vaultDir, 3, settingsPath);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const call = (method: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/ui/onboarding",
          method,
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw) as Record<string, unknown> })
          );
        }
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });

  try {
    // Stored off: the default is on under macOS.
    await setUiEnabled(false, settingsPath);
    assert.equal((await call("GET")).status, 404, "ui disabled → 404");

    await setUiEnabled(true, settingsPath);

    const cat = await call("GET");
    assert.equal(cat.status, 200);
    assert.equal(cat.json.needed, true);
    assert.equal((cat.json.personas as unknown[]).length, 4);
    assert.ok((cat.json.questions as unknown[]).length >= 10);

    assert.equal((await call("POST", { persona: "pirate" })).status, 400, "unknown persona rejected");

    const saved = await call("POST", {
      persona: "personal",
      answers: { identity: "Sam · English · warm and brief", world: "Two kids, Berlin, gym on Tuesdays" },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.saved, 3, "usage-profile + 2 answers");
    const profile = await readFile(join(vaultDir, "memories", "user", "profile-how-to-address-me.md"), "utf8");
    assert.match(profile, /write_origin: user-directed/);
    assert.equal(await isOnboardingDone(vaultDir), true);

    const auditRaw = await readFile(join(vaultDir, ".bastra", "audit-log.ndjson"), "utf8");
    const audit = auditRaw
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            actor: string;
            actor_detail?: string;
            operation: string;
            session_id?: string;
          }
      );
    assert.equal(audit.length, 3, "every onboarding memory needs one audit entry");
    assert.ok(audit.every((entry) => entry.actor === "user"));
    assert.ok(audit.every((entry) => entry.actor_detail === "ui:onboarding"));
    assert.ok(audit.every((entry) => entry.operation === "create"));
    assert.equal(
      new Set(audit.map((entry) => entry.session_id)).size,
      1,
      "one onboarding submission is one reconstructable audit run"
    );
    assert.ok(audit[0].session_id);

    const again = await call("GET");
    assert.equal(again.json.needed, false, "marker stops the auto-open");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(vaultDir, { recursive: true, force: true });
    await rm(settingsDir, { recursive: true, force: true });
  }
});

test("POST /ui/onboarding skip: marker without any saved memory", async () => {
  const vaultDir = await mkdtemp(join(tmpdir(), "bastra-onboard-skip-vault-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "bastra-onboard-skip-settings-"));
  const settingsPath = join(settingsDir, "cli-settings.json");
  await writeFile(settingsPath, JSON.stringify({ ui: { enabled: true } }));
  const server = createServer((req, res) => {
    void handleUiOnboarding(req, res, vaultDir, 0, settingsPath);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/ui/onboarding",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        }
      );
      req.on("error", reject);
      req.end(JSON.stringify({ skip: true }));
    });
    assert.equal(status, 200);
    assert.equal(await isOnboardingDone(vaultDir), true);
    await assert.rejects(access(join(vaultDir, "memories")), "no memory written on skip");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(vaultDir, { recursive: true, force: true });
    await rm(settingsDir, { recursive: true, force: true });
  }
});

test("persistConventionSettings: size answer lands in cli-settings, junk stays out", async () => {
  const { persistConventionSettings } = await import("../src/onboarding.js");
  const { getSizeGuide } = await import("../src/settings.js");
  const dir = await mkdtemp(join(tmpdir(), "bastra-onboard-size-"));
  const settingsPath = join(dir, "cli-settings.json");
  try {
    await persistConventionSettings({ conventions_size: "so um die 600 Zeilen" }, settingsPath);
    assert.equal(await getSizeGuide(settingsPath), 600, "first number in the answer wins");

    await persistConventionSettings({ conventions_size: "keine Ahnung" }, settingsPath);
    assert.equal(await getSizeGuide(settingsPath), 600, "no number → previous value untouched");

    await persistConventionSettings({}, settingsPath);
    assert.equal(await getSizeGuide(settingsPath), 600, "no answer → untouched");

    await persistConventionSettings({ conventions_size: "42" }, settingsPath);
    assert.equal(await getSizeGuide(settingsPath), 100, "clamped to the 100..5000 range");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("persistLanguageSetting: explicit language in identity beats answer-text detection", async () => {
  const { persistLanguageSetting } = await import("../src/onboarding.js");
  const { getPrimaryLanguage } = await import("../src/settings.js");
  const dir = await mkdtemp(join(tmpdir(), "bastra-onboard-lang-"));
  const settingsPath = join(dir, "cli-settings.json");
  try {
    // identity names German; the rest of the body is English prose → explicit wins.
    await persistLanguageSetting(
      {
        identity: "Daniel · Deutsch, Du-Form · terse",
        stack: "I write TypeScript and Node with a lot of tests and small reviews",
      },
      settingsPath
    );
    assert.equal(await getPrimaryLanguage(settingsPath), "de", "explicit 'Deutsch' beats the English body");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("persistLanguageSetting: explicit language names map to ISO codes (Latin + non-Latin)", async () => {
  const { persistLanguageSetting } = await import("../src/onboarding.js");
  const { getPrimaryLanguage } = await import("../src/settings.js");
  const cases: Array<[string, string]> = [
    ["Daniel · Deutsch, Du-Form", "de"],
    ["Sam · English, terse and technical", "en"],
    ["по-русски, кратко (русский)", "ru"],
    ["en français, tutoiement", "fr"],
    ["日本語で、簡潔に", "ja"],
    ["中文，简洁", "zh"],
  ];
  for (const [identity, expected] of cases) {
    const dir = await mkdtemp(join(tmpdir(), "bastra-lang-name-"));
    const settingsPath = join(dir, "cli-settings.json");
    try {
      await persistLanguageSetting({ identity }, settingsPath);
      assert.equal(await getPrimaryLanguage(settingsPath), expected, `identity=${JSON.stringify(identity)}`);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

test("persistLanguageSetting: falls back to detection over all answers when no name is given", async () => {
  const { persistLanguageSetting } = await import("../src/onboarding.js");
  const { getPrimaryLanguage } = await import("../src/settings.js");
  const dir = await mkdtemp(join(tmpdir(), "bastra-onboard-lang-fb-"));
  const settingsPath = join(dir, "cli-settings.json");
  try {
    // No language name anywhere; German function words carry the detection.
    await persistLanguageSetting(
      {
        identity: "Sam, bitte kurz und technisch",
        world: "Ich habe zwei Kinder und wohne in Berlin, das ist mir sehr wichtig",
      },
      settingsPath
    );
    assert.equal(await getPrimaryLanguage(settingsPath), "de", "detected from German function words");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("persistLanguageSetting: no language signal leaves an existing value untouched", async () => {
  const { persistLanguageSetting } = await import("../src/onboarding.js");
  const { getPrimaryLanguage, setPrimaryLanguage } = await import("../src/settings.js");
  const dir = await mkdtemp(join(tmpdir(), "bastra-onboard-lang-none-"));
  const settingsPath = join(dir, "cli-settings.json");
  try {
    await setPrimaryLanguage("fr", settingsPath);
    // Code-shaped answers, no language name, no function words → detector abstains.
    await persistLanguageSetting(
      { identity: "Sam", stack: "TypeScript Node Postgres Docker Kubernetes" },
      settingsPath
    );
    assert.equal(await getPrimaryLanguage(settingsPath), "fr", "no signal → previous value kept, never cleared");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("file-size-check reads the onboarded guide value from cli-settings", async () => {
  const { thresholdsFor, readSizeSettings } = await import("../src/file-size-check.js");
  const dir = await mkdtemp(join(tmpdir(), "bastra-size-settings-"));
  const settingsPath = join(dir, "cli-settings.json");
  try {
    await writeFile(settingsPath, JSON.stringify({ size: { guide: 300 } }), "utf8");
    const s = await readSizeSettings(settingsPath);
    assert.deepEqual(thresholdsFor("/x/app.js", s), { guide: 300, critical: 800 });
    assert.deepEqual(
      thresholdsFor("/x/a.test.ts", s),
      { guide: 700, critical: 1000 },
      "tests keep the fixed convention"
    );
    assert.deepEqual(await readSizeSettings(join(dir, "missing.json")), {}, "missing file → empty, never throws");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
