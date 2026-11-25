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
  const source = await readFile(new URL("../webui/app/js/views/lens-clock.js", import.meta.url), "utf8");
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
  const canvas = await readFile(new URL("../webui/app/js/views/lens-canvas.js", import.meta.url), "utf8");
  const view = await readFile(new URL("../webui/app/js/views/lens-view.js", import.meta.url), "utf8");
  assert.match(canvas, /loopContinues\(pausedAt != null,/);
  assert.match(view, /ch\("covered"\)\) lens\.update\(\{ paused: !!st\.covered \}\)/);
});

// #1552: a footer replay (or a lens switch) while a covering layer is open used
// to restart the animation at the wall clock while frames stay on the held
// clock, so the progress went negative (Half-life rings: negative radius,
// IndexSizeError). The real lens canvas runs here with a fake canvas and clock.
async function lensUnderCover(onOpen?: (id: string) => void) {
  const read = (file: string) => readFile(new URL(`../webui/app/js/views/${file}`, import.meta.url), "utf8");
  const strip = (source: string) => source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "");
  const source = strip(await read("lens-clock.js")) + "\n" + strip(await read("lens-canvas.js"));
  const clock = { now: 1000 };
  const frames: Array<(ts: number) => void> = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const drawn: number[] = [];
  const node = () => ({
    append() {},
    appendChild() {},
    remove() {},
    replaceChildren() {},
    addEventListener() {},
    removeEventListener() {},
    classList: { add() {}, remove() {} },
    dataset: {},
    getBoundingClientRect: () => ({ width: 400, height: 300, left: 0, top: 0 }),
  });
  const canvas = Object.assign(node(), {
    parentElement: node(),
    getContext: () => new Proxy({}, { get: () => () => {} }),
  });
  const lens = runInNewContext(source + "\n({ mountLens })", {
    Math,
    performance: { now: () => clock.now },
    requestAnimationFrame: (fn: (ts: number) => void) => frames.push(fn),
    cancelAnimationFrame() {},
    setTimeout(fn: () => void) {
      timers.set(++nextTimer, fn);
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    window: { devicePixelRatio: 1 },
    document: {},
    h: () => node(),
    setVars() {},
    tr: (key: string) => key,
    TC: {},
    ACC: "#fff",
    INK: "#fff",
    VIEWS: {
      half: ({ t, pt }: { t: number; pt: (x: number, y: number, r: number, datum: object) => void }) => {
        drawn.push(t);
        pt(100, 90, 5, { m: { id: "memory" } });
      },
    },
    prep: (vault: unknown) => vault,
    rgba: () => "",
    dstr: () => "",
  }).mountLens(canvas, { kind: "half", vault: { n: 1 }, onOpen });
  // one frame at the current time (the loop asks for the next one while busy)
  const flush = () => frames.splice(0).forEach((frame) => frame(clock.now));
  return { lens, clock, drawn, flush, runTimers: () => timers.forEach((fn) => fn()) };
}

test("a replay under a covering layer starts on the held clock and plays after resume (#1552)", async () => {
  const { lens, clock, drawn, flush } = await lensUnderCover();
  flush();
  lens.update({ paused: true }); // covered at 1000
  clock.now = 6000;
  lens.update({ vault: { n: 2 }, replay: true }); // footer range change while covered
  lens.update({ kind: "chronos" }); // and a lens switch
  lens.update({ kind: "half" });
  drawn.length = 0;
  clock.now = 8000;
  lens.update({ paused: false });
  flush();
  assert.ok(drawn.length > 0);
  assert.ok(
    drawn.every((t) => t >= 0 && t <= 1),
    `progress left 0..1: ${drawn.join(", ")}`
  );
  assert.equal(drawn[0], 0); // the sweep starts at resume, not before
  clock.now = 8550;
  lens.update({ focus: "x" });
  flush();
  assert.ok(drawn.at(-1)! > 0 && drawn.at(-1)! < 1); // still playing halfway
});

test("reset during a lens zoom cancels the pending card and browser callback", async () => {
  const opened: string[] = [];
  const { lens, flush, runTimers } = await lensUnderCover((id) => opened.push(id));
  flush();
  assert.equal(
    lens.open("memory", () => opened.push("browser")),
    true
  );
  assert.equal(lens.selScreen()[2], "memory");
  lens.reset();
  runTimers();
  assert.equal(lens.selScreen(), null);
  assert.deepEqual(opened, []);
});
