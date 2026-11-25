// #1729: the reader (rendered text, tasks-report-notes.js) and the daemon (Markdown source,
// task-report-status.ts) must judge the same answer-option marker alike. Both read the one set of
// synthetic cases in fixtures/report-marker-cases.json; `asks` is what the owner sees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { h } from "./webui-report-dom.js";
import { questionCheck } from "../src/task-report-status.js";

const read = (path: string) => readFile(new URL(`../webui/app/js/${path}`, import.meta.url), "utf8");
const strip = (source: string) => source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "");
const cases: { name: string; body: string; asks: number; unread: string[] }[] = JSON.parse(
  await readFile(new URL("./fixtures/report-marker-cases.json", import.meta.url), "utf8")
);

/** How many questions the reader shows with answer buttons for `body`. */
async function readerAsks(body: string): Promise<number> {
  const reports = await read("sections/tasks-reports.js");
  const table = /function table\(b\) \{[\s\S]*?\n\}/.exec(reports)![0];
  const files = await Promise.all(
    ["views/code-lines.js", "sections/tasks-reports-model.js", "views/inline-scan.js", "views/markdown.js"].map(read)
  );
  const notes = await read("sections/tasks-report-notes.js");
  const care = await read("views/care-note.js");
  const api = runInNewContext(
    [...files.map(strip), table, strip(care), strip(notes)].join("\n") +
      "\n({ render: (md) => reportBlocks(md).flatMap((b) => (b.kind === 'table' ? [table(b)] : markdown(b.text, () => {}))), annotateReport })",
    {
      h,
      vault: () => null,
      growTextarea() {},
      t: (key: string) => key,
      fmtAt: (at: number) => `@${at}`,
      fetch: async () => ({ status: 503, json: async () => ({}) }),
      AbortController,
      setTimeout,
      clearTimeout,
    }
  );
  const ui = {
    notes: [],
    editing: null,
    open() {},
    edit() {},
    remove() {},
    save: async () => {},
    answer() {},
    cancel() {},
  };
  return api.annotateReport(api.render(body), ui).toc.asks.length;
}

for (const c of cases) {
  test(`#1729: reader and daemon agree on "${c.name}"`, async () => {
    const check = questionCheck(c.body);
    assert.equal(await readerAsks(c.body), c.asks, "reader");
    assert.equal(check.asks, c.asks, "daemon asks");
    assert.deepEqual(check.unread, c.unread, "daemon unread");
  });
}
