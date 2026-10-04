/**
 * Follow-up to #847: null rendered as "--", but the providers also returned
 * null for "nothing spent yet", so every fresh session and every morning read
 * "--". A readable but empty source is a measured zero; only a missing or
 * unreadable source is null.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TodayProvider } from "../../packages/statusline/src/segments/today.ts";
import { SessionProvider } from "../../packages/statusline/src/segments/session.ts";
import { CacheManager } from "../../packages/statusline/src/utils/cache.ts";
import { PowerlineRenderer } from "../../packages/statusline/src/powerline.ts";
import { DEFAULT_CONFIG } from "../../packages/statusline/src/config/defaults.ts";
import {
  formatSessionSegment,
  formatSessionParts,
  formatTodaySegment,
  formatTodayParts,
} from "../../packages/statusline/src/tui/sections.ts";

const SESSION = "11111111-2222-3333-4444-555555555555";
const ZERO_BREAKDOWN = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

/** Runs `fn` against a throwaway Claude config dir prepared by `setup`. */
async function withClaudeDir(setup, fn, getCache = async () => null) {
  const claudeDir = mkdtempSync(join(tmpdir(), "statusline-zero-"));
  setup(claudeDir);
  const saved = {
    env: process.env.CLAUDE_CONFIG_DIR,
    get: CacheManager.getUsageCache,
    set: CacheManager.setUsageCache,
    mtime: CacheManager.getLatestTranscriptMtime,
  };
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  CacheManager.getLatestTranscriptMtime = async () => 1;
  CacheManager.getUsageCache = getCache;
  CacheManager.setUsageCache = async () => {};
  try {
    return await fn();
  } finally {
    CacheManager.getUsageCache = saved.get;
    CacheManager.setUsageCache = saved.set;
    CacheManager.getLatestTranscriptMtime = saved.mtime;
    if (saved.env === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved.env;
    rmSync(claudeDir, { recursive: true, force: true });
  }
}

const emptyProjects = (dir) => mkdirSync(join(dir, "projects"));
const noProjects = () => {};
// A regular file where the directory should be: it exists but cannot be listed.
const unreadableProjects = (dir) => writeFileSync(join(dir, "projects"), "");
const projectDir = (dir) => {
  const project = join(dir, "projects", "-tmp-project");
  mkdirSync(project, { recursive: true });
  return project;
};

const today = (setup, getCache) =>
  withClaudeDir(setup, () => new TodayProvider().getTodayInfo(), getCache);
const session = (setup, hookData) =>
  withClaudeDir(setup, () =>
    new SessionProvider().getSessionInfo(SESSION, hookData),
  );

test("a day without entries is a measured zero", async () => {
  const info = await today(emptyProjects);
  assert.equal(info.cost, 0);
  assert.equal(info.tokens, 0);
  assert.deepEqual(info.tokenBreakdown, ZERO_BREAKDOWN);
});

test("today is unknown when the projects directory is missing or unreadable", async () => {
  for (const setup of [noProjects, unreadableProjects]) {
    const info = await today(setup);
    assert.equal(info.cost, null);
    assert.equal(info.tokens, null);
    assert.equal(info.tokenBreakdown, null);
  }
});

test("today is unknown when loading the entries fails", async () => {
  const info = await today(emptyProjects, async () => {
    throw new Error("cache unreadable");
  });
  assert.equal(info.cost, null);
  assert.equal(info.tokens, null);
});

test("a fresh session is a measured zero", async () => {
  const beforeFirstPrompt = await session(emptyProjects);
  assert.equal(beforeFirstPrompt.cost, 0);
  assert.equal(beforeFirstPrompt.tokens, 0);
  assert.deepEqual(beforeFirstPrompt.tokenBreakdown, ZERO_BREAKDOWN);

  const beforeFirstAnswer = await session((dir) =>
    writeFileSync(
      join(projectDir(dir), `${SESSION}.jsonl`),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "user",
        message: { role: "user", content: "hi" },
      })}\n`,
    ),
  );
  assert.equal(beforeFirstAnswer.cost, 0);
  assert.equal(beforeFirstAnswer.tokens, 0);
});

test("a fresh session reports the cost Claude Code hands over", async () => {
  const info = await session(emptyProjects, { cost: { total_cost_usd: 0 } });
  assert.equal(info.cost, 0);
  assert.equal(info.officialCost, 0);
  assert.equal(info.calculatedCost, 0);
});

test("a session is unknown when its source is missing or unreadable", async () => {
  // A directory in place of the transcript: found, but reading it fails.
  const unreadableTranscript = (dir) =>
    mkdirSync(join(projectDir(dir), `${SESSION}.jsonl`));
  for (const setup of [noProjects, unreadableProjects, unreadableTranscript]) {
    const info = await session(setup);
    assert.equal(info.cost, null);
    assert.equal(info.tokens, null);
    assert.equal(info.tokenBreakdown, null);
  }
});

const ZERO = { cost: 0, tokens: 0, tokenBreakdown: ZERO_BREAKDOWN };
const MISSING = { cost: null, tokens: null, tokenBreakdown: null };
const asUsage = (v) => ({
  session: { ...v, calculatedCost: v.cost, officialCost: null },
});

// The default config carries a today budget; without one the text is the bare value.
const config = (budget) => ({ ...structuredClone(DEFAULT_CONFIG), budget });

function classic(values, segment, budget) {
  const renderer = new PowerlineRenderer(config(budget));
  const colors = renderer.theme.getThemeColors();
  const segConfig = { enabled: true, showIcon: false, ...segment };
  return [
    renderer.segments.segmentRenderer.renderSession(asUsage(values), colors, segConfig)
      .text,
    renderer.segments.segmentRenderer.renderToday(values, colors, segConfig).text,
  ];
}

test("the classic renderer prints a zero as a zero and only null as --", () => {
  const cases = [
    [{ type: "cost" }, "$0.00", "--"],
    [{ type: "tokens" }, "0 tokens", "--"],
    [{ type: "tokens", showUnits: false }, "0", "--"],
    [{ type: "both" }, "$0.00 (0 tokens)", "-- (--)"],
    [{ type: "both", showUnits: false }, "$0.00 (0)", "-- (--)"],
    [{ type: "breakdown" }, "0 tokens", "--"],
  ];
  for (const [segment, zero, missing] of cases) {
    assert.deepEqual(classic(ZERO, segment), [zero, zero]);
    assert.deepEqual(classic(MISSING, segment), [missing, missing]);
  }
});

test("the TUI prints a zero as a zero and only null as --", () => {
  const tui = (values) => [
    formatSessionSegment(asUsage(values), {}, config(), false),
    formatSessionParts(asUsage(values), {}, config(), false).cost,
    formatTodaySegment(values, {}, config(), false),
    formatTodayParts(values, {}, config(), false).cost,
  ];
  assert.deepEqual(tui(ZERO), ["$0.00", "$0.00", "$0.00 today", "$0.00"]);
  assert.deepEqual(tui(MISSING), ["--", "--", "-- today", "--"]);
});

test("a measured zero is 0% of the budget, missing data has no percentage", () => {
  const budget = { today: { amount: 50 } };
  const cost = { type: "cost" };
  assert.equal(classic(ZERO, cost, budget)[1], "$0.00 0%");
  assert.equal(classic(MISSING, cost, budget)[1], "--");
  assert.equal(
    formatTodaySegment(ZERO, {}, config(budget), false),
    "$0.00 today 0%",
  );
  assert.equal(
    formatTodaySegment(MISSING, {}, config(budget), false),
    "-- today",
  );
});
