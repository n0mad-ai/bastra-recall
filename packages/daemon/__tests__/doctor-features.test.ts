/**
 * `bastra doctor` reports which Recall features are switched off, not only
 * which registrations are broken.
 *
 * The finding this exists for: a contributor installed Recall before
 * onboarding existed and learned weeks later that half the features were off —
 * no primary language (every memory authored in English), hooks switched off
 * in his client settings — while doctor called everything healthy, because it
 * only ever asked about registrations.
 *
 * Pinned here: every core feature has an on and an off line, every off line
 * carries the command that turns it on, and the opt-in / experimental features
 * sit under a heading that says they are off on purpose — never with the
 * off-marker the core features use.
 *
 * `collectFeatureState` runs against a temp HOME and an unreachable daemon, so
 * the developer's own settings, vault and live daemon are never read.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/doctor-features.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { collectFeatureState, featureLines, type FeatureState } from "../src/cli/features-note.js";

function allOff(): FeatureState {
  return {
    clients: [{ surface: "claude-code", features: { recallHooks: false, stopHook: false, skill: false } }],
    primaryLanguage: undefined,
    onboardingDone: false,
    vaultSize: 3,
    semanticRecall: { state: "off", detail: "keyword search only" },
    reflex: { enabled: false, offBy: "reflex.enabled = false" },
    codeAwareness: { repos: 0, offByEnv: false },
    promptImpact: false,
    docsMode: "off",
    commons: false,
    bridges: false,
    ui: false,
  };
}

function allOn(): FeatureState {
  return {
    clients: [{ surface: "codex", features: { recallHooks: true, stopHook: true, skill: true } }],
    primaryLanguage: "de",
    onboardingDone: true,
    semanticRecall: { state: "on", detail: "ollama" },
    reflex: { enabled: true },
    codeAwareness: { repos: 2, offByEnv: false },
    promptImpact: true,
    docsMode: "suggest",
    commons: true,
    bridges: true,
    ui: true,
  };
}

function lineFor(lines: string[], name: string): string {
  const hit = lines.find((l) => l.includes(`${name}:`));
  assert.ok(hit, `no line for '${name}' in:\n${lines.join("\n")}`);
  return hit;
}

/** The core block ends where the optional heading starts. */
function split(lines: string[]): { core: string[]; optional: string[] } {
  const at = lines.findIndex((l) => l.includes("off by default on purpose"));
  assert.ok(at > 0, "the optional features need their own heading");
  return { core: lines.slice(0, at), optional: lines.slice(at + 1) };
}

test("the contributor's case: no primary language says English and names the command", () => {
  const line = lineFor(featureLines(allOff()), "memory language");
  assert.match(line, /not set, memories are written in English/);
  assert.match(line, /bastra config set language\.primary <code>/);
});

test("every core feature that is off carries the command that turns it on", () => {
  const lines = featureLines(allOff());
  const expected: Array<[string, RegExp]> = [
    ["claude-code: recall hooks", /bastra install claude-code/],
    ["claude-code: auto-save suggestions (Stop hook)", /bastra install claude-code/],
    ["claude-code: skill", /bastra install claude-code/],
    ["onboarding", /never done .*bastra onboard/],
    ["semantic recall", /bastra embeddings on/],
    ["reflex memories", /remove "reflex\.enabled"/],
  ];
  for (const [name, hint] of expected) {
    const line = lineFor(lines, name);
    assert.match(line, /○/, `'${name}' off must use the off marker`);
    assert.match(line, hint, line);
  }
});

test("hooks switched off in the client itself are named, even when every lane is registered", () => {
  const state = allOn();
  state.clients = [{
    surface: "claude-code",
    features: { recallHooks: true, stopHook: true, skill: true, hooksDisabledBy: '"disableAllHooks": true in ~/.claude/settings.json' },
  }];
  const line = lineFor(featureLines(state), "claude-code: recall hooks");
  assert.match(line, /off \("disableAllHooks": true/);
  assert.doesNotMatch(line, /✓/);
});

test("a reflex kill switch from the environment points at the variable, not the file", () => {
  const state = allOff();
  state.reflex = { enabled: false, offBy: "BASTRA_REFLEX=off" };
  assert.match(lineFor(featureLines(state), "reflex memories"), /unset BASTRA_REFLEX/);
});

test("a degraded embedding engine is not reported as on", () => {
  const state = allOn();
  state.semanticRecall = { state: "degraded", detail: "ollama" };
  const line = lineFor(featureLines(state), "semantic recall");
  assert.match(line, /degraded .*bastra embeddings on/);
});

test("optional features that are off are marked intentional, never with the off marker", () => {
  const { optional } = split(featureLines(allOff()));
  const expected: Array<[string, RegExp]> = [
    ["code awareness", /bastra code enable/],
    ["change impact in prompts (experimental)", /promptImpact/],
    ["product docs", /bastra config set docs\.mode suggest/],
    ["Bastra Commons", /bastra commons enable/],
    ["shared recall bridges", /bastra bridges enable/],
    ["vault map", /bastra config set ui\.enabled true/],
  ];
  for (const [name, hint] of expected) {
    const line = lineFor(optional, name);
    assert.doesNotMatch(line, /○|⚠/, `'${name}' is off on purpose and must not read as a problem`);
    assert.match(line, hint, line);
  }
});

test("everything on: one on-line per feature and no hints anywhere", () => {
  const lines = featureLines(allOn());
  const { core } = split(lines);
  for (const line of core.slice(1)) assert.match(line, /✓/, line);
  assert.ok(lines.every((l) => !l.includes("→ bastra")), lines.join("\n"));
  assert.match(lineFor(lines, "memory language"), /: de$/);
  assert.match(lineFor(lines, "code awareness"), /on for 2 repositories/);
});

test("an established vault without the interview: onboarding is a hint, not an off-feature", () => {
  for (const vaultSize of [1296, undefined]) {
    const state = allOff();
    state.vaultSize = vaultSize;
    const line = lineFor(featureLines(state), "onboarding");
    assert.doesNotMatch(line, /○/, `vaultSize=${vaultSize}: ${line}`);
    assert.match(line, /never done .*bastra onboard/);
  }
});

test("no vault configured: the onboarding line is left out rather than guessed", () => {
  const state = allOff();
  state.onboardingDone = null;
  assert.ok(!featureLines(state).some((l) => l.includes("onboarding")));
});

test("collectFeatureState reads settings, the vault marker and the env switches", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "bastra-doctor-features-"));
  const vault = join(home, "vault");
  await mkdir(join(home, ".bastra"), { recursive: true });
  await mkdir(vault, { recursive: true });
  const saved = { HOME: process.env.HOME, URL: process.env.BASTRA_DAEMON_URL };
  // Port 1 refuses at once: the developer's live daemon is never asked.
  process.env.BASTRA_DAEMON_URL = "http://127.0.0.1:1";
  process.env.HOME = home;
  t.after(async () => {
    process.env.HOME = saved.HOME;
    if (saved.URL === undefined) delete process.env.BASTRA_DAEMON_URL;
    else process.env.BASTRA_DAEMON_URL = saved.URL;
    await rm(home, { recursive: true, force: true });
  });

  const empty = await collectFeatureState([], vault, {});
  assert.equal(empty.primaryLanguage, undefined);
  assert.equal(empty.onboardingDone, false);
  assert.equal(empty.semanticRecall.state, "off");
  assert.deepEqual(empty.reflex, { enabled: true });
  assert.equal(empty.promptImpact, false);
  assert.equal(empty.docsMode, "off");

  await writeFile(join(home, ".bastra", "cli-settings.json"), JSON.stringify({
    update: { mode: "notify" },
    language: { primary: "de" },
    embedding: { provider: "ollama" },
    reflex: { enabled: false },
    docs: { mode: "suggest" },
    commons: { enabled: true },
  }));
  await writeFile(join(vault, ".onboarding-done"), "onboarded via test\n");
  const set = await collectFeatureState([], vault, { BASTRA_CODE_AWARENESS: "off" });
  assert.equal(set.primaryLanguage, "de");
  assert.equal(set.onboardingDone, true);
  assert.equal(set.semanticRecall.state, "on");
  assert.deepEqual(set.reflex, { enabled: false, offBy: "reflex.enabled = false" });
  assert.equal(set.codeAwareness.offByEnv, true);
  assert.equal(set.docsMode, "suggest");
  assert.equal(set.commons, true);
});


/**
 * The Claude Code adapter fills the per-client row. Its paths are resolved
 * from HOME at import time, so it runs in a child with a temp HOME — the
 * developer's real ~/.claude files are never read.
 */
function claudeCodeFeaturesIn(home: string): unknown {
  const adapter = new URL("../src/cli/adapters/claude-code.ts", import.meta.url).href;
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "-e", `import(${JSON.stringify(adapter)}).then(async (m) => { const r = await m.claudeCodeAdapter.doctor(); process.stdout.write(JSON.stringify(r.features ?? null)); })`],
    { env: { ...process.env, HOME: home, BASTRA_DAEMON_URL: "http://127.0.0.1:1" }, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("claude-code: disableAllHooks, a missing Stop hook and a missing skill reach the features row", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "bastra-doctor-features-cc-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(join(home, ".claude.json"), JSON.stringify({
    mcpServers: { "bastra-recall": { command: "node", args: [join(home, "forwarder.js")] } },
  }));
  const lane = (sub: string) => ({ hooks: [{ type: "command", command: `${join(home, "bastra-hook")} ${sub}`, __bastraRecall: true }] });
  await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({
    disableAllHooks: true,
    hooks: {
      SessionStart: [{ matcher: "startup|resume|clear|compact", ...lane("session") }],
      UserPromptSubmit: [lane("prompt")],
      PreToolUse: [
        { matcher: "Write|Edit|MultiEdit|NotebookEdit", ...lane("write") },
        { matcher: "TodoWrite|TaskCreate", ...lane("todo") },
        { matcher: "Bash", ...lane("bash-pre") },
      ],
      PostToolUse: [{ matcher: "Bash", ...lane("bash-fail") }],
      PostToolUseFailure: [{ matcher: "Bash", ...lane("bash-fail") }],
    },
  }));
  const features = claudeCodeFeaturesIn(home) as Record<string, unknown>;
  assert.equal(features.recallHooks, true);
  assert.equal(features.stopHook, false);
  assert.equal(features.skill, false);
  assert.match(String(features.hooksDisabledBy), /"disableAllHooks": true/);
});

test("claude-code: no MCP registration means no features row", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "bastra-doctor-features-cc-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(claudeCodeFeaturesIn(home), null);
});
