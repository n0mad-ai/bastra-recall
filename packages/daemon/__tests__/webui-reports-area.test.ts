// UI v2 — Reports as an area of their own (Daniel 18.11.2026): the Tasks area's head has no
// "REPORTS · n" button any more (the rail entry and the address #reports lead there), the reading view
// shows none of the tasks' head (title, status tiles, "Due", "New task"), the header's crumb names
// the reports, and the existing right panel shows the jump list there instead of Details / View /
// Control. tasks.js, main.js and header.js need the whole shell to run, so their wiring is read from
// the source; the right panel's tab choice runs for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const read = (path: string) => readFile(new URL(`../webui/app/${path}`, import.meta.url), "utf8");
const pick = (src: string, re: RegExp) => re.exec(src)?.[0] ?? assert.fail(`not found: ${re}`);

test("the Tasks head has no reports button; the reading view shows no tasks head at all", async () => {
  const tasks = await read("js/sections/tasks.js");
  assert.doesNotMatch(tasks, /reportsButton/, "no 'REPORTS · n' button in the Tasks area");
  const head = pick(tasks, /function head\(\) \{[\s\S]*?\n\}/);
  assert.match(head, /statusTiles\(\)/, "the Tasks area keeps its status tiles");
  assert.match(head, /tk\.dueBtn/, "and its due button");
  assert.match(head, /tk\.new/, "and 'New task'");
  const draw = pick(tasks, /function draw\(\) \{[\s\S]*?\n\}/);
  assert.match(draw, /clear\(headSlot\);\s*if \(!reportsOpen\(\)\) headSlot\.append\(head\(\)\);/);
  const reports = await read("js/sections/tasks-reports.js");
  assert.doesNotMatch(reports, /export function reportsButton/);
  for (const lang of ["de", "en"])
    assert.doesNotMatch(await read(`js/i18n/tasks-${lang}.js`), /"tk\.rep\.(btn|esc|back|unreadTip)"/, lang);
});

test("the right panel: the jump list in the reading view, Details / View / Control on the calendar", async () => {
  const tasks = await read("js/sections/tasks.js");
  assert.match(tasks, /tabs: \(\) => \(reportsOpen\(\) \? \[outlineTab\] : CALENDAR_TABS\),/);
  assert.deepEqual(
    [...pick(tasks, /const CALENDAR_TABS = \[[\s\S]*?\];/).matchAll(/labelKey: "([\w.]+)"/g)].map((m) => m[1]),
    ["lens.details", "lens.view", "lens.control"]
  );
  // the panel itself (js/lens.js) asks an area with tab functions on every render
  const lens = await read("js/lens.js");
  const tabsOf = runInNewContext(`${pick(lens, /const tabsOf = \(view\) => \{[\s\S]*?\n\};/)}\ntabsOf`, {
    VAULT_TABS: ["vault"],
    getArea: (id: string) =>
      ({ list: { tabs: ["a", "b"] }, fn: { tabs: () => (open ? ["toc"] : ["cal"]) }, none: {} })[id],
  });
  let open = true;
  assert.deepEqual(tabsOf("fn"), ["toc"]);
  open = false;
  assert.deepEqual(tabsOf("fn"), ["cal"]);
  assert.deepEqual(tabsOf("list"), ["a", "b"]);
  assert.deepEqual(tabsOf("none"), ["vault"]);
});

test("the header's crumb reads 'Reports' in the reading view and follows the switch", async () => {
  const tasks = await read("js/sections/tasks.js");
  assert.match(tasks, /crumb: \(\) => \(reportsOpen\(\) \? t\("nav\.reports"\) : null\),/);
  const main = await read("js/main.js");
  const viewLabel = runInNewContext(`(${pick(main, /\(v\) => \{\s*const a = getArea[\s\S]*?\n {2}\}/)})`, {
    getArea: (id: string) =>
      ({
        tasks: { labelKey: "nav.tasks", crumb: () => (open ? "Reports" : null) },
        plain: { labelKey: "nav.plain" },
      })[id],
    t: (k: string) => k,
  });
  let open = true;
  assert.equal(viewLabel("tasks"), "Reports");
  open = false;
  assert.equal(viewLabel("tasks"), "nav.tasks");
  assert.equal(viewLabel("plain"), "nav.plain");
  // opening and closing the reading view announces itself (recall:nav); the crumb listens
  assert.match(await read("js/header.js"), /document\.addEventListener\("recall:nav", renderCrumb\);/);
});
