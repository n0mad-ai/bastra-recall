/**
 * #1039 — pins the exact output of every SegmentRenderer method for a fixed set
 * of inputs. The expected values were generated from main before renderer.ts
 * was split into modules; any byte that changes here is a behaviour change.
 *
 * Colours and symbols are proxies that echo their key, so the pin records
 * which colour and which symbol each branch picks, independent of themes.
 * Every input avoids the clock (no running recall, no fresh phrase, resets_at
 * in the past) and the locale (token totals below 1000).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SegmentRenderer } from "../../packages/statusline/src/segments/renderer.ts";
import { DEFAULT_CONFIG } from "../../packages/statusline/src/config/defaults.ts";

const echo = (tag) =>
  new Proxy({}, { get: (_t, key) => (typeof key === "string" ? `${tag}:${key}` : undefined) });
const colors = echo("c");
const symbols = echo("s");

const HOME = "/home/golden";
const BREAKDOWN = { input: 120, output: 340, cacheCreation: 56, cacheRead: 780 };
const USAGE = {
  session: {
    cost: 1.234,
    calculatedCost: 1.5,
    officialCost: null,
    tokens: 4321,
    tokenBreakdown: BREAKDOWN,
  },
};
const CONTEXT = {
  totalTokens: 900,
  percentage: 90,
  usablePercentage: 90,
  contextLeftPercentage: 10,
  maxTokens: 1000,
  usableTokens: 1000,
};
const CONTEXT_MID = { ...CONTEXT, totalTokens: 650, usablePercentage: 65, contextLeftPercentage: 35 };
const CONTEXT_LOW = { ...CONTEXT, totalTokens: 200, usablePercentage: 20, contextLeftPercentage: 80 };
const GIT = {
  branch: "main",
  status: "dirty",
  ahead: 2,
  behind: 1,
  sha: "abc1234",
  tag: "v1.0.0",
  timeSinceCommit: 3700,
  stashCount: 3,
  upstream: "origin/main",
  repoName: "bastra-recall",
  isWorktree: true,
  operation: "REBASE",
  staged: 1,
  unstaged: 2,
  untracked: 3,
  conflicts: 4,
};
const ALL_GIT = {
  enabled: true,
  showSha: true,
  showAheadBehind: true,
  showWorkingTree: true,
  showOperation: true,
  showTag: true,
  showTimeSinceCommit: true,
  showStashCount: true,
  showUpstream: true,
  showRepoName: true,
};
const METRICS = {
  responseTime: 12.34,
  lastResponseTime: 75,
  sessionDuration: 3725,
  messageCount: 9,
  linesAdded: 10,
  linesRemoved: 4,
};
const BASTRA = {
  state: "running",
  vaultSize: 812,
  recallCount: 1,
  totalHits: 1,
  totalMs: 0,
  currentStage: null,
  currentMessage: null,
  currentStageStartedAt: null,
  currentRecallStartedAt: null,
  lastPhrase: null,
  lastPhraseAt: null,
};
const BAR_STYLES = ["text", "ball", "bar", "blocks", "blocks-line", "capped", "dots", "filled", "geometric", "line", "squares"];

function makeRenderer(patch = {}) {
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config, patch);
  return new SegmentRenderer(config, symbols);
}

/** [label, renderer config patch, call] — the call receives the renderer. */
function cases() {
  const out = [];
  const add = (label, fn, patch) => out.push([label, patch, fn]);

  add("directory full", (r) => r.renderDirectory({ cwd: "/srv/app/sub" }, colors));
  add("directory home", (r) => r.renderDirectory({ cwd: `${HOME}/code/x` }, colors));
  add("directory project-relative", (r) =>
    r.renderDirectory({ workspace: { current_dir: "/srv/app/pkg/src", project_dir: "/srv/app/" } }, colors));
  add("directory project root", (r) =>
    r.renderDirectory({ workspace: { current_dir: "/srv/app", project_dir: "/srv/app" } }, colors));
  add("directory worktree", (r) =>
    r.renderDirectory({ cwd: "/tmp/wt", worktree: { original_cwd: "/srv/orig/a" } }, colors));
  add("directory basename", (r) => r.renderDirectory({ cwd: "/srv/app/sub" }, colors, { enabled: true, showBasename: true }));
  add("directory basename root", (r) => r.renderDirectory({ cwd: "/" }, colors, { enabled: true, style: "basename" }));
  add("directory fish", (r) => r.renderDirectory({ cwd: "/srv/application/subdir/leaf" }, colors, { enabled: true, style: "fish" }));
  add("directory empty", (r) => r.renderDirectory({}, colors));

  add("git null", (r) => r.renderGit(null, colors));
  add("git default", (r) => r.renderGit(GIT, colors));
  add("git all", (r) => r.renderGit(GIT, colors, ALL_GIT));
  add("git no icon", (r) => r.renderGit(GIT, colors, { ...ALL_GIT, showIcon: false }));
  add("git clean ahead", (r) => r.renderGit({ ...GIT, status: "clean", behind: 0 }, colors));
  add("git conflicts behind", (r) => r.renderGit({ ...GIT, status: "conflicts", ahead: 0 }, colors));
  add("git unknown", (r) => r.renderGit({ ...GIT, status: "unknown", ahead: 0, behind: 0 }, colors, { enabled: true, showAheadBehind: false, showWorkingTree: true }));
  add("git empty tree", (r) => r.renderGit({ ...GIT, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }, colors, { enabled: true, showWorkingTree: true }));

  add("model", (r) => r.renderModel({ model: { display_name: "Claude Opus 4.1" } }, colors));
  add("model default", (r) => r.renderModel({}, colors, { enabled: true, showIcon: false }));
  add("model icons off", (r) => r.renderModel({ model: { display_name: "Sonnet" } }, colors), { display: { showIcons: false } });

  for (const type of ["cost", "tokens", "both", "breakdown", "weird"]) {
    add(`session ${type}`, (r) => r.renderSession(USAGE, colors, { enabled: true, type }));
    add(`today ${type}`, (r) => r.renderToday({ cost: 12.5, tokens: 98765, tokenBreakdown: BREAKDOWN, date: "2026-10-04" }, colors, { enabled: true, type }));
  }
  add("session default", (r) => r.renderSession(USAGE, colors));
  add("session calculated", (r) => r.renderSession(USAGE, colors, { enabled: true, type: "cost", costSource: "calculated" }));
  add("session official", (r) => r.renderSession(USAGE, colors, { enabled: true, type: "cost", costSource: "official" }));
  add("session tokens no units", (r) => r.renderSession(USAGE, colors, { enabled: true, type: "both", showUnits: false }));
  add("session null", (r) => r.renderSession({ session: { cost: null, calculatedCost: null, officialCost: null, tokens: null, tokenBreakdown: null } }, colors, { enabled: true, type: "both" }));
  add("session budget", (r) => r.renderSession(USAGE, colors, { enabled: true, type: "cost" }), { budget: { session: { amount: 2, warningThreshold: 50 } } });
  add("session budget percent only", (r) => r.renderSession(USAGE, colors, { enabled: true, type: "cost" }), { budget: { session: { amount: 2, showValue: false } } });
  add("session budget hidden", (r) => r.renderSession(USAGE, colors, { enabled: true, type: "cost" }), { budget: { session: { amount: 2, showValue: false, showPercentage: false } } });
  add("today string type", (r) => r.renderToday({ cost: 3, tokens: 1500, tokenBreakdown: null, date: "2026-10-04" }, colors, "tokens"));
  add("today default", (r) => r.renderToday({ cost: 0, tokens: 0, tokenBreakdown: null, date: "2026-10-04" }, colors));

  add("session id", (r) => r.renderSessionId("abc-123", colors));
  add("session id no label", (r) => r.renderSessionId("abc-123", colors, { enabled: true, showIdLabel: false }));
  add("tmux none", (r) => r.renderTmux(null, colors));
  add("tmux", (r) => r.renderTmux("main", colors));

  for (const displayStyle of BAR_STYLES) {
    for (const percentageMode of ["remaining", "used"]) {
      const cfg = { enabled: true, displayStyle, percentageMode };
      add(`context ${displayStyle} ${percentageMode} null`, (r) => r.renderContext(null, colors, cfg));
      add(`context ${displayStyle} ${percentageMode} critical`, (r) => r.renderContext(CONTEXT, colors, cfg));
      add(`context ${displayStyle} ${percentageMode} warning`, (r) => r.renderContext(CONTEXT_MID, colors, cfg));
      add(`context ${displayStyle} ${percentageMode} low`, (r) => r.renderContext(CONTEXT_LOW, colors, { ...cfg, showPercentageOnly: true }));
    }
  }
  add("context default", (r) => r.renderContext(CONTEXT_LOW, colors));
  add("context capped full", (r) => r.renderContext({ ...CONTEXT, usablePercentage: 100, contextLeftPercentage: 0 }, colors, { enabled: true, displayStyle: "capped", percentageMode: "used" }));
  add("context ball full", (r) => r.renderContext({ ...CONTEXT, usablePercentage: 100, contextLeftPercentage: 0 }, colors, { enabled: true, displayStyle: "ball", percentageMode: "used" }));

  add("metrics null", (r) => r.renderMetrics(null, colors));
  add("metrics default", (r) => r.renderMetrics(METRICS, colors));
  add("metrics all", (r) => r.renderMetrics({ ...METRICS, responseTime: 90, lastResponseTime: 3.21 }, colors, { enabled: true, showLastResponseTime: true }));
  add("metrics none shown", (r) => r.renderMetrics(METRICS, colors, { enabled: true, showResponseTime: false, showDuration: false, showMessageCount: false, showLinesAdded: false, showLinesRemoved: false }));
  add("metrics zero lines", (r) => r.renderMetrics({ ...METRICS, linesAdded: 0, linesRemoved: 0, responseTime: null, sessionDuration: null, messageCount: null }, colors));

  for (const displayStyle of BAR_STYLES) {
    for (const pct of [0, 49.6, 55, 85]) {
      add(`block ${displayStyle} ${pct}`, (r) => r.renderBlock({ nativeUtilization: pct, timeRemaining: 135 }, colors, { enabled: true, type: "weighted", displayStyle }));
      add(`weekly ${displayStyle} ${pct}`, (r) => r.renderWeekly({ rate_limits: { seven_day: { used_percentage: pct, resets_at: 0 } } }, colors, { enabled: true, displayStyle }));
    }
  }
  add("block threshold 90", (r) => r.renderBlock({ nativeUtilization: 85, timeRemaining: 0 }, colors), { budget: { block: { warningThreshold: 90 } } });
  add("weekly missing", (r) => r.renderWeekly({}, colors));

  add("version", (r) => r.renderVersion({ version: "2.1.0" }, colors));
  add("version missing", (r) => r.renderVersion({}, colors));
  add("env", (r) => r.renderEnv(colors, { enabled: true, variable: "SEGRENDERER_GOLDEN" }));
  add("env prefix", (r) => r.renderEnv(colors, { enabled: true, variable: "SEGRENDERER_GOLDEN", prefix: "P" }));
  add("env empty prefix", (r) => r.renderEnv(colors, { enabled: true, variable: "SEGRENDERER_GOLDEN", prefix: "" }));
  add("env unset", (r) => r.renderEnv(colors, { enabled: true, variable: "SEGRENDERER_GOLDEN_UNSET" }));

  add("agent", (r) => r.renderAgent({ agent: { name: "  reviewer " } }, colors));
  add("agent label", (r) => r.renderAgent({ agent: { name: "reviewer" } }, colors, { enabled: true, showLabel: true }));
  add("agent blank", (r) => r.renderAgent({ agent: { name: "  " } }, colors));
  add("agent missing", (r) => r.renderAgent({}, colors));

  add("thinking both", (r) => r.renderThinking({ thinking: { enabled: true }, effort: { level: "high" } }, colors));
  add("thinking off", (r) => r.renderThinking({ thinking: { enabled: false } }, colors, { enabled: true, showEffort: false }));
  add("thinking none", (r) => r.renderThinking({}, colors));
  add("thinking disabled", (r) => r.renderThinking({ thinking: { enabled: true } }, colors, { enabled: true, showEnabled: false, showEffort: false }));

  for (const e of [0, 59, 190, 300, 4000]) {
    add(`cache elapsed ${e}`, (r) => r.renderCacheTimer({ elapsedSeconds: e }, colors));
    add(`cache elapsed ttl ${e}`, (r) => r.renderCacheTimer({ elapsedSeconds: e, detectedTtlSeconds: 3600 }, colors, { enabled: true, ttlSeconds: 200 }));
    add(`cache remaining ${e}`, (r) => r.renderCacheTimer({ elapsedSeconds: e, detectedTtlSeconds: 300 }, colors, { enabled: true, displayMode: "remaining" }));
    add(`cache remaining default ${e}`, (r) => r.renderCacheTimer({ elapsedSeconds: e * 10 }, colors, { enabled: true, displayMode: "remaining" }));
  }

  add("bastra null", (r) => r.renderBastra(null, colors));
  add("bastra idle", (r) => r.renderBastra({ ...BASTRA, state: "idle", recallCount: 4 }, colors));
  add("bastra zero calls", (r) => r.renderBastra({ ...BASTRA, recallCount: 0 }, colors));
  add("bastra active", (r) => r.renderBastra({ ...BASTRA, recallCount: 2, totalHits: 1, totalMs: 340, currentStage: "rerank", currentStageStartedAt: 1 }, colors));
  add("bastra active message", (r) => r.renderBastra({ ...BASTRA, recallCount: 1, totalHits: 5, totalMs: 12, currentStage: "rerank", currentMessage: "sorting", currentStageStartedAt: 1 }, colors));
  add("bastra done", (r) => r.renderBastra({ ...BASTRA, recallCount: 1, totalHits: 1, totalMs: 120 }, colors));
  add("bastra done no hits", (r) => r.renderBastra({ ...BASTRA, recallCount: 3, totalHits: 0, totalMs: 0 }, colors));
  add("bastra done stale phrase", (r) => r.renderBastra({ ...BASTRA, recallCount: 2, totalHits: 7, totalMs: 99, lastPhrase: "found it", lastPhraseAt: 1 }, colors));
  add("bastra icons off", (r) => r.renderBastra({ ...BASTRA, state: "idle" }, colors, { enabled: true, showIcon: false }));
  return out;
}

function renderAll() {
  const saved = { HOME: process.env.HOME, SEGRENDERER_GOLDEN: process.env.SEGRENDERER_GOLDEN };
  process.env.HOME = HOME;
  process.env.SEGRENDERER_GOLDEN = "on";
  delete process.env.SEGRENDERER_GOLDEN_UNSET;
  try {
    return cases().map(([label, patch, fn]) => [label, fn(makeRenderer(patch)) ?? null]);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Keeps a present-but-undefined key (`bold: undefined`) distinct from a missing one. */
const pin = (value) =>
  JSON.parse(JSON.stringify(value, (_k, v) => (v === undefined ? "<undefined>" : v)));

const EXPECTED = [
  ["directory full", {"text": "/srv/app/sub", "bgColor": "c:modeBg", "fgColor": "c:modeFg"}],
  ["directory home", {"text": "~/code/x", "bgColor": "c:modeBg", "fgColor": "c:modeFg"}],
  ["directory project-relative", {"text": "pkg/src", "bgColor": "c:modeBg", "fgColor": "c:modeFg"}],
  ["directory project root", {"text": "/srv/app", "bgColor": "c:modeBg", "fgColor": "c:modeFg"}],
  ["directory worktree", {"text": "/srv/orig/a", "bgColor": "c:modeBg", "fgColor": "c:modeFg"}],
  ["directory basename", {"text": "sub", "bgColor": "c:modeBg", "fgColor": "c:modeFg"}],
  ["directory basename root", {"text": "root", "bgColor": "c:modeBg", "fgColor": "c:modeFg"}],
  ["directory fish", {"text": "/s/a/s/leaf", "bgColor": "c:modeBg", "fgColor": "c:modeFg"}],
  ["directory empty", {"text": "/", "bgColor": "c:modeBg", "fgColor": "c:modeFg"}],
  ["git null", null],
  ["git default", {"text": "s:branch main s:git_ahead2s:git_behind1 s:git_dirty", "bgColor": "c:gitBg", "fgColor": "c:gitFg"}],
  ["git all", {"text": "bastra-recall s:git_worktree [REBASE] s:branch main s:git_tag v1.0.0 s:git_sha abc1234 s:git_ahead2s:git_behind1 (+1 ~2 ?3 !4) s:git_upstreamorigin/main s:git_stash 3 s:git_time 1h s:git_dirty", "bgColor": "c:gitBg", "fgColor": "c:gitFg"}],
  ["git no icon", {"text": "bastra-recall s:git_worktree [REBASE] main s:git_tag v1.0.0 s:git_sha abc1234 s:git_ahead2s:git_behind1 (+1 ~2 ?3 !4) s:git_upstreamorigin/main s:git_stash 3 s:git_time 1h s:git_dirty", "bgColor": "c:gitBg", "fgColor": "c:gitFg"}],
  ["git clean ahead", {"text": "s:branch main s:git_ahead2 s:git_clean", "bgColor": "c:gitBg", "fgColor": "c:gitFg"}],
  ["git conflicts behind", {"text": "s:branch main s:git_behind1 s:git_conflicts", "bgColor": "c:gitBg", "fgColor": "c:gitFg"}],
  ["git unknown", {"text": "s:branch main (+1 ~2 ?3 !4) ?", "bgColor": "c:gitBg", "fgColor": "c:gitFg"}],
  ["git empty tree", {"text": "s:branch main s:git_ahead2s:git_behind1 s:git_dirty", "bgColor": "c:gitBg", "fgColor": "c:gitFg"}],
  ["model", {"text": "s:model Claude Opus 4.1", "bgColor": "c:modelBg", "fgColor": "c:modelFg"}],
  ["model default", {"text": "Claude", "bgColor": "c:modelBg", "fgColor": "c:modelFg"}],
  ["model icons off", {"text": "Sonnet", "bgColor": "c:modelBg", "fgColor": "c:modelFg"}],
  ["session cost", {"text": "s:session_cost $1.23", "bgColor": "c:sessionBg", "fgColor": "c:sessionFg"}],
  ["today cost", {"text": "s:today_cost $12.50 25%", "bgColor": "c:todayBg", "fgColor": "c:todayFg"}],
  ["session tokens", {"text": "s:session_cost 4.3K tokens", "bgColor": "c:sessionBg", "fgColor": "c:sessionFg"}],
  ["today tokens", {"text": "s:today_cost 98.8K tokens 25%", "bgColor": "c:todayBg", "fgColor": "c:todayFg"}],
  ["session both", {"text": "s:session_cost $1.23 (4.3K tokens)", "bgColor": "c:sessionBg", "fgColor": "c:sessionFg"}],
  ["today both", {"text": "s:today_cost $12.50 (98.8K tokens) 25%", "bgColor": "c:todayBg", "fgColor": "c:todayFg"}],
  ["session breakdown", {"text": "s:session_cost 120 in + 340 out + 836 cached", "bgColor": "c:sessionBg", "fgColor": "c:sessionFg"}],
  ["today breakdown", {"text": "s:today_cost 120 in + 340 out + 836 cached 25%", "bgColor": "c:todayBg", "fgColor": "c:todayFg"}],
  ["session weird", {"text": "s:session_cost $1.23", "bgColor": "c:sessionBg", "fgColor": "c:sessionFg"}],
  ["today weird", {"text": "s:today_cost $12.50 25%", "bgColor": "c:todayBg", "fgColor": "c:todayFg"}],
  ["session default", {"text": "s:session_cost $1.23", "bgColor": "c:sessionBg", "fgColor": "c:sessionFg"}],
  ["session calculated", {"text": "s:session_cost $1.50", "bgColor": "c:sessionBg", "fgColor": "c:sessionFg"}],
  ["session official", {"text": "s:session_cost $1.50", "bgColor": "c:sessionBg", "fgColor": "c:sessionFg"}],
  ["session tokens no units", {"text": "s:session_cost $1.23 (4.3K)", "bgColor": "c:sessionBg", "fgColor": "c:sessionFg"}],
  ["session null", {"text": "s:session_cost -- (--)", "bgColor": "c:sessionBg", "fgColor": "c:sessionFg"}],
  ["session budget", {"text": "s:session_cost $1.23 !62%", "bgColor": "c:sessionBg", "fgColor": "c:sessionFg"}],
  ["session budget percent only", {"text": "s:session_cost +62%", "bgColor": "c:sessionBg", "fgColor": "c:sessionFg"}],
  ["session budget hidden", null],
  ["today string type", {"text": "s:today_cost 1.5K tokens 6%", "bgColor": "c:todayBg", "fgColor": "c:todayFg"}],
  ["today default", {"text": "s:today_cost $0.00 0%", "bgColor": "c:todayBg", "fgColor": "c:todayFg"}],
  ["session id", {"text": "s:session_id abc-123", "bgColor": "c:sessionBg", "fgColor": "c:sessionFg"}],
  ["session id no label", {"text": "abc-123", "bgColor": "c:sessionBg", "fgColor": "c:sessionFg"}],
  ["tmux none", {"text": "tmux:none", "bgColor": "c:tmuxBg", "fgColor": "c:tmuxFg"}],
  ["tmux", {"text": "tmux:main", "bgColor": "c:tmuxBg", "fgColor": "c:tmuxFg"}],
  ["context text remaining null", {"text": "s:context_time 0 (100%)", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context text remaining critical", {"text": "s:context_time 900 (10%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context text remaining warning", {"text": "s:context_time 650 (35%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context text remaining low", {"text": "s:context_time 80%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context text used null", {"text": "s:context_time 0 (0%)", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context text used critical", {"text": "s:context_time 900 (90%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context text used warning", {"text": "s:context_time 650 (65%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context text used low", {"text": "s:context_time 20%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context ball remaining null", {"text": "─────────● 100%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context ball remaining critical", {"text": "─●──────── 900 (10%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context ball remaining warning", {"text": "────●───── 650 (35%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context ball remaining low", {"text": "────────●─ 80%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context ball used null", {"text": "────────── 0%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context ball used critical", {"text": "─────────● 900 (90%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context ball used warning", {"text": "───────●── 650 (65%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context ball used low", {"text": "──●─────── 20%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context bar remaining null", {"text": "s:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filled 100%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context bar remaining critical", {"text": "s:bar_filleds:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_empty 900 (10%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context bar remaining warning", {"text": "s:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_empty 650 (35%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context bar remaining low", {"text": "s:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_emptys:bar_empty 80%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context bar used null", {"text": "s:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_empty 0%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context bar used critical", {"text": "s:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_empty 900 (90%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context bar used warning", {"text": "s:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_emptys:bar_emptys:bar_empty 650 (65%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context bar used low", {"text": "s:bar_filleds:bar_filleds:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_empty 20%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context blocks remaining null", {"text": "██████████ 100%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context blocks remaining critical", {"text": "█░░░░░░░░░ 900 (10%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context blocks remaining warning", {"text": "████░░░░░░ 650 (35%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context blocks remaining low", {"text": "████████░░ 80%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context blocks used null", {"text": "░░░░░░░░░░ 0%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context blocks used critical", {"text": "█████████░ 900 (90%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context blocks used warning", {"text": "███████░░░ 650 (65%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context blocks used low", {"text": "██░░░░░░░░ 20%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context blocks-line remaining null", {"text": "██████████ 100%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context blocks-line remaining critical", {"text": "█───────── 900 (10%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context blocks-line remaining warning", {"text": "████────── 650 (35%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context blocks-line remaining low", {"text": "████████── 80%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context blocks-line used null", {"text": "────────── 0%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context blocks-line used critical", {"text": "█████████─ 900 (90%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context blocks-line used warning", {"text": "███████─── 650 (65%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context blocks-line used low", {"text": "██──────── 20%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context capped remaining null", {"text": "━━━━━━━━━━ 100%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context capped remaining critical", {"text": "╸┄┄┄┄┄┄┄┄┄ 900 (10%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context capped remaining warning", {"text": "━━━╸┄┄┄┄┄┄ 650 (35%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context capped remaining low", {"text": "━━━━━━━╸┄┄ 80%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context capped used null", {"text": "┄┄┄┄┄┄┄┄┄┄ 0%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context capped used critical", {"text": "━━━━━━━━╸┄ 900 (90%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context capped used warning", {"text": "━━━━━━╸┄┄┄ 650 (65%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context capped used low", {"text": "━╸┄┄┄┄┄┄┄┄ 20%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context dots remaining null", {"text": "●●●●●●●●●● 100%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context dots remaining critical", {"text": "●○○○○○○○○○ 900 (10%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context dots remaining warning", {"text": "●●●●○○○○○○ 650 (35%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context dots remaining low", {"text": "●●●●●●●●○○ 80%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context dots used null", {"text": "○○○○○○○○○○ 0%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context dots used critical", {"text": "●●●●●●●●●○ 900 (90%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context dots used warning", {"text": "●●●●●●●○○○ 650 (65%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context dots used low", {"text": "●●○○○○○○○○ 20%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context filled remaining null", {"text": "■■■■■■■■■■ 100%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context filled remaining critical", {"text": "■□□□□□□□□□ 900 (10%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context filled remaining warning", {"text": "■■■■□□□□□□ 650 (35%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context filled remaining low", {"text": "■■■■■■■■□□ 80%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context filled used null", {"text": "□□□□□□□□□□ 0%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context filled used critical", {"text": "■■■■■■■■■□ 900 (90%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context filled used warning", {"text": "■■■■■■■□□□ 650 (65%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context filled used low", {"text": "■■□□□□□□□□ 20%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context geometric remaining null", {"text": "▰▰▰▰▰▰▰▰▰▰ 100%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context geometric remaining critical", {"text": "▰▱▱▱▱▱▱▱▱▱ 900 (10%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context geometric remaining warning", {"text": "▰▰▰▰▱▱▱▱▱▱ 650 (35%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context geometric remaining low", {"text": "▰▰▰▰▰▰▰▰▱▱ 80%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context geometric used null", {"text": "▱▱▱▱▱▱▱▱▱▱ 0%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context geometric used critical", {"text": "▰▰▰▰▰▰▰▰▰▱ 900 (90%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context geometric used warning", {"text": "▰▰▰▰▰▰▰▱▱▱ 650 (65%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context geometric used low", {"text": "▰▰▱▱▱▱▱▱▱▱ 20%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context line remaining null", {"text": "━━━━━━━━━━ 100%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context line remaining critical", {"text": "━┄┄┄┄┄┄┄┄┄ 900 (10%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context line remaining warning", {"text": "━━━━┄┄┄┄┄┄ 650 (35%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context line remaining low", {"text": "━━━━━━━━┄┄ 80%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context line used null", {"text": "┄┄┄┄┄┄┄┄┄┄ 0%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context line used critical", {"text": "━━━━━━━━━┄ 900 (90%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context line used warning", {"text": "━━━━━━━┄┄┄ 650 (65%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context line used low", {"text": "━━┄┄┄┄┄┄┄┄ 20%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context squares remaining null", {"text": "◼◼◼◼◼◼◼◼◼◼ 100%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context squares remaining critical", {"text": "◼◻◻◻◻◻◻◻◻◻ 900 (10%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context squares remaining warning", {"text": "◼◼◼◼◻◻◻◻◻◻ 650 (35%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context squares remaining low", {"text": "◼◼◼◼◼◼◼◼◻◻ 80%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context squares used null", {"text": "◻◻◻◻◻◻◻◻◻◻ 0%", "bgColor": "c:contextBg", "fgColor": "c:contextFg"}],
  ["context squares used critical", {"text": "◼◼◼◼◼◼◼◼◼◻ 900 (90%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context squares used warning", {"text": "◼◼◼◼◼◼◼◻◻◻ 650 (65%)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["context squares used low", {"text": "◼◼◻◻◻◻◻◻◻◻ 20%", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context default", {"text": "s:context_time 200 (80%)", "bgColor": "c:contextBg", "fgColor": "c:contextFg", "bold": "c:contextBold"}],
  ["context capped full", {"text": "━━━━━━━━━━ 900 (100%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["context ball full", {"text": "─────────● 900 (100%)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["metrics null", {"text": "s:metrics_response new", "bgColor": "c:metricsBg", "fgColor": "c:metricsFg"}],
  ["metrics default", {"text": "s:metrics_response 12.3s s:metrics_duration 1.0h s:metrics_messages 9 s:metrics_lines_added 10 s:metrics_lines_removed 4", "bgColor": "c:metricsBg", "fgColor": "c:metricsFg"}],
  ["metrics all", {"text": "s:metrics_last_response 3.2s s:metrics_response 1.5m s:metrics_duration 1.0h s:metrics_messages 9 s:metrics_lines_added 10 s:metrics_lines_removed 4", "bgColor": "c:metricsBg", "fgColor": "c:metricsFg"}],
  ["metrics none shown", {"text": "s:metrics_response active", "bgColor": "c:metricsBg", "fgColor": "c:metricsFg"}],
  ["metrics zero lines", {"text": "s:metrics_response active", "bgColor": "c:metricsBg", "fgColor": "c:metricsFg"}],
  ["block text 0", {"text": "s:block_cost 0% (2h 15m)", "bgColor": "c:blockBg", "fgColor": "c:blockFg", "bold": "c:blockBold"}],
  ["weekly text 0", {"text": "s:weekly_cost 0% (0m)", "bgColor": "c:weeklyBg", "fgColor": "c:weeklyFg", "bold": "c:weeklyBold"}],
  ["block text 49.6", {"text": "s:block_cost 50% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly text 49.6", {"text": "s:weekly_cost 50% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block text 55", {"text": "s:block_cost 55% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly text 55", {"text": "s:weekly_cost 55% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block text 85", {"text": "s:block_cost 85% (2h 15m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["weekly text 85", {"text": "s:weekly_cost 85% (0m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["block ball 0", {"text": "s:block_cost ●───────── 0% (2h 15m)", "bgColor": "c:blockBg", "fgColor": "c:blockFg", "bold": "c:blockBold"}],
  ["weekly ball 0", {"text": "s:weekly_cost ●───────── 0% (0m)", "bgColor": "c:weeklyBg", "fgColor": "c:weeklyFg", "bold": "c:weeklyBold"}],
  ["block ball 49.6", {"text": "s:block_cost ─────●──── 50% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly ball 49.6", {"text": "s:weekly_cost ─────●──── 50% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block ball 55", {"text": "s:block_cost ──────●─── 55% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly ball 55", {"text": "s:weekly_cost ──────●─── 55% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block ball 85", {"text": "s:block_cost ─────────● 85% (2h 15m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["weekly ball 85", {"text": "s:weekly_cost ─────────● 85% (0m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["block bar 0", {"text": "s:block_cost s:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_empty 0% (2h 15m)", "bgColor": "c:blockBg", "fgColor": "c:blockFg", "bold": "c:blockBold"}],
  ["weekly bar 0", {"text": "s:weekly_cost s:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_empty 0% (0m)", "bgColor": "c:weeklyBg", "fgColor": "c:weeklyFg", "bold": "c:weeklyBold"}],
  ["block bar 49.6", {"text": "s:block_cost s:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_empty 50% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly bar 49.6", {"text": "s:weekly_cost s:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_emptys:bar_emptys:bar_emptys:bar_emptys:bar_empty 50% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block bar 55", {"text": "s:block_cost s:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_emptys:bar_emptys:bar_emptys:bar_empty 55% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly bar 55", {"text": "s:weekly_cost s:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_emptys:bar_emptys:bar_emptys:bar_empty 55% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block bar 85", {"text": "s:block_cost s:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_empty 85% (2h 15m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["weekly bar 85", {"text": "s:weekly_cost s:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_filleds:bar_empty 85% (0m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["block blocks 0", {"text": "s:block_cost ░░░░░░░░░░ 0% (2h 15m)", "bgColor": "c:blockBg", "fgColor": "c:blockFg", "bold": "c:blockBold"}],
  ["weekly blocks 0", {"text": "s:weekly_cost ░░░░░░░░░░ 0% (0m)", "bgColor": "c:weeklyBg", "fgColor": "c:weeklyFg", "bold": "c:weeklyBold"}],
  ["block blocks 49.6", {"text": "s:block_cost █████░░░░░ 50% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly blocks 49.6", {"text": "s:weekly_cost █████░░░░░ 50% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block blocks 55", {"text": "s:block_cost ██████░░░░ 55% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly blocks 55", {"text": "s:weekly_cost ██████░░░░ 55% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block blocks 85", {"text": "s:block_cost █████████░ 85% (2h 15m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["weekly blocks 85", {"text": "s:weekly_cost █████████░ 85% (0m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["block blocks-line 0", {"text": "s:block_cost ────────── 0% (2h 15m)", "bgColor": "c:blockBg", "fgColor": "c:blockFg", "bold": "c:blockBold"}],
  ["weekly blocks-line 0", {"text": "s:weekly_cost ────────── 0% (0m)", "bgColor": "c:weeklyBg", "fgColor": "c:weeklyFg", "bold": "c:weeklyBold"}],
  ["block blocks-line 49.6", {"text": "s:block_cost █████───── 50% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly blocks-line 49.6", {"text": "s:weekly_cost █████───── 50% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block blocks-line 55", {"text": "s:block_cost ██████──── 55% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly blocks-line 55", {"text": "s:weekly_cost ██████──── 55% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block blocks-line 85", {"text": "s:block_cost █████████─ 85% (2h 15m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["weekly blocks-line 85", {"text": "s:weekly_cost █████████─ 85% (0m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["block capped 0", {"text": "s:block_cost ╸┄┄┄┄┄┄┄┄┄ 0% (2h 15m)", "bgColor": "c:blockBg", "fgColor": "c:blockFg", "bold": "c:blockBold"}],
  ["weekly capped 0", {"text": "s:weekly_cost ╸┄┄┄┄┄┄┄┄┄ 0% (0m)", "bgColor": "c:weeklyBg", "fgColor": "c:weeklyFg", "bold": "c:weeklyBold"}],
  ["block capped 49.6", {"text": "s:block_cost ━━━━╸┄┄┄┄┄ 50% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly capped 49.6", {"text": "s:weekly_cost ━━━━╸┄┄┄┄┄ 50% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block capped 55", {"text": "s:block_cost ━━━━━╸┄┄┄┄ 55% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly capped 55", {"text": "s:weekly_cost ━━━━━╸┄┄┄┄ 55% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block capped 85", {"text": "s:block_cost ━━━━━━━━╸┄ 85% (2h 15m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["weekly capped 85", {"text": "s:weekly_cost ━━━━━━━━╸┄ 85% (0m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["block dots 0", {"text": "s:block_cost ○○○○○○○○○○ 0% (2h 15m)", "bgColor": "c:blockBg", "fgColor": "c:blockFg", "bold": "c:blockBold"}],
  ["weekly dots 0", {"text": "s:weekly_cost ○○○○○○○○○○ 0% (0m)", "bgColor": "c:weeklyBg", "fgColor": "c:weeklyFg", "bold": "c:weeklyBold"}],
  ["block dots 49.6", {"text": "s:block_cost ●●●●●○○○○○ 50% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly dots 49.6", {"text": "s:weekly_cost ●●●●●○○○○○ 50% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block dots 55", {"text": "s:block_cost ●●●●●●○○○○ 55% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly dots 55", {"text": "s:weekly_cost ●●●●●●○○○○ 55% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block dots 85", {"text": "s:block_cost ●●●●●●●●●○ 85% (2h 15m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["weekly dots 85", {"text": "s:weekly_cost ●●●●●●●●●○ 85% (0m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["block filled 0", {"text": "s:block_cost □□□□□□□□□□ 0% (2h 15m)", "bgColor": "c:blockBg", "fgColor": "c:blockFg", "bold": "c:blockBold"}],
  ["weekly filled 0", {"text": "s:weekly_cost □□□□□□□□□□ 0% (0m)", "bgColor": "c:weeklyBg", "fgColor": "c:weeklyFg", "bold": "c:weeklyBold"}],
  ["block filled 49.6", {"text": "s:block_cost ■■■■■□□□□□ 50% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly filled 49.6", {"text": "s:weekly_cost ■■■■■□□□□□ 50% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block filled 55", {"text": "s:block_cost ■■■■■■□□□□ 55% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly filled 55", {"text": "s:weekly_cost ■■■■■■□□□□ 55% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block filled 85", {"text": "s:block_cost ■■■■■■■■■□ 85% (2h 15m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["weekly filled 85", {"text": "s:weekly_cost ■■■■■■■■■□ 85% (0m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["block geometric 0", {"text": "s:block_cost ▱▱▱▱▱▱▱▱▱▱ 0% (2h 15m)", "bgColor": "c:blockBg", "fgColor": "c:blockFg", "bold": "c:blockBold"}],
  ["weekly geometric 0", {"text": "s:weekly_cost ▱▱▱▱▱▱▱▱▱▱ 0% (0m)", "bgColor": "c:weeklyBg", "fgColor": "c:weeklyFg", "bold": "c:weeklyBold"}],
  ["block geometric 49.6", {"text": "s:block_cost ▰▰▰▰▰▱▱▱▱▱ 50% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly geometric 49.6", {"text": "s:weekly_cost ▰▰▰▰▰▱▱▱▱▱ 50% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block geometric 55", {"text": "s:block_cost ▰▰▰▰▰▰▱▱▱▱ 55% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly geometric 55", {"text": "s:weekly_cost ▰▰▰▰▰▰▱▱▱▱ 55% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block geometric 85", {"text": "s:block_cost ▰▰▰▰▰▰▰▰▰▱ 85% (2h 15m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["weekly geometric 85", {"text": "s:weekly_cost ▰▰▰▰▰▰▰▰▰▱ 85% (0m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["block line 0", {"text": "s:block_cost ┄┄┄┄┄┄┄┄┄┄ 0% (2h 15m)", "bgColor": "c:blockBg", "fgColor": "c:blockFg", "bold": "c:blockBold"}],
  ["weekly line 0", {"text": "s:weekly_cost ┄┄┄┄┄┄┄┄┄┄ 0% (0m)", "bgColor": "c:weeklyBg", "fgColor": "c:weeklyFg", "bold": "c:weeklyBold"}],
  ["block line 49.6", {"text": "s:block_cost ━━━━━┄┄┄┄┄ 50% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly line 49.6", {"text": "s:weekly_cost ━━━━━┄┄┄┄┄ 50% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block line 55", {"text": "s:block_cost ━━━━━━┄┄┄┄ 55% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly line 55", {"text": "s:weekly_cost ━━━━━━┄┄┄┄ 55% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block line 85", {"text": "s:block_cost ━━━━━━━━━┄ 85% (2h 15m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["weekly line 85", {"text": "s:weekly_cost ━━━━━━━━━┄ 85% (0m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["block squares 0", {"text": "s:block_cost ◻◻◻◻◻◻◻◻◻◻ 0% (2h 15m)", "bgColor": "c:blockBg", "fgColor": "c:blockFg", "bold": "c:blockBold"}],
  ["weekly squares 0", {"text": "s:weekly_cost ◻◻◻◻◻◻◻◻◻◻ 0% (0m)", "bgColor": "c:weeklyBg", "fgColor": "c:weeklyFg", "bold": "c:weeklyBold"}],
  ["block squares 49.6", {"text": "s:block_cost ◼◼◼◼◼◻◻◻◻◻ 50% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly squares 49.6", {"text": "s:weekly_cost ◼◼◼◼◼◻◻◻◻◻ 50% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block squares 55", {"text": "s:block_cost ◼◼◼◼◼◼◻◻◻◻ 55% (2h 15m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly squares 55", {"text": "s:weekly_cost ◼◼◼◼◼◼◻◻◻◻ 55% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["block squares 85", {"text": "s:block_cost ◼◼◼◼◼◼◼◼◼◻ 85% (2h 15m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["weekly squares 85", {"text": "s:weekly_cost ◼◼◼◼◼◼◼◼◼◻ 85% (0m)", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["block threshold 90", {"text": "s:block_cost 85% (0m)", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["weekly missing", null],
  ["version", {"text": "s:version v2.1.0", "bgColor": "c:versionBg", "fgColor": "c:versionFg"}],
  ["version missing", null],
  ["env", {"text": "s:env SEGRENDERER_GOLDEN: on", "bgColor": "c:envBg", "fgColor": "c:envFg"}],
  ["env prefix", {"text": "s:env P: on", "bgColor": "c:envBg", "fgColor": "c:envFg"}],
  ["env empty prefix", {"text": "s:env on", "bgColor": "c:envBg", "fgColor": "c:envFg"}],
  ["env unset", null],
  ["agent", {"text": "s:agent reviewer", "bgColor": "c:agentBg", "fgColor": "c:agentFg"}],
  ["agent label", {"text": "s:agent agent: reviewer", "bgColor": "c:agentBg", "fgColor": "c:agentFg"}],
  ["agent blank", null],
  ["agent missing", null],
  ["thinking both", {"text": "s:thinking On · high", "bgColor": "c:thinkingBg", "fgColor": "c:thinkingFg"}],
  ["thinking off", {"text": "s:thinking Off", "bgColor": "c:thinkingBg", "fgColor": "c:thinkingFg"}],
  ["thinking none", null],
  ["thinking disabled", null],
  ["cache elapsed 0", {"text": "s:cache_timer 0:00", "bgColor": "c:cacheTimerBg", "fgColor": "c:cacheTimerFg", "bold": "c:cacheTimerBold"}],
  ["cache elapsed ttl 0", {"text": "s:cache_timer 0:00", "bgColor": "c:cacheTimerBg", "fgColor": "c:cacheTimerFg", "bold": "c:cacheTimerBold"}],
  ["cache remaining 0", {"text": "s:cache_timer 5:00", "bgColor": "c:cacheTimerBg", "fgColor": "c:cacheTimerFg", "bold": "c:cacheTimerBold"}],
  ["cache remaining default 0", {"text": "s:cache_timer 60:00", "bgColor": "c:cacheTimerBg", "fgColor": "c:cacheTimerFg", "bold": "c:cacheTimerBold"}],
  ["cache elapsed 59", {"text": "s:cache_timer 0:59", "bgColor": "c:cacheTimerBg", "fgColor": "c:cacheTimerFg", "bold": "c:cacheTimerBold"}],
  ["cache elapsed ttl 59", {"text": "s:cache_timer 0:59", "bgColor": "c:cacheTimerBg", "fgColor": "c:cacheTimerFg", "bold": "c:cacheTimerBold"}],
  ["cache remaining 59", {"text": "s:cache_timer 4:01", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["cache remaining default 59", {"text": "s:cache_timer 50:10", "bgColor": "c:cacheTimerBg", "fgColor": "c:cacheTimerFg", "bold": "c:cacheTimerBold"}],
  ["cache elapsed 190", {"text": "s:cache_timer 3:10", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["cache elapsed ttl 190", {"text": "s:cache_timer 3:10", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["cache remaining 190", {"text": "s:cache_timer 1:50", "bgColor": "c:contextWarningBg", "fgColor": "c:contextWarningFg", "bold": "c:contextWarningBold"}],
  ["cache remaining default 190", {"text": "s:cache_timer 28:20", "bgColor": "c:cacheTimerBg", "fgColor": "c:cacheTimerFg", "bold": "c:cacheTimerBold"}],
  ["cache elapsed 300", {"text": "s:cache_timer 5m", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["cache elapsed ttl 300", {"text": "s:cache_timer 5m", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["cache remaining 300", {"text": "s:cache_timer cold", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["cache remaining default 300", {"text": "s:cache_timer 10:00", "bgColor": "c:cacheTimerBg", "fgColor": "c:cacheTimerFg", "bold": "c:cacheTimerBold"}],
  ["cache elapsed 4000", {"text": "s:cache_timer 1h+", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["cache elapsed ttl 4000", {"text": "s:cache_timer 1h+", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["cache remaining 4000", {"text": "s:cache_timer cold", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["cache remaining default 4000", {"text": "s:cache_timer cold", "bgColor": "c:contextCriticalBg", "fgColor": "c:contextCriticalFg", "bold": "c:contextCriticalBold"}],
  ["bastra null", null],
  ["bastra idle", {"text": "s:bastra bastra · 812 memories", "bgColor": "c:bastraBg", "fgColor": "c:bastraFg", "bold": "c:bastraBold"}],
  ["bastra zero calls", {"text": "s:bastra bastra · 812 memories", "bgColor": "c:bastraBg", "fgColor": "c:bastraFg", "bold": "c:bastraBold"}],
  ["bastra active", {"text": "s:bastra bastra · 2 calls · 1 hit · 340ms · rerank", "bgColor": "c:bastraBg", "fgColor": "c:bastraFg", "bold": "c:bastraBold"}],
  ["bastra active message", {"text": "s:bastra bastra · 1 call · 5 hits · 12ms · sorting", "bgColor": "c:bastraBg", "fgColor": "c:bastraFg", "bold": "c:bastraBold"}],
  ["bastra done", {"text": "s:bastra ✓ bastra · 1 call · 1 hit · 120ms", "bgColor": "c:bastraBg", "fgColor": "c:bastraFg", "bold": "c:bastraBold"}],
  ["bastra done no hits", {"text": "s:bastra ✓ bastra · 3 calls", "bgColor": "c:bastraBg", "fgColor": "c:bastraFg", "bold": "c:bastraBold"}],
  ["bastra done stale phrase", {"text": "s:bastra ✓ bastra · 2 calls · 7 hits · 99ms", "bgColor": "c:bastraBg", "fgColor": "c:bastraFg", "bold": "c:bastraBold"}],
  ["bastra icons off", {"text": "bastra · 812 memories", "bgColor": "c:bastraBg", "fgColor": "c:bastraFg", "bold": "c:bastraBold"}],
];

test("#1039: every SegmentRenderer method renders byte-identical output", () => {
  const actual = pin(renderAll());
  if (process.env.SEGRENDERER_GOLDEN_PRINT) {
    process.stderr.write(JSON.stringify(actual));
  }
  assert.equal(actual.length, EXPECTED.length);
  for (let i = 0; i < EXPECTED.length; i++) {
    assert.deepEqual(actual[i], EXPECTED[i], `case ${EXPECTED[i][0]}`);
  }
});
