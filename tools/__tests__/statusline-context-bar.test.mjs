/**
 * With percentageMode "remaining" the context segment printed
 * contextLeftPercentage but drew the bar from usablePercentage, so 90% used
 * showed "10%" over a 90%-full bar. The fill must follow the printed number.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PowerlineRenderer } from "../../packages/statusline/src/powerline.ts";
import { DEFAULT_CONFIG } from "../../packages/statusline/src/config/defaults.ts";

function context(info, config) {
  const renderer = new PowerlineRenderer(structuredClone(DEFAULT_CONFIG));
  return renderer.segments.segmentRenderer.renderContext(
    info,
    renderer.theme.getThemeColors(),
    config,
  );
}

const NINETY_USED = {
  totalTokens: 900,
  percentage: 90,
  usablePercentage: 90,
  contextLeftPercentage: 10,
  maxTokens: 1000,
  usableTokens: 1000,
};

test("remaining mode: the bar fills to the printed remaining percentage", () => {
  const seg = context(NINETY_USED, {
    enabled: true,
    displayStyle: "blocks",
    percentageMode: "remaining",
  });
  assert.match(seg.text, /\(10%\)$/);
  assert.equal(seg.text.split("█").length - 1, 1);
});

test("used mode: the bar fills to the printed used percentage", () => {
  const seg = context(NINETY_USED, {
    enabled: true,
    displayStyle: "blocks",
    percentageMode: "used",
  });
  assert.match(seg.text, /\(90%\)$/);
  assert.equal(seg.text.split("█").length - 1, 9);
});

test("no context data, remaining mode: a full bar beside 100%", () => {
  const seg = context(null, {
    enabled: true,
    displayStyle: "blocks",
    percentageMode: "remaining",
  });
  assert.equal(seg.text, `${"█".repeat(10)} 100%`);
});

test("no context data, used mode: an empty bar beside 0%", () => {
  const seg = context(null, {
    enabled: true,
    displayStyle: "blocks",
    percentageMode: "used",
  });
  assert.equal(seg.text, `${"░".repeat(10)} 0%`);
});
