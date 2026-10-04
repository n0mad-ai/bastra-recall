/**
 * The elapsed-mode cache timer (powerline) and the TUI cacheTimerStyle
 * hard-coded 300s critical / 180s warning, so a fresh 1-hour cache turned red
 * at 5 minutes although the detected TTL (3600s) was already known. Colors now
 * follow the TTL: warning at 60% of it, critical at 100%. A configured
 * cacheTimer.ttlSeconds wins over the detected one in the TUI as in the classic
 * renderer.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test tools/__tests__/statusline-cache-timer-ttl.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PowerlineRenderer } from "../../packages/statusline/src/powerline.ts";
import { DEFAULT_CONFIG } from "../../packages/statusline/src/config/defaults.ts";
import { SYMBOLS } from "../../packages/statusline/src/utils/constants.ts";
import {
  resolveSegments,
  collectFooterParts,
} from "../../packages/statusline/src/tui/sections.ts";

const baseConfig = structuredClone(DEFAULT_CONFIG);
// Non-TTY test runs resolve "auto" to no color; pin it so the colors differ.
baseConfig.display.colorCompatibility = "truecolor";
const renderer = new PowerlineRenderer(baseConfig);
const colors = renderer.theme.getThemeColors();

function classic(elapsedSeconds, detectedTtlSeconds, config = {}) {
  return renderer.segments.segmentRenderer.renderCacheTimer(
    { elapsedSeconds, detectedTtlSeconds },
    colors,
    { enabled: true, ...config },
  );
}

test("elapsed mode: a 1h cache is not critical at 5 minutes", () => {
  assert.equal(classic(400, 3600).bgColor, colors.cacheTimerBg);
});

test("elapsed mode: warning at 60% and critical at 100% of the detected TTL", () => {
  assert.equal(classic(2200, 3600).bgColor, colors.contextWarningBg);
  assert.equal(classic(3600, 3600).bgColor, colors.contextCriticalBg);
});

test("elapsed mode: the configured TTL wins over the detected one", () => {
  assert.equal(classic(400, 3600, { ttlSeconds: 300 }).bgColor, colors.contextCriticalBg);
});

test("elapsed mode: without any TTL the 300s/180s thresholds stay", () => {
  assert.equal(classic(180, undefined).bgColor, colors.contextWarningBg);
  assert.equal(classic(300, undefined).bgColor, colors.contextCriticalBg);
});

function tuiData(elapsedSeconds, detectedTtlSeconds) {
  return {
    hookData: { session_id: "s" },
    usageInfo: null,
    blockInfo: null,
    todayInfo: null,
    contextInfo: null,
    metricsInfo: null,
    gitInfo: null,
    cacheTimerInfo: { elapsedSeconds, detectedTtlSeconds },
    bastraInfo: null,
    tmuxSessionId: null,
    colors,
  };
}

test("TUI: the cache timer follows the detected TTL", () => {
  const config = structuredClone(baseConfig);
  const ctx = (data) => ({ data, sym: SYMBOLS, config, reset: "", colors });
  const at = (elapsed, ttl) => {
    const data = tuiData(elapsed, ttl);
    return resolveSegments(data, ctx(data)).data.cacheTimer;
  };
  assert.ok(at(400, 3600).includes(colors.cacheTimerFg));
  assert.ok(at(3600, 3600).includes(colors.contextCriticalFg));
  assert.ok(at(300, undefined).includes(colors.contextCriticalFg));
});

test("TUI footer: the cache timer follows the detected TTL", () => {
  const config = structuredClone(baseConfig);
  config.display.lines = [{ segments: { cacheTimer: { enabled: true } } }];
  const footer = (elapsed, ttl) => {
    const data = tuiData(elapsed, ttl);
    return collectFooterParts(data, SYMBOLS, config, "", colors).join(" ");
  };
  assert.ok(footer(400, 3600).includes(colors.cacheTimerFg));
  assert.ok(footer(3600, 3600).includes(colors.contextCriticalFg));
});

// Regression: the TUI call sites passed only the detected TTL, so a configured
// cacheTimer.ttlSeconds colored the classic renderer but not the TUI.
test("TUI and TUI footer: the configured TTL wins over the detected one", () => {
  const config = structuredClone(baseConfig);
  config.display.lines = [{ segments: { cacheTimer: { enabled: true, ttlSeconds: 300 } } }];
  const data = tuiData(400, 3600);
  const inline = resolveSegments(data, { data, sym: SYMBOLS, config, reset: "", colors }).data.cacheTimer;
  assert.ok(inline.includes(colors.contextCriticalFg), "resolveSegments ignored the configured TTL");
  const footer = collectFooterParts(data, SYMBOLS, config, "", colors).join(" ");
  assert.ok(footer.includes(colors.contextCriticalFg), "the footer ignored the configured TTL");
});
