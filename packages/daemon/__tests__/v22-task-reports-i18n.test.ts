// v22 task reports: every text key the reading view, the head button, the
// ticker and the dashboard widget use exists in each language file, and the
// widget is registered like the other built-in widgets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const read = (path: string) => readFile(new URL(`../webui/v22/${path}`, import.meta.url), "utf8");
const strings = async (path: string): Promise<Record<string, string>> =>
  runInNewContext(`(${(await read(path)).replace(/^export default\s*/m, "").replace(/;\s*$/, "")})`, {});
const keysIn = (source: string, prefix: RegExp) =>
  [...source.matchAll(/"([a-z]+\.[\w.]+)"/g)].map((m) => m[1]).filter((k) => prefix.test(k));

test("report texts exist in German and English", async () => {
  const reports = await read("js/sections/tasks-reports.js");
  const widgets = await read("js/sections/dashboard-widgets.js");
  const used = {
    tasks: [...new Set(keysIn(reports, /^tk\./))],
    dashboard: [...new Set(keysIn(widgets, /^db\.(rp|w\.reports)\./))],
  };
  assert.ok(used.tasks.includes("tk.rep.markRead") && used.tasks.includes("tk.rep.markUnread"));
  assert.ok(used.dashboard.includes("db.rp.meta"));
  for (const [file, keys] of Object.entries(used))
    for (const lang of ["de", "en"]) {
      const table = await strings(`js/i18n/${file}-${lang}.js`);
      for (const key of keys) assert.equal(typeof table[key], "string", `${key} in ${file}-${lang}`);
    }
});

test("the combined 'read and delete' action is gone: read, unread and delete are separate", async () => {
  for (const lang of ["de", "en"]) {
    const table = await strings(`js/i18n/tasks-${lang}.js`);
    assert.ok(table["tk.rep.markRead"] && table["tk.rep.markUnread"] && table["tk.rep.delete"]);
    assert.doesNotMatch(table["tk.rep.delete"], /read|gelesen/i);
  }
});

test("the reports widget is a built-in widget that joins only boards the user has not arranged", async () => {
  const widgets = await read("js/sections/dashboard-widgets.js");
  const entry = /\{\s*type: "reports",[\s\S]*?render: renderReports,\s*\}/.exec(widgets)?.[0] ?? "";
  assert.match(entry, /code: "W-08"/);
  assert.match(entry, /defaultOn: true/);
  assert.match(entry, /minH: 2/);
  const board = await read("js/sections/dashboard.js");
  assert.doesNotMatch(/const DEFAULT = \[[\s\S]*?\];/.exec(board)![0], /reports/, "a saved layout is never rewritten");
});
