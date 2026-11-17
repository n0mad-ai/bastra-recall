import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

async function model() {
  const source = await readFile(new URL("../webui/v22/js/sections/tasks-reports-model.js", import.meta.url), "utf8");
  return runInNewContext(
    source.replace(/^export /gm, "") + "\n({ reportRows, unreadCount, originText, reportBlocks, byUnread })",
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
