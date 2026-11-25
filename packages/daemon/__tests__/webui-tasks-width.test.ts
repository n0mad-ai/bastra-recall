// The Tasks calendar reads its mode from the settled content width (#1701, #1702): a one-pixel change
// counts, and a width measured while the stage still animates its edges does not.
import { test } from "node:test";
import assert from "node:assert/strict";

let observed: (() => void) | null = null;
Object.assign(globalThis, {
  ResizeObserver: class {
    constructor(cb: () => void) {
      observed = cb;
    }
    observe() {}
    disconnect() {
      observed = null;
    }
  },
});
const { watchSettledWidth } = (await import(
  new URL("../webui/app/js/sections/tasks-width.js", import.meta.url).href
)) as {
  watchSettledWidth: (el: { clientWidth: number }, stage: unknown, onWidth: (w: number) => void) => { stop(): void };
};

function stageStub() {
  const listeners = new Map<string, () => void>();
  return {
    running: 0,
    getAnimations() {
      return Array.from({ length: this.running });
    },
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    fire: (type: string) => listeners.get(type)?.(),
    listeners,
  };
}

test("#1702: a one-pixel change in either direction across 700 px reaches the calendar", () => {
  const el = { clientWidth: 700 },
    seen: number[] = [];
  watchSettledWidth(el, stageStub(), (w) => seen.push(w));
  el.clientWidth = 699;
  observed?.();
  el.clientWidth = 700;
  observed?.();
  observed?.(); // same width again: nothing new
  assert.deepEqual(seen, [699, 700]);
});

test("#1701: widths during the stage transition are skipped, the settled width arrives on transitionend", () => {
  const el = { clientWidth: 704 },
    stage = stageStub(),
    seen: number[] = [];
  watchSettledWidth(el, stage, (w) => seen.push(w));
  stage.running = 2; // left and right edges animate
  for (const w of [640, 660, 690]) {
    el.clientWidth = w;
    observed?.();
  }
  el.clientWidth = 700;
  stage.running = 1;
  stage.fire("transitionend"); // one edge done, the other still moves
  assert.deepEqual(seen, []);
  stage.running = 0;
  stage.fire("transitionend");
  assert.deepEqual(seen, [700], "the transient 640 px never switched the calendar to three days");
});

test("a cancelled stage transition still delivers the final width, and stop() detaches everything", () => {
  const el = { clientWidth: 800 },
    stage = stageStub(),
    seen: number[] = [];
  const watch = watchSettledWidth(el, stage, (w) => seen.push(w));
  el.clientWidth = 650;
  stage.fire("transitioncancel");
  assert.deepEqual(seen, [650]);
  watch.stop();
  assert.equal(stage.listeners.size, 0);
  assert.equal(observed, null);
});
