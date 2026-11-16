import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

type Clock = {
  loopContinues: (paused: boolean, busy: boolean) => boolean;
  frameClock: (pausedAt: number | null, now: number) => number;
  pausedFor: (pausedAt: number | null, now: number) => number;
};

async function clock(): Promise<Clock> {
  const source = await readFile(new URL("../webui/v22/js/views/lens-clock.js", import.meta.url), "utf8");
  return runInNewContext(source.replace(/^export /gm, "") + "\n({ loopContinues, frameClock, pausedFor })", {
    Math,
  }) as Clock;
}

test("the frame loop runs only while uncovered and still busy", async () => {
  const c = await clock();
  assert.equal(c.loopContinues(false, true), true);
  assert.equal(c.loopContinues(false, false), false);
  assert.equal(c.loopContinues(true, true), false); // covered: no schedule, even mid zoom
  assert.equal(c.loopContinues(true, false), false);
});

test("the animation clock is held while paused and live otherwise", async () => {
  const c = await clock();
  assert.equal(c.frameClock(null, 5000), 5000);
  assert.equal(c.frameClock(1200, 5000), 1200);
});

test("resume skips the paused time instead of replaying it", async () => {
  const c = await clock();
  assert.equal(c.pausedFor(null, 5000), 0);
  assert.equal(c.pausedFor(1200, 5000), 3800);
  assert.equal(c.pausedFor(5000, 4000), 0); // never negative
  // an effect started at 1000 with 300 ms spent: after a 3800 ms pause it is still 300 ms in
  const start = 1000 + c.pausedFor(1300, 5100);
  assert.equal(5100 - start, 300);
});

test("lens-canvas and lens-view wire the pause", async () => {
  const canvas = await readFile(new URL("../webui/v22/js/views/lens-canvas.js", import.meta.url), "utf8");
  const view = await readFile(new URL("../webui/v22/js/views/lens-view.js", import.meta.url), "utf8");
  assert.match(canvas, /loopContinues\(pausedAt != null,/);
  assert.match(view, /ch\("covered"\)\) lens\.update\(\{ paused: !!st\.covered \}\)/);
});
