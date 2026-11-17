/**
 * #1530 characterization of resolveSegments (TUI grid): every segment group,
 * its parts, part colours and segment templates. Pinned before the function
 * was cut along the segment groups; the resolved values must stay
 * byte-identical.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PowerlineRenderer } from "../../packages/statusline/src/powerline.ts";
import { DEFAULT_CONFIG } from "../../packages/statusline/src/config/defaults.ts";
import { SYMBOLS, TEXT_SYMBOLS } from "../../packages/statusline/src/utils/constants.ts";
import { resolveSegments } from "../../packages/statusline/src/tui/sections.ts";

const NOW = Date.parse("2026-11-17T10:00:00.000Z");
const ENV_VAR = "BASTRA_TUI_SEGMENTS_TEST_ENV";

function setup({ templates, partFg } = {}) {
  const config = structuredClone(DEFAULT_CONFIG);
  // Non-TTY test runs resolve "auto" to no colour; pin it so colours appear.
  config.display.colorCompatibility = "truecolor";
  const line = config.display.lines[0].segments;
  line.thinking = { enabled: true, showEnabled: true, showEffort: true };
  line.cacheTimer = { enabled: true };
  line.env = { enabled: true, variable: ENV_VAR, prefix: "env" };
  if (templates) config.display.tui = { ...config.display.tui, segments: templates };
  const colors = new PowerlineRenderer(config).theme.getThemeColors();
  if (partFg) colors.partFg = partFg;
  return { config, colors };
}

function fullData(colors) {
  return {
    hookData: {
      session_id: "0123abcd-4567-89ef-0123-456789abcdef",
      cwd: "/tmp/tui-segments/project-dir",
      workspace: { current_dir: "/tmp/tui-segments/project-dir" },
      model: { id: "claude-opus-4-1", display_name: "Opus 4.1" },
      version: "2.1.78",
      agent: { name: "reviewer" },
      thinking: { enabled: true },
      effort: { level: "high" },
      rate_limits: {
        five_hour: { used_percentage: 37, resets_at: NOW / 1000 + 5400 },
        seven_day: { used_percentage: 64, resets_at: NOW / 1000 + 3 * 86400 },
      },
    },
    usageInfo: {
      session: {
        cost: 1.234,
        calculatedCost: 1.234,
        officialCost: null,
        tokens: 123456,
        tokenBreakdown: { input: 1000, output: 2000, cacheCreation: 300, cacheRead: 120156 },
      },
    },
    blockInfo: { nativeUtilization: 37, timeRemaining: 90 },
    todayInfo: {
      cost: 4.5,
      tokens: 456789,
      tokenBreakdown: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 },
      date: "2026-11-17",
    },
    contextInfo: {
      totalTokens: 140000,
      percentage: 70,
      usablePercentage: 87,
      contextLeftPercentage: 13,
      maxTokens: 200000,
      usableTokens: 160000,
    },
    metricsInfo: {
      responseTime: 3.2,
      lastResponseTime: 1.1,
      sessionDuration: 3725,
      messageCount: 12,
      linesAdded: 40,
      linesRemoved: 7,
    },
    gitInfo: {
      branch: "feature/tui",
      status: "dirty",
      ahead: 2,
      behind: 1,
      sha: "abc1234",
      staged: 1,
      unstaged: 2,
      untracked: 3,
    },
    cacheTimerInfo: { elapsedSeconds: 200, detectedTtlSeconds: 300 },
    bastraInfo: null,
    tmuxSessionId: "work",
    colors,
  };
}

function emptyData(colors) {
  return {
    hookData: { session_id: "s" },
    usageInfo: null,
    blockInfo: null,
    todayInfo: null,
    contextInfo: null,
    metricsInfo: null,
    gitInfo: null,
    cacheTimerInfo: null,
    bastraInfo: null,
    tmuxSessionId: null,
    colors,
  };
}

function resolve(data, { config, colors }, sym = SYMBOLS, contentWidth = 80) {
  return resolveSegments(data, { data, sym, config, reset: "\x1b[0m", colors, contentWidth });
}

function withEnv(t) {
  const before = process.env[ENV_VAR];
  process.env[ENV_VAR] = "staging";
  t.after(() => {
    if (before === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = before;
  });
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
}

const GROUPS = [
  "model",
  "context",
  "block",
  "session",
  "today",
  "weekly",
  "git",
  "dir",
  "version",
  "tmux",
  "metrics",
  "activity",
  "env",
  "agent",
  "thinking",
  "cacheTimer",
];

test("every segment group resolves a whole value plus its parts", (t) => {
  withEnv(t);
  const s = setup();
  const { data, templates } = resolve(fullData(s.colors), s);
  assert.deepEqual(templates, {}, "no templates without tui.segments");
  for (const group of GROUPS) {
    assert.equal(typeof data[group], "string", group);
    assert.ok(
      Object.keys(data).some((key) => key.startsWith(`${group}.`)),
      `${group} has parts`
    );
  }
  assert.ok(data.model.includes("opus 4.1"), "the model name is lower-cased");
  assert.ok(data["model.value"].includes("opus 4.1"));
  assert.ok(data.tmux.includes("work"));
  assert.ok(data["env.value"].includes("staging"));
  assert.ok(data["git.branch"].includes("feature/tui"));
});

test("absent block, session, today and weekly data leave their groups empty", (t) => {
  withEnv(t);
  const s = setup();
  const { data } = resolve(emptyData(s.colors), s);
  for (const group of ["block", "session", "today", "weekly"]) {
    assert.equal(data[group], "", group);
    assert.ok(!Object.keys(data).some((key) => key.startsWith(`${group}.`)), `${group} has no parts`);
  }
  assert.ok(data.model.includes("claude"), "an unknown model is shown as Claude");
  assert.ok(Object.hasOwn(data, "context"));
});

test("part colours: an exact part key wins over its segment, the segment over the theme", (t) => {
  withEnv(t);
  const s = setup({ partFg: { "model.icon": "<ICON>", model: "<MODEL>", "git.branch": "<BRANCH>" } });
  const { data } = resolve(fullData(s.colors), s);
  assert.ok(data["model.icon"].startsWith("<ICON>"));
  assert.ok(data["model.value"].startsWith("<MODEL>"));
  assert.ok(data.model.startsWith("<MODEL>"), "the whole value takes the segment colour");
  assert.ok(data["git.branch"].startsWith("<BRANCH>"));
  assert.ok(!data.git.startsWith("<BRANCH>"), "a part colour does not recolour the whole segment");
});

test("templates resolve parts of their base segment, keep literals, drop unknown parts and compose", (t) => {
  withEnv(t);
  const s = setup({
    templates: {
      model: { items: ["[", "{icon}", "{value}", "{nope}", "]"], gap: 2 },
      "git.branch": { items: ["{branch}", "{ahead}"], justify: "between" },
      tmux: { items: [""] },
    },
  });
  const { data, templates } = resolve(fullData(s.colors), s);
  assert.equal(templates.model.items.length, 4, "the unknown part is dropped");
  assert.equal(templates.model.gap, 2);
  assert.equal(templates.model.justify, "start");
  assert.equal(data.model, templates.model.items.join("  "));
  assert.equal(templates["git.branch"].justify, "between");
  assert.equal(templates["git.branch"].gap, 1);
  assert.equal(
    data["git.branch"],
    templates["git.branch"].items.join(" "),
    "between composes as start without a width"
  );
  assert.deepEqual(templates.tmux.items, []);
  assert.equal(data.tmux, "");
});

test("absent, null or empty template settings resolve no templates and leave the values alone", (t) => {
  withEnv(t);
  const plain = setup();
  const reference = resolve(fullData(plain.colors), plain);
  for (const tui of [undefined, { ...plain.config.display.tui, segments: null }, { segments: {} }]) {
    const s = setup();
    s.config.display.tui = tui;
    const resolved = resolve(fullData(s.colors), s);
    assert.deepEqual(resolved.templates, {}, JSON.stringify(tui));
    assert.equal(JSON.stringify(resolved.data), JSON.stringify(reference.data), JSON.stringify(tui));
  }
});

test("without part colours, the whole value and its parts carry the theme colour and bold flag", (t) => {
  withEnv(t);
  const s = setup({ partFg: {} });
  const data = fullData(s.colors);
  const { data: out } = resolve(data, s);
  const bold = (on) => (on ? "\x1b[1m" : "");
  for (const [segment, fg, isBold] of [
    ["model", s.colors.modelFg, s.colors.modelBold],
    ["git", s.colors.gitFg, s.colors.gitBold],
    ["dir", s.colors.modeFg, s.colors.modeBold],
    ["activity", s.colors.metricsFg, s.colors.metricsBold],
    ["block", s.colors.blockFg, s.colors.blockBold],
  ]) {
    assert.ok(out[segment].startsWith(fg + bold(isBold)), `${segment} whole value`);
    const part = Object.keys(out).find((key) => key.startsWith(`${segment}.`) && out[key]);
    assert.ok(out[part].startsWith(fg + bold(isBold)), `${part}`);
  }
  const ctx = Object.keys(out).find((key) => key.startsWith("cacheTimer.") && out[key]);
  assert.equal(
    out.cacheTimer.slice(0, 12),
    out[ctx].slice(0, 12),
    "cache timer whole value and parts share the TTL colour"
  );
  assert.ok(!out.cacheTimer.startsWith(s.colors.cacheTimerFg ?? "\0"), "the TTL colour, not a theme default");
});

test("resolved segments stay byte-identical for every data and symbol set (golden digest)", (t) => {
  withEnv(t);
  const plain = setup();
  const coloured = setup({
    partFg: { "context.pct": "<PCT>", block: "<BLOCK>", cacheTimer: "<CT>" },
    templates: { context: { items: ["{icon}", "{pct}", "{tokens}"], justify: "between", gap: 3 } },
  });
  const out = [];
  for (const s of [plain, coloured])
    for (const sym of [SYMBOLS, TEXT_SYMBOLS])
      for (const make of [fullData, emptyData])
        for (const width of [40, 120]) out.push(JSON.stringify(resolve(make(s.colors), s, sym, width)));
  const digest = createHash("sha256").update(out.join("\n")).digest("hex");
  assert.equal(digest, GOLDEN_SEGMENTS, `resolved segments changed: ${digest}`);
});

// Generated from main before the #1530 split.
const GOLDEN_SEGMENTS = "daeea7e0d047ebf4ee52467ffc6dd484f79b8a89c9ae2d183837e2feeb77a818";
