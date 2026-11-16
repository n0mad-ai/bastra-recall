// v22 Live tab: which rows play the arrival animation (js/views/live-feed.js arrivals).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

type Ev = { key: string };
type Arr = { seen: Set<string>; nextAt: number; fresh: { key: string; delay: number }[] };
const evs = (...keys: string[]): Ev[] => keys.map((key) => ({ key }));

// Loaded like the other v22 modules (plain browser file, no type declarations).
const source = await readFile(new URL("../webui/v22/js/views/live-feed.js", import.meta.url), "utf8");
const { arrivals, STEP, MAX_WAIT } = runInNewContext(
  source.replace(/^export /gm, "") + "\n({ arrivals, STEP, MAX_WAIT })",
  { Math, Set }
);
// fresh as plain objects of this realm, so deepEqual compares values only
const arr = (prev: Arr | null, events: Ev[], now: number): Arr => {
  const a = arrivals(prev, events, now);
  return { ...a, fresh: JSON.parse(JSON.stringify(a.fresh)) };
};

test("the first render marks nothing as new, however many entries there are", () => {
  const a = arr(null, evs("e5", "e4", "e3", "e2", "e1"), 1000);
  assert.deepEqual(a.fresh, []);
  assert.deepEqual([...a.seen], ["e5", "e4", "e3", "e2", "e1"]);
});

test("a re-render with the same entries marks nothing again", () => {
  const a = arr(null, evs("e2", "e1"), 1000);
  const b = arr(a, evs("e3", "e2", "e1"), 2000);
  assert.deepEqual(b.fresh, [{ key: "e3", delay: 0 }]);
  const c = arr(b, evs("e3", "e2", "e1"), 9000);
  assert.deepEqual(c.fresh, []);
  assert.equal(c.nextAt, b.nextAt);
});

test("several new entries keep the list order and start staggered, oldest first", () => {
  const a = arr(null, evs("e1"), 0);
  const b = arr(a, evs("e4", "e3", "e2", "e1"), 5000);
  assert.deepEqual(
    b.fresh.map((f) => f.key),
    ["e4", "e3", "e2"]
  );
  assert.deepEqual(
    b.fresh.map((f) => f.delay),
    [2 * STEP, STEP, 0]
  );
});

test("a big delivery is capped, and a quick follow-up queues behind it", () => {
  const a = arr(null, [], 0);
  const keys = Array.from({ length: 12 }, (_, i) => `e${12 - i}`);
  const b = arr(a, evs(...keys), 1000);
  assert.equal(Math.max(...b.fresh.map((f) => f.delay)), MAX_WAIT);
  assert.equal(b.fresh.at(-1)?.delay, 0);
  const c = arr(b, evs("e13", ...keys), 1000 + STEP);
  assert.deepEqual(c.fresh, [{ key: "e13", delay: Math.min(11 * STEP, MAX_WAIT) }]);
  // much later the queue is empty again
  const d = arr(c, evs("e14", "e13", ...keys), 60000);
  assert.deepEqual(d.fresh, [{ key: "e14", delay: 0 }]);
});

test("entries that dropped off the end of the feed are forgotten", () => {
  const a = arr(null, evs("e2", "e1"), 0);
  const b = arr(a, evs("e3", "e2"), 100);
  assert.deepEqual([...b.seen], ["e3", "e2"]);
});
