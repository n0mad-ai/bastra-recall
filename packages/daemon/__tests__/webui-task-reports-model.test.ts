import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

async function model() {
  const read = (path: string) => readFile(new URL(`../webui/app/js/${path}`, import.meta.url), "utf8");
  const source = (await read("views/code-lines.js")) + (await read("sections/tasks-reports-model.js"));
  return runInNewContext(
    source.replace(/^import .*$/gm, "").replace(/^export /gm, "") +
      "\n({ reportRows, unreadCount, originText, reportBlocks, byUnread, matchReports })",
    {}
  );
}
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

test("rows: unread first, newest first, broken entries dropped", async () => {
  const m = await model();
  const rows = m.reportRows({
    reports: [
      { id: "a", title: "alt gelesen", origin: { client: "codex" }, created_at: 100, read_at: 500 },
      { id: "b", title: "neu gelesen", origin: { client: "codex" }, created_at: 300, read_at: 400 },
      { id: "c", title: "alt ungelesen", origin: { client: "claude-code", session: "s1" }, created_at: 200 },
      { id: "d", title: "neu ungelesen", project: "recall", origin: { client: "x" }, created_at: 900 },
      { id: "", title: "ohne id", created_at: 1 },
      { id: "e", title: "   ", created_at: 1 },
      { id: "f", title: "ohne Zeit" },
      null,
      "text",
    ],
  });
  assert.deepEqual(
    rows.map((r: any) => r.id),
    ["d", "c", "b", "a"]
  );
  assert.equal(m.unreadCount(rows), 2);
  assert.deepEqual(plain(rows[0]), {
    id: "d",
    title: "neu ungelesen",
    project: "recall",
    client: "x",
    session: "",
    createdAt: 900,
    readAt: null,
    notesOpen: 0,
    notesDraft: 0,
    status: null,
    followUp: null,
    followUpOf: null,
  });
  assert.equal(m.originText(rows[1]), "claude-code · s1");
  assert.equal(m.originText(rows[0]), "x");
});

test("rows: a missing or malformed answer is an empty list, not an error", async () => {
  const m = await model();
  for (const answer of [undefined, null, {}, { reports: "x" }, { reports: null }])
    assert.deepEqual(plain(m.reportRows(answer)), []);
  assert.equal(m.unreadCount([]), 0);
});

test("blocks: pipe tables become table blocks, prose and code stay for the Markdown renderer", async () => {
  const m = await model();
  const md = [
    "# Ergebnis",
    "Text davor.",
    "",
    "| Datei | Zeilen |",
    "|---|:---:|",
    "| a.ts | 12 |",
    "| b.ts | 7 |",
    "Text danach.",
    "```",
    "| kein | Tisch |",
    "|---|---|",
    "```",
    "| nur | eine Zeile ohne Trennlinie |",
  ].join("\n");
  assert.deepEqual(plain(m.reportBlocks(md)), [
    { kind: "md", text: "# Ergebnis\nText davor.\n" },
    {
      kind: "table",
      head: ["Datei", "Zeilen"],
      rows: [
        ["a.ts", "12"],
        ["b.ts", "7"],
      ],
    },
    {
      kind: "md",
      text: "Text danach.\n```\n| kein | Tisch |\n|---|---|\n```\n| nur | eine Zeile ohne Trennlinie |",
    },
  ]);
  assert.deepEqual(plain(m.reportBlocks("")), [{ kind: "md", text: "" }]);
});

test("blocks (#1662/#1665): code is found as the reader finds it, so no table is cut out of it", async () => {
  const m = await model();
  const kinds = (md: string) => plain(m.reportBlocks(md)).map((b: any) => b.kind);
  const table = "| a | b |\n|---|---|\n| 1 | 2 |";
  const indent = (s: string, by: string) => s.replace(/^/gm, by);
  assert.deepEqual(kinds(table), ["table"]);
  // an indented fence (in a list or not) protects its table, as markdown() renders it as code
  assert.deepEqual(kinds(`- step\n  \`\`\`\n${indent(table, "  ")}\n  \`\`\``), ["md"]);
  assert.deepEqual(kinds(`Text\n   \`\`\`\n${table}\n   \`\`\``), ["md"]);
  // indented code after a blank line outside a list: code, not a table
  assert.deepEqual(kinds(`Text\n\n${indent(table, "    ")}`), ["md"]);
  // the same lines inside a list or right under a paragraph stay a table, as before
  assert.deepEqual(kinds(`- item\n\n${indent(table, "    ")}`), ["md", "table"]);
  assert.deepEqual(kinds(`Text\n${indent(table, "    ")}`), ["md", "table"]);
});

test("search (#1597): title and project, case and Unicode form never decide, every word must match", async () => {
  const m = await model();
  const rows = m.reportRows({
    reports: [
      { id: "a", title: "Überblick über die Förderung", project: "FÖRDERUNG", origin: {}, created_at: 3 },
      { id: "b", title: "Straße und Weg", project: "bastra-recall", origin: {}, created_at: 2 },
      { id: "c", title: "Ohne Projekt", origin: {}, created_at: 1 },
    ],
  });
  const ids = (q: string) => m.matchReports(rows, q).map((r: any) => r.id);
  assert.deepEqual(ids(""), ["a", "b", "c"], "an empty query keeps the list");
  assert.deepEqual(ids("   "), ["a", "b", "c"]);
  assert.deepEqual(ids("ÜBERBLICK"), ["a"]);
  assert.deepEqual(ids("förderung"), ["a"], "lower case finds the upper-case project");
  assert.deepEqual(ids("FO\u0308RDERUNG"), ["a"], "a decomposed umlaut finds the composed one");
  assert.deepEqual(ids("u\u0308berblick".normalize("NFD")), ["a"]);
  assert.deepEqual(ids("STRASSE"), [], "no language rules: ß is not spelled out");
  assert.deepEqual(ids("straße"), ["b"]);
  assert.deepEqual(ids("bastra weg"), ["b"], "words may come from title and project");
  assert.deepEqual(ids("bastra förderung"), [], "every word has to match");
  assert.deepEqual(ids("projekt"), ["c"], "a report without a project is found by its title");
});

test("search (#1597): a compatibility uppercase in the title matches lowercase input", async () => {
  const m = await model();
  const rows = m.reportRows({ reports: [{ id: "a", title: "𝐀udit", created_at: 1 }] });
  assert.equal(m.matchReports(rows, "audit")[0]?.id, "a");
});
