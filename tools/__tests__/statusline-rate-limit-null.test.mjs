/**
 * Math.round(null) is 0, so a rate_limits window whose used_percentage is null
 * drew a green "0%" instead of being omitted as "no data".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PowerlineRenderer } from "../../packages/statusline/src/powerline.ts";
import { DEFAULT_CONFIG } from "../../packages/statusline/src/config/defaults.ts";
import * as claude from "../../packages/statusline/src/utils/claude.ts";

const RESETS = Math.floor(Date.now() / 1000) + 3 * 24 * 3600;

async function render(rateLimits) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.display.lines = [
    { segments: { weekly: { enabled: true, displayStyle: "text" } } },
  ];
  const renderer = new PowerlineRenderer(config);
  return (
    await renderer.generateStatusline({
      session_id: "rate-limit-null",
      cwd: "/tmp",
      rate_limits: rateLimits,
    })
  ).replace(/\x1b\[[0-9;]*m/g, "");
}

test("a seven_day window with a null percentage is omitted, not drawn as 0%", async () => {
  const out = await render({
    seven_day: { used_percentage: null, resets_at: RESETS },
  });
  assert.doesNotMatch(out, /0%/);
});

test("a real 0% window is still drawn", async () => {
  const out = await render({
    seven_day: { used_percentage: 0, resets_at: RESETS },
  });
  assert.match(out, /0%/);
});

test("dropUnreadableRateLimits drops non-finite windows and keeps the rest", () => {
  const out = claude.dropUnreadableRateLimits({
    session_id: "s",
    rate_limits: {
      five_hour: { used_percentage: null, resets_at: RESETS },
      seven_day: { used_percentage: 12, resets_at: RESETS },
    },
  });
  assert.equal(out.rate_limits.five_hour, undefined);
  assert.equal(out.rate_limits.seven_day.used_percentage, 12);
});
