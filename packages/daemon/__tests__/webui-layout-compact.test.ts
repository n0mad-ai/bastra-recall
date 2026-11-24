// Daniel's decision B on the Tasks calendar: the week shows from a 700px stage (sections/tasks-ledger.js),
// and the right panel folds away early enough that, while the window narrows, the week drops to three
// days once and never comes back. Before, the panel folded below 1400px: 1400–1527px showed three days,
// 1300px the week again. The shell geometry (js/layout.js) is the stage width the calendar measures.
import { test } from "node:test";
import assert from "node:assert/strict";

Object.assign(globalThis, { window: globalThis, document: { dispatchEvent() {} } });
const { computeLayout, COMPACT_BELOW } = (await import(new URL("../webui/app/js/layout.js", import.meta.url).href)) as {
  computeLayout: (s: Record<string, unknown>) => { W: number; compact: boolean };
  COMPACT_BELOW: number;
};

const tasks = (vw: number) => computeLayout({ view: "tasks", vw, vh: 900, jOpen: false, lensOpen: true });
const week = (vw: number) => tasks(vw).W >= 700;

test("decision B: narrowing the window, the Tasks week changes to three days once and never back", () => {
  const changes: number[] = [];
  for (let vw = 2400; vw > 900; vw--) if (week(vw) !== week(vw + 1)) changes.push(vw);
  assert.equal(changes.length, 1, `the week view changes at ${changes.join(", ")} px`);
  assert.equal(week(changes[0]), false);
});

test("decision B: the panel folds just below the width where the week fits beside it", () => {
  assert.equal(tasks(COMPACT_BELOW).compact, false);
  assert.equal(tasks(COMPACT_BELOW).W, 700);
  assert.equal(tasks(COMPACT_BELOW - 1).compact, true);
});
