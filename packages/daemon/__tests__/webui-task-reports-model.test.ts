import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

async function model() {
  const read = (path: string) => readFile(new URL(`../webui/app/js/${path}`, import.meta.url), "utf8");
  const source = (await read("views/code-lines.js")) + (await read("sections/tasks-reports-model.js"));
  return runInNewContext(
    source.replace(/^import .*$/gm, "").replace(/^export /gm, "") +
      "\n({ reportRows, unreadCount, isUnread, stateOf, originText, reportBlocks, byUnread, matchReports, FILTER_STATES, ATTENTION, stateCounts, inStates, grouped })",
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
    outdatedAt: null,
    notesOpen: 0,
    notesDraft: 0,
    notesHanded: 0,
    notesDone: 0,
    noteProgress: "",
    noteProgressRevision: "",
    status: null,
    followUp: null,
    followUpOf: null,
  });
  assert.equal(m.originText(rows[1]), "claude-code · s1");
  assert.equal(m.originText(rows[0]), "x");
});

test("#1678: outdated rows go last, count as unread nowhere and show the outdated state", async () => {
  const m = await model();
  const rows = m.reportRows({
    reports: [
      { id: "a", title: "veraltet neu", origin: {}, created_at: 900, outdated_at: 950, status: "outdated" },
      { id: "b", title: "gelesen", origin: {}, created_at: 100, read_at: 200 },
      { id: "c", title: "veraltet gelesen", origin: {}, created_at: 300, read_at: 400, outdated_at: 500 },
      { id: "d", title: "ungelesen", origin: {}, created_at: 50 },
      { id: "e", title: "kaputt", origin: {}, created_at: 60, outdated_at: "gestern" },
    ],
  });
  assert.deepEqual(
    rows.map((r: any) => r.id),
    ["e", "d", "b", "a", "c"]
  );
  assert.equal(rows[3].outdatedAt, 950);
  assert.equal(rows[0].outdatedAt, null, "a broken time is no mark");
  assert.equal(m.unreadCount(rows), 2);
  assert.equal(m.isUnread(rows[3]), false);
  assert.equal(m.stateOf(rows[3]), "outdated");
  assert.equal(m.stateOf(rows[4]), "outdated", "a Recall without status: the time alone decides");
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

// Status filter above the list (Daniel 26.11.2026): by default only the reports that need the owner.
type FilterRow = { id: string };
/** The part of the model the status filter uses. */
interface FilterModel {
  reportRows(answer: unknown): FilterRow[];
  stateOf(r: FilterRow): string;
  FILTER_STATES: string[];
  ATTENTION: string[];
  stateCounts(rows: FilterRow[]): Record<string, number>;
  inStates(rows: FilterRow[], on: Set<string>, keep?: (r: FilterRow) => boolean): FilterRow[];
  grouped(
    rows: FilterRow[]
  ): Array<{ group: string; rows: Array<{ row: FilterRow; lineAbove?: boolean; lineBelow?: boolean }> }>;
}
const filterModel = async () => (await model()) as FilterModel;
const STATE_ROWS = (m: FilterModel) =>
  m.reportRows({
    reports: ["new", "read", "question", "done", "handed", "outdated", "in_progress", "new"].map((status, i) => ({
      id: `r${i}`,
      title: `${status} ${i}`,
      origin: { client: "codex" },
      created_at: 100 - i,
      ...(status === "new" ? {} : { read_at: 200 }),
      ...(status === "outdated" ? { outdated_at: 300 } : {}),
      status,
    })),
  });

test("status filter: every state is a switch; new, question, in progress and handed over are on by default", async () => {
  const m = await filterModel();
  assert.deepEqual(plain(m.FILTER_STATES), ["new", "question", "in_progress", "handed", "read", "done", "outdated"]);
  assert.deepEqual(plain(m.ATTENTION), ["new", "question", "in_progress", "handed"]);
  const rows = STATE_ROWS(m);
  assert.deepEqual(plain(m.stateCounts(rows)), {
    new: 2,
    question: 1,
    in_progress: 1,
    handed: 1,
    read: 1,
    done: 1,
    outdated: 1,
  });
  assert.deepEqual(plain(m.stateCounts([])), {
    new: 0,
    question: 0,
    in_progress: 0,
    handed: 0,
    read: 0,
    done: 0,
    outdated: 0,
  });
  const open = m.inStates(rows, new Set(m.ATTENTION));
  assert.deepEqual(
    open.map((r) => m.stateOf(r)).sort(),
    ["handed", "in_progress", "new", "new", "question"],
    "read, done and outdated stay out by default"
  );
  // only questions; a row the caller keeps (the open report) stays whatever its state
  const asks = m.inStates(rows, new Set(["question"]), (r) => r.id === "r3");
  assert.deepEqual(plain(asks.map((r) => r.id)), ["r2", "r3"]);
  assert.deepEqual(plain(m.inStates(rows, new Set())), []);
});

test("status filter: open reports first, then read, done and outdated as groups of their own, order kept", async () => {
  const m = await filterModel();
  const rows = STATE_ROWS(m);
  const groups = m.grouped(rows);
  const openIds = rows.filter((r) => m.ATTENTION.includes(m.stateOf(r))).map((r) => r.id);
  assert.equal(openIds.length, 5);
  assert.deepEqual(plain(groups.map((g) => [g.group, g.rows.map(({ row }) => row.id)])), [
    ["open", openIds],
    ["read", ["r1"]],
    ["done", ["r3"]],
    ["outdated", ["r5"]],
  ]);
  // the order inside a group is the order the rows came in
  assert.deepEqual(
    plain(groups[0].rows.map(({ row }) => row.id)),
    plain(rows.map((r) => r.id).filter((id: string) => openIds.includes(id)))
  );
  assert.deepEqual(
    plain(m.grouped(m.inStates(rows, new Set(["done"]))).map((g) => g.group)),
    ["done"],
    "empty groups are left out"
  );
  assert.deepEqual(plain(m.grouped([])), []);
});
