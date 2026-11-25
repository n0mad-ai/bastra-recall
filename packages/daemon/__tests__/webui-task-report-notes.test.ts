// UI v2 task reports — notes on single places of a report: the pure model
// (anchors, excerpts, validation), the decoration of the rendered report
// (button per heading / paragraph / list item / table row, notes below their
// block, lost notes at the end), the reused note field with "improve text"
// (views/care-note.js) and the EN/DE texts. A small fake DOM stands in for
// the browser; the real modules run in a VM context.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { Node_, h } from "./webui-report-dom.js";

const read = (path: string) => readFile(new URL(`../webui/app/js/${path}`, import.meta.url), "utf8");
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const strip = (source: string) => source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "");

async function load(
  fetchFn: (url: string, init: any) => Promise<any> = async () => ({ status: 503, json: async () => ({}) })
) {
  const [model, care, notes] = await Promise.all([
    read("sections/tasks-reports-model.js"),
    read("views/care-note.js"),
    read("sections/tasks-report-notes.js"),
  ]);
  return runInNewContext(
    [strip(model), strip(care), strip(notes)].join("\n") +
      "\n({ reportRows, noteRows, excerptOf, notesAt, noteCounts, draftReports, reportBlocksIn, annotateReport, noteEditor, askOf, answerAt, hereIndex, optionParts })",
    {
      h,
      growTextarea() {},
      t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
      fmtAt: (at: number) => `@${at}`,
      fetch: fetchFn,
      AbortController,
      setTimeout,
      clearTimeout,
    }
  );
}

/** The rendered report as markdown() and the table renderer build it. */
function rendered() {
  return [
    h("h3", null, "Entscheidungen, die bei Daniel liegen"),
    h("ul", null, h("li", null, "Preis- und Abrechnungsmodell für Pulse"), h("li", null, "Name")),
    h("p", null, "Ein Absatz."),
    h("pre", { text: "code" }),
    h(
      "div.tk-rep__tbl",
      null,
      h(
        "table",
        null,
        h("thead", null, h("tr", null, h("th", { text: "Punkt" }), h("th", { text: "Stand" }))),
        h(
          "tbody",
          null,
          h("tr", null, h("td", { text: "Preise" }), h("td", { text: "offen" })),
          h("tr", null, h("td", { text: "Name" }), h("td", { text: "fertig" }))
        )
      )
    ),
  ];
}

const stored = (over: Record<string, unknown>) => ({
  id: "00000000-0000-4000-8000-000000000001",
  anchor: { kind: "item", index: 2, excerpt: "Preis- und Abrechnungsmodell für Pulse" },
  text: "Hier brauchen wir eine neue Recherche, Preise verifizieren.",
  actor: "ui",
  created_at: 10,
  state: "open",
  ...over,
});

test("model: list rows carry the open-note count; notes are validated as external data", async () => {
  const m = await load();
  const rows = m.reportRows({
    reports: [
      { id: "r1", title: "A", created_at: 1, notes_open: 2, notes_draft: 1 },
      { id: "r2", title: "B", created_at: 2 },
      { id: "r3", title: "C", created_at: 0, notes_open: 1, notes_draft: 5 },
    ],
  });
  assert.deepEqual(plain(rows.map((r: any) => [r.id, r.notesOpen, r.notesDraft])), [
    ["r2", 0, 0],
    ["r1", 2, 1],
    ["r3", 1, 1],
  ]);
  assert.equal(m.draftReports(rows), 2, "reports with notes not handed over");
  const notes = m.noteRows({
    notes: [
      stored({}),
      stored({ id: "x", state: "done", done_at: 20, reply: "erledigt", updated_at: 15 }),
      stored({ id: "h", handed_at: 12 }),
      stored({ id: "bad-kind", anchor: { kind: "code", index: 1, excerpt: "" } }),
      stored({ id: "bad-index", anchor: { kind: "item", index: 0, excerpt: "" } }),
      stored({ id: "" }),
      null,
    ],
  });
  assert.deepEqual(plain(notes.map((n: any) => [n.id, n.kind, n.index, n.done, n.draft, n.at, n.reply])), [
    ["00000000-0000-4000-8000-000000000001", "item", 2, false, true, 10, ""],
    ["x", "item", 2, true, false, 15, "erledigt"],
    ["h", "item", 2, false, false, 10, ""],
  ]);
  assert.deepEqual(plain(m.noteCounts(notes)), { drafts: 1, handed: 1 }, "without handed_at a note is a draft");
  const at = "Preis- und Abrechnungsmodell für Pulse";
  assert.equal(m.notesAt(notes, "item", 2, at).length, 3);
  assert.equal(m.notesAt(notes, "row", 2, at).length, 0);
  assert.equal(m.excerptOf("  a\n\n b  "), "a b");
  const long = m.excerptOf("x".repeat(400));
  assert.equal(long.length, 160);
  assert.ok(long.endsWith("…"));
});

test("blocks: headings, paragraphs, list items and table body rows are numbered in reading order", async () => {
  const m = await load();
  const blocks = m.reportBlocksIn(rendered());
  assert.deepEqual(
    plain(blocks.map((b: any) => [b.kind, b.index, b.excerpt])),
    [
      ["heading", 1, "Entscheidungen, die bei Daniel liegen"],
      ["item", 2, "Preis- und Abrechnungsmodell für Pulse"],
      ["item", 3, "Name"],
      ["paragraph", 4, "Ein Absatz."],
      ["row", 5, "Preise | offen"],
      ["row", 6, "Name | fertig"],
    ],
    "code blocks and the table head are not annotatable"
  );
});

test("decoration: a button at plain blocks, a card at annotated ones, the open field, lost notes at the end", async () => {
  const m = await load();
  const opened: unknown[] = [];
  const notes = m.noteRows({
    notes: [
      stored({}),
      stored({
        id: "row",
        anchor: { kind: "row", index: 6, excerpt: "Name | fertig" },
        state: "done",
        reply: "Name steht.",
      }),
      stored({ id: "lost", anchor: { kind: "paragraph", index: 99, excerpt: "alter Absatz" }, text: "verloren?" }),
    ],
  });
  const ui = {
    notes,
    editing: { anchor: { kind: "heading", index: 1, excerpt: "x" }, noteId: null, draft: {} },
    open: (a: unknown) => opened.push(a),
    edit() {},
    remove() {},
    save: async () => {},
    cancel() {},
  };
  const nodes = rendered();
  const out = m.annotateReport(nodes, ui);
  const [headCard, list, para, , table, lost] = out.nodes;
  const within = (n: Node_, cls: string) => [n, ...n.all()].filter((x) => x.classList.contains(cls));

  const buttons = out.nodes.flatMap((n: Node_) => within(n, "tk-an__btn"));
  assert.equal(buttons.length, 3, "only the blocks without notes or an open field get the note button");
  assert.equal(buttons[0].attrs.type, "button", "a native button: reachable and usable by keyboard");
  assert.match(buttons[0].attrs["aria-label"], /"excerpt":"Name"/);
  await buttons[1].click();
  assert.deepEqual(plain(opened), [{ kind: "paragraph", index: 4, excerpt: "Ein Absatz." }]);

  // a field opened at a block without notes already forms the card around that block
  assert.ok(headCard.classList.contains("tk-an__card"), "the heading with the open field is wrapped into a card");
  assert.equal(headCard.children[0].tagName, "H3");
  assert.ok(headCard.children[0].classList.contains("tk-an__subj"), "the heading is the card's subject");
  assert.equal(headCard.find("mb-care__note").length, 1, "the vault-care note field");
  assert.equal(headCard.find("cn__improve").length, 1, "with its improve-text button");
  assert.equal(headCard.find("tk-an__more").length, 0, "no second-note action while the field is open there");
  assert.equal(typeof out.focus, "function");

  const item = list.children[0];
  assert.ok(item.classList.contains("tk-an__card"), "the annotated list item is the card");
  assert.ok(item.classList.contains("has-open"));
  assert.equal(within(item, "tk-an__btn").length, 0, "no note button behind an annotated place");
  assert.equal(item.children[0].textContent, "Preis- und Abrechnungsmodell für Pulse", "the item text is the subject");
  assert.match(item.find("tk-an__box")[0].textContent, /Preise verifizieren/);
  assert.match(item.find("tk-an__state")[0].textContent, /^tk\.rep\.note\.draft$/, "not handed over yet");
  assert.ok(item.find("tk-an__note")[0].classList.contains("is-draft"));
  assert.ok(!item.classList.contains("is-done"), "an open note keeps the amber card");
  const more = item.find("tk-an__more");
  assert.equal(more.length, 1, "a further note is added at the bottom of the card");
  assert.match(more[0].textContent, /tk\.rep\.note\.more/);
  await more[0].click();
  assert.deepEqual(plain(opened[1]), { kind: "item", index: 2, excerpt: "Preis- und Abrechnungsmodell für Pulse" });
  assert.equal(list.children[1].find("tk-an__box").length, 0, "no notes, no box");
  assert.ok(!list.children[1].classList.contains("tk-an__card"));
  assert.equal(para.tagName, "P");

  const rows = table.querySelectorAll("tbody tr");
  assert.equal(rows.length, 3, "a note row follows the annotated table row");
  assert.ok(rows[1].classList.contains("is-marked"), "the annotated row is marked");
  assert.ok(rows[1].classList.contains("is-done") && rows[2].classList.contains("is-done"), "all done: done colour");
  assert.equal(within(rows[1], "tk-an__btn").length, 0, "and has no note button");
  assert.equal(rows[1].children.length, 3, "but keeps the button column, so the table stays aligned");
  assert.ok(rows[2].classList.contains("tk-an__tr"));
  assert.equal(rows[2].children[0].attrs.colspan, "3");
  assert.match(rows[2].textContent, /tk\.rep\.note\.done/);
  assert.match(rows[2].find("tk-an__reply")[0].textContent, /tk\.rep\.note\.reply.*Name steht\./);
  assert.equal(rows[2].find("tk-an__more").length, 1);
  assert.equal(table.querySelectorAll("thead tr")[0].children.length, 3, "the head row gets the button column too");

  assert.ok(lost.classList.contains("tk-an__lost"), "a note whose block is gone is still shown");
  assert.equal(lost.find("tk-an__card").length, 1, "as a card of its own");
  assert.match(lost.find("tk-an__subj")[0].textContent, /alter Absatz/);
  assert.match(lost.textContent, /verloren\?/);
});

test("decoration: a handed-over note is 'handed over · open'; a place whose notes are all done turns green", async () => {
  const m = await load();
  const para = { kind: "paragraph", index: 4, excerpt: "Ein Absatz." };
  const notes = m.noteRows({
    notes: [
      stored({ id: "handed", handed_at: 11 }),
      stored({ id: "d1", anchor: para, state: "done", handed_at: 11, done_at: 12 }),
      stored({ id: "d2", anchor: para, state: "done", handed_at: 11, done_at: 13 }),
    ],
  });
  const ui = { notes, editing: null, open() {}, edit() {}, remove() {}, save: async () => {}, cancel() {} };
  const out = m.annotateReport(rendered(), ui);
  const item = out.nodes[1].children[0];
  assert.match(item.find("tk-an__state")[0].textContent, /^tk\.rep\.note\.open$/);
  assert.match(item.find("tk-an__state")[0].attrs.title, /tk\.rep\.note\.openTip/);
  assert.ok(!item.classList.contains("is-done"));
  const card = out.nodes[2];
  assert.ok(card.classList.contains("tk-an__card") && card.classList.contains("is-done"), "all done: done colour");
  assert.deepEqual(
    card.find("tk-an__state").map((n: Node_) => n.textContent),
    ["tk.rep.note.done", "tk.rep.note.done"]
  );
  // a new note being written there is not done yet: the card stays amber meanwhile
  const adding = m.annotateReport(rendered(), { ...ui, editing: { anchor: para, noteId: null, draft: {} } });
  assert.ok(!adding.nodes[2].classList.contains("is-done"));
});

test("decoration: editing a saved note keeps its card, without the second-note action", async () => {
  const m = await load();
  const [note] = m.noteRows({ notes: [stored({ anchor: { kind: "paragraph", index: 4, excerpt: "Ein Absatz." } })] });
  const out = m.annotateReport(rendered(), {
    notes: [note],
    editing: { anchor: { kind: "paragraph", index: 4, excerpt: "Ein Absatz." }, noteId: note.id, draft: {} },
    open() {},
    edit() {},
    remove() {},
    save: async () => {},
    cancel() {},
  });
  const card = out.nodes[2];
  assert.ok(card.classList.contains("tk-an__card"));
  assert.equal(card.children[0].tagName, "P");
  assert.equal(card.find("mb-care__note").length, 1);
  assert.equal(card.find("mb-care__note")[0].value, note.text, "the field holds the saved text");
  assert.equal(card.find("tk-an__more").length, 0);
  assert.equal(card.find("tk-an__btn").length, 0);
});

test("the note field is the vault-care field: improve text, undo, and the same answer without a local model", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  let answer = { status: 200, body: { text: "Preise bitte neu verifizieren." } as unknown };
  const m = await load(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { status: answer.status, json: async () => answer.body };
  });
  const draft: any = {};
  const ed = m.noteEditor({
    value: "äh die preise bitte nochmal checken",
    required: true,
    placeholder: "tk.rep.note.ph",
    saveLabel: "save",
    busyLabel: "saving",
    onSave: async () => {},
    onCancel() {},
    draft,
  });
  assert.equal(ed.el.find("mb-care__note")[0].attrs.placeholder, "tk.rep.note.ph");
  await ed.improve();
  assert.deepEqual(plain(calls), [{ url: "/ui/improve-text", body: { text: "äh die preise bitte nochmal checken" } }]);
  assert.equal(draft.state.text, "Preise bitte neu verifizieren.", "the result is shown for review before saving");
  assert.equal(draft.state.undo, "äh die preise bitte nochmal checken");

  answer = { status: 503, body: { error: "no model" } };
  draft.state = { ...draft.state, undo: null };
  await ed.improve();
  assert.equal(draft.state.error, "mb.improveNoModel", "no local model: same message as in the memory browser");
  assert.equal(draft.state.text, "Preise bitte neu verifizieren.", "the text stays");
});

test("texts: every key the notes use exists in German and English", async () => {
  const strings = async (lang: string): Promise<Record<string, string>> =>
    runInNewContext(
      `(${(await read(`i18n/tasks-${lang}.js`)).replace(/^export default\s*/m, "").replace(/;\s*$/, "")})`,
      {}
    );
  const sources = (await read("sections/tasks-report-notes.js")) + (await read("sections/tasks-reports.js"));
  const keys = [...new Set([...sources.matchAll(/"(tk\.rep\.note\.[\w.]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length >= 10, keys.join(", "));
  for (const lang of ["de", "en"]) {
    const table = await strings(lang);
    for (const key of keys) assert.equal(typeof table[key], "string", `${key} in tasks-${lang}`);
  }
  const noteKeys = async (lang: string) =>
    Object.keys(await strings(lang))
      .filter((k) => k.startsWith("tk.rep.note."))
      .sort();
  assert.deepEqual(await noteKeys("de"), await noteKeys("en"), "the note texts exist in both languages");
});

/** The reading view's real Markdown renderer (views/markdown.js plus the table renderer). */
async function realRenderer(): Promise<{ render: (md: string) => Node_[] }> {
  const reports = await read("sections/tasks-reports.js");
  const pick = (src: string, re: RegExp) => re.exec(src)?.[0] ?? assert.fail(`not found: ${re}`);
  return runInNewContext(
    [
      strip(await read("views/code-lines.js")),
      strip(await read("sections/tasks-reports-model.js")),
      strip(await read("views/inline-scan.js")),
      strip(await read("views/markdown.js")),
      pick(reports, /function table\(b\) \{[\s\S]*?\n\}/),
      "({ render: (md) => reportBlocks(md).flatMap((b) => (b.kind === 'table' ? [table(b)] : markdown(b.text, () => {}))) })",
    ].join("\n"),
    { h, vault: () => null }
  );
}

test("numbering with the real renderer: nested lists, quotes, code, blank lines and a table with head", async () => {
  const m = await load();
  const renderer = await realRenderer();
  const md = [
    "# Titel",
    "",
    "Absatz eins.",
    "> Zitat",
    "",
    "- a",
    "  - a.1 (eingerückt)",
    "1. b",
    "",
    "```",
    "# kein Kopf",
    "| x | y |",
    "|---|---|",
    "| 1 | 2 |",
    "```",
    "",
    "| Punkt | Stand |",
    "|---|---|",
    "| Preise | offen |",
    "| Name | **fertig** |",
    "",
    "## Ende",
  ].join("\n");
  const blocks = m.reportBlocksIn(renderer.render(md));
  assert.deepEqual(
    plain(blocks.map((b: any) => [b.kind, b.index, b.excerpt])),
    [
      ["heading", 1, "Titel"],
      ["paragraph", 2, "Absatz eins."],
      ["paragraph", 3, "> Zitat"],
      ["item", 4, "a"],
      ["item", 5, "a.1 (eingerückt)"],
      ["item", 6, "b"],
      ["row", 7, "Preise | offen"],
      ["row", 8, "Name | **fertig**"],
      ["heading", 9, "Ende"],
    ],
    "code (with a table in it) and the table head are skipped; every other block counts once, in order"
  );
  // The same body renders the same numbers again: a stored anchor lands on its block.
  const again = m.reportBlocksIn(renderer.render(md));
  assert.deepEqual(plain(again.map((b: any) => b.excerpt)), plain(blocks.map((b: any) => b.excerpt)));
});

test("a free-standing ---, *** or ___ line is a thin rule: no note place, no question, no jump target", async () => {
  const m = await load();
  const renderer = await realRenderer();
  const md = [
    "---",
    "Intro.",
    "",
    "---",
    "",
    "## Frage",
    "",
    "Ship it? [? Yes | No]",
    "",
    "***",
    "",
    "  _ _ _  ",
    "",
    "Text right above",
    "---",
    "- - -x",
  ].join("\n");
  const nodes = renderer.render(md);
  assert.deepEqual(
    plain(nodes.map((n) => [n.tagName, n.textContent])),
    [
      ["HR", ""],
      ["P", "Intro."],
      ["HR", ""],
      ["H3", "Frage"],
      ["P", "Ship it? [? Yes | No]"],
      ["HR", ""],
      ["HR", ""],
      ["P", "Text right above"],
      ["P", "---"],
      ["UL", "- -x"],
    ],
    "only a rule line after a blank line (or at the start) becomes a line; under a text line it stays text"
  );
  const ui = { notes: [], editing: null, open() {}, edit() {}, remove() {}, save: async () => {}, cancel() {} };
  const out = m.annotateReport(nodes, ui);
  assert.ok(
    out.nodes.filter((n: Node_) => n.tagName === "HR").every((n: Node_) => !n.classList.contains("tk-an")),
    "a rule is no note place"
  );
  assert.deepEqual(plain(out.toc.heads.map((x: any) => x.text)), ["Frage"]);
  assert.deepEqual(plain(out.toc.asks.map((x: any) => x.index)), [3], "the question keeps its number");
});

test("#1608: a note sits at its place only while the place still holds the stored excerpt", async () => {
  const m = await load();
  const notes = m.noteRows({
    notes: [
      stored({}),
      // same kind and number, but the block there now holds other text (a changed renderer)
      stored({ id: "moved", anchor: { kind: "item", index: 3, excerpt: "Preis" }, text: "gehört woanders hin" }),
    ],
  });
  const ui = { notes, editing: null, open() {}, edit() {}, remove() {}, save: async () => {}, cancel() {} };
  const out = m.annotateReport(rendered(), ui);
  const [, list] = out.nodes;
  assert.match(list.children[0].textContent, /Preise verifizieren/, "a matching excerpt: the note at its place");
  assert.ok(!list.children[1].classList.contains("tk-an__card"), "item 3 ('Name') does not take the other note");
  const lost = out.nodes.at(-1);
  assert.ok(lost.classList.contains("tk-an__lost"));
  assert.match(lost.textContent, /gehört woanders hin/, "it is collected at the end instead");
  assert.equal(plain(m.notesAt(notes, "item", 2, "Preis- und Abrechnungsmodell für Pulse")).length, 1);
  assert.equal(plain(m.notesAt(notes, "item", 3, "Name")).length, 0);
});

test("N6/N29: answer options are fixed syntax at the end of a line, in any language; anything else stays text", async () => {
  const m = await load();
  const ask = (s: string) => plain(m.askOf(s));
  assert.deepEqual(ask("Ship it now? [? Yes | No]"), { question: "Ship it now?", options: ["Yes", "No"], at: 13 });
  assert.deepEqual(ask("Jetzt ausliefern? [?Ja|Nein|Später]  ").options, ["Ja", "Nein", "Später"]);
  assert.deepEqual(ask("现在发布吗？ [? 是 | 否]").options, ["是", "否"], "no word lists: every language works");
  for (const text of [
    "Ship it? Yes or no",
    "Ship it? [? Yes]",
    "Ship it? [? Yes | ]",
    "Ship it? [? Yes | Yes]",
    "Ship it? [? a | b | c | d | e | f | g]",
    // a whole paragraph as an option: the line stays text, nothing is cut (Daniel 18.11.2026)
    `Ship it? [? ${"x".repeat(121)} | No]`,
    "[? Yes | No]",
    "Ship it? [? Yes | No] later",
    "Ship it? [Yes | No]",
    "Ship it? [? [a] | b]",
  ])
    assert.equal(m.askOf(text), null, text);
  assert.equal(ask(`Ship it? [? A – ${"x".repeat(116)} | No]`).options[0].length, 120, "120 characters still fit");
  // the real lines that showed no buttons with the old 40-character limit (Daniel 25.11.2026)
  for (const line of [
    "**Deine Antwort:** [? A – Bei der Messung mitzählen, dann entscheiden | B – Nicht weiter verfolgen]",
    "**Deine Antwort:** [? A – In 1.3.0 bauen | B – Erst in der eigenen Sitzung besprechen]",
    "**Deine Antwort:** [? A – Modellmeinung erst danach (wie gebaut) | B – Vorher zeigen]",
    "**Deine Antwort:** [? A – Die 18 deutlichen zeigen, ich entscheide | B – So lassen]",
    "**Deine Antwort:** [? A – Minute beibehalten | B – Als Einstellung für große Vaults prüfen]",
  ])
    assert.equal(ask(line).options.length, 2, line);
});

test("N6/N29: the tool agents file reports with teaches the syntax the reading view understands", async () => {
  const m = await load();
  const { taskTools } = await import("../src/task-transport.js");
  const desc = taskTools.find((x) => x.name === "task_report_save")!.description;
  const examples = [...desc.matchAll(/\[\?[^\]]*\]/g)].map((x) => x[0]);
  assert.ok(examples.length >= 2, "the description shows the syntax");
  for (const marker of examples) assert.ok(m.askOf(`Question? ${marker}`), `${marker} is understood`);
  for (const doc of ["Proactive Tasks.md", "Proaktive Aufgaben.md"]) {
    const text = await readFile(new URL(`../../../docs/${doc}`, import.meta.url), "utf8");
    const lines = [...text.matchAll(/^- .*\[\?[^\]]*\]$/gm)].map((x) => x[0].slice(2));
    assert.equal(lines.length, 2, `${doc}: two examples`);
    for (const line of lines) assert.ok(m.askOf(line), `${doc}: ${line}`);
  }
});

test("standalone options in stored reports get buttons and an outline entry without moving notes", async () => {
  const m = await load();
  const renderer = await realRenderer();
  const { asksOwner, questionCheck } = await import("../src/task-report-status.js");
  const body =
    "# Timing\n\n- Keep the reminder at one minute?\n\n[? A – Keep it | B – Make it configurable]\n\nLater text.";
  const anchor = { kind: "paragraph", index: 3, excerpt: "[? A – Keep it | B – Make it configurable]" };
  const notes = m.noteRows({ notes: [stored({ anchor: { kind: "paragraph", index: 4, excerpt: "Later text." } })] });
  const answers: unknown[][] = [];
  const ui = {
    notes,
    editing: null,
    open() {},
    edit() {},
    remove() {},
    save: async () => {},
    answer: (...args: unknown[]) => answers.push(args),
    cancel() {},
  };
  const out = m.annotateReport(renderer.render(body), ui);
  assert.deepEqual(plain(out.toc.asks.map((x: any) => [x.index, x.text])), [[3, "Timing"]]);
  assert.match(out.nodes[3].textContent, /Preise verifizieren/);
  assert.equal(out.nodes.length, 4, "the existing later note remains attached");
  await out.nodes[2].find("tk-ask__opt")[0].click();
  assert.deepEqual(plain(answers), [[anchor, "A – Keep it", null]]);
  assert.equal(asksOwner(body), true);
  assert.deepEqual(questionCheck(body), { asks: 1, unread: [] });
  for (const isolated of [
    "[? A | B]",
    "Text\n\n---\n\n[? A | B]",
    "Text\n\n```\nexample\n```\n\n[? A | B]",
    "Text\n\n| A | B |\n|---|---|\n| U | V |\n\n[? A | B]",
  ]) {
    assert.equal(m.annotateReport(renderer.render(isolated), ui).toc.asks.length, 0, isolated);
    assert.deepEqual(questionCheck(isolated), { asks: 0, unread: ["[? A | B]"] }, isolated);
  }
});

test("N6/N29: a question shows its options, own answer and clarification; a click saves a note at that place", async () => {
  const m = await load();
  const renderer = await realRenderer();
  const nodes = renderer.render(
    [
      "- Keep the compatibility note? [? Keep | Remove]",
      "- Plain item [? only one]",
      "- With code `[? a | b]`",
      "",
      "Release now? [? Yes | No]",
    ].join("\n")
  );
  const answered: unknown[] = [],
    opened: unknown[] = [];
  const ui = {
    notes: [],
    editing: null,
    open: (a: unknown) => opened.push(a),
    answer: (a: unknown, text: string, id: unknown) => answered.push([a, text, id]),
    edit() {},
    remove() {},
    save: async () => {},
    cancel() {},
  };
  const out = m.annotateReport(nodes, ui);
  const [list, para] = out.nodes;
  const [question, single, code] = list.children;
  assert.equal(question.children[0].textContent, "Keep the compatibility note?", "the marker leaves the text");
  const group: Node_ = question.find("tk-ask")[0] ?? assert.fail("no answer buttons");
  assert.equal(group.attrs.role, "group");
  const buttons = group.find("tk-ask__opt");
  // one row of equal fields (draft D): the options with the letter of their place, then own answer
  // and clarification in the same form with a sign instead of a letter
  assert.deepEqual(
    group.children.map((b) => [b.find("tk-ask__key")[0].textContent, b.find("tk-ask__name")[0].textContent]),
    [
      ["A", "Keep"],
      ["B", "Remove"],
      ["…", "tk.rep.ask.free"],
      ["?", "tk.rep.ask.clarify"],
    ]
  );
  assert.equal(buttons.length, 4, "every field is a button straight in the group");
  assert.ok(
    buttons.every((b) => b.attrs["aria-pressed"] === "false"),
    "nothing chosen yet"
  );
  assert.equal(question.find("tk-an__btn").length, 0, "the options replace the plain note button");
  for (const [el, text] of [
    [single, "Plain item [? only one]"],
    [code, "With code [? a | b]"],
  ] as const) {
    assert.equal(el.find("tk-ask").length, 0, `${text}: no question`);
    assert.match(el.textContent, /\[\?/, "the text stays as it was");
    assert.equal(el.find("tk-an__btn").length, 1);
  }
  assert.equal(para.find("tk-ask").length, 1, "a paragraph can ask too");

  await buttons[1].click();
  await buttons[3].click();
  await buttons[2].click();
  const anchor = { kind: "item", index: 1, excerpt: "Keep the compatibility note? [? Keep | Remove]" };
  assert.deepEqual(plain(answered), [
    [anchor, "Remove", null],
    [anchor, "tk.rep.ask.clarifyNote", null],
  ]);
  assert.deepEqual(plain(opened), [anchor], "own answer opens the note field there");
});

test("an answered question keeps its answer area in the card with the choice pressed; another choice rewrites it", async () => {
  // Daniel 18.11.2026: everything stays open, the options stay visible
  const m = await load();
  const renderer = await realRenderer();
  const answered: unknown[] = [];
  const ui = {
    notes: [],
    editing: null,
    open() {},
    answer: (a: unknown, text: string, id: unknown) => answered.push([a, text, id]),
    edit() {},
    remove() {},
    save: async () => {},
    cancel() {},
  };
  const anchor = { kind: "item", index: 1, excerpt: "Keep the compatibility note? [? Keep | Remove]" };
  const again = m.annotateReport(renderer.render("- Keep the compatibility note? [? Keep | Remove]"), {
    ...ui,
    notes: m.noteRows({ notes: [stored({ anchor, text: "Remove" })] }),
  });
  const card: Node_ = again.nodes[0].children[0];
  assert.ok(card.classList.contains("tk-an__card"));
  assert.deepEqual(
    card.children.map((n) => n.className.split(" ")[0]),
    ["tk-an__subj", "tk-ask", "tk-an__box"]
  );
  assert.equal(card.find("tk-an__subj")[0].textContent, "Keep the compatibility note?");
  assert.equal(card.find("tk-an__text")[0].textContent, "Remove");
  const opts = card.find("tk-ask__opt");
  assert.deepEqual(
    opts.map((b) => [b.find("tk-ask__name")[0].textContent, b.attrs["aria-pressed"], b.classList.contains("is-on")]),
    [
      ["Keep", "false", false],
      ["Remove", "true", true],
      ["tk.rep.ask.free", "false", false],
      ["tk.rep.ask.clarify", "false", false],
    ]
  );
  await opts[1].click();
  assert.deepEqual(answered, [], "the chosen option again changes nothing");
  await opts[0].click();
  await opts[3].click();
  assert.deepEqual(
    plain(answered),
    [
      [anchor, "Keep", "00000000-0000-4000-8000-000000000001"],
      [anchor, "tk.rep.ask.clarifyNote", "00000000-0000-4000-8000-000000000001"],
    ],
    "another choice rewrites the earlier one instead of adding a second note"
  );

  // an own answer marks "own answer"; clarification marks itself
  const own = m.annotateReport(renderer.render("- Keep the compatibility note? [? Keep | Remove]"), {
    ...ui,
    notes: m.noteRows({ notes: [stored({ anchor, text: "Only for one more release." })] }),
  });
  assert.deepEqual(
    (own.nodes[0] as Node_).find("tk-ask__opt").map((b) => b.attrs["aria-pressed"]),
    ["false", "false", "true", "false"]
  );
});

test("outline: annotateReport lists headings and questions with their answered state, by structure only", async () => {
  const m = await load();
  const renderer = await realRenderer();
  const nodes = renderer.render(
    [
      "# Summary",
      "Text.",
      "## Questions",
      "- 质量? [? 是 | 否]",
      "- Ship? [? A – Ship now | B – Wait]",
      "- Not a question [? only]",
    ].join("\n")
  );
  const anchor = { kind: "item", index: 5, excerpt: "Ship? [? A – Ship now | B – Wait]" };
  const ui = {
    notes: m.noteRows({ notes: [stored({ anchor, text: "B – Wait" })] }),
    editing: null,
    open() {},
    answer() {},
    edit() {},
    remove() {},
    save: async () => {},
    cancel() {},
  };
  const out = m.annotateReport(nodes, ui);
  assert.deepEqual(plain(out.toc.heads.map((e: { text: string; index: number }) => [e.text, e.index])), [
    ["Summary", 1],
    ["Questions", 3],
  ]);
  assert.deepEqual(
    plain(out.toc.asks.map((e: { text: string; index: number; answered: boolean }) => [e.text, e.index, e.answered])),
    [
      ["Questions", 4, false],
      ['tk.rep.toc.askAt {"n":2,"q":"Ship?"}', 5, true],
    ]
  );
  for (const e of [...out.toc.heads, ...out.toc.asks]) assert.ok(e.el, "every entry knows its place");
});

test("outline: a question is named after the nearest heading before it that no earlier question took", async () => {
  // Daniel 18.11.2026: not "Your answer" three times. By structure only: the answer line starts with
  // the same words under every question, so its own text names nothing
  const m = await load();
  const renderer = await realRenderer();
  const nodes = renderer.render(
    [
      "Intro: [? Yes | No]",
      "## Rules",
      "### F2 – What happens to an **expired** rule?",
      "Some text.",
      "- **Your answer:** [? A – Hide | B – Keep]",
      "### F5 – Why the length again?",
      "Your answer: [? A | B]",
      "Your answer: [? C | D]",
    ].join("\n\n")
  );
  const ui = {
    notes: [],
    editing: null,
    open() {},
    answer() {},
    edit() {},
    remove() {},
    save: async () => {},
    cancel() {},
  };
  const out = m.annotateReport(nodes, ui);
  assert.deepEqual(plain(out.toc.asks.map((e: { text: string }) => e.text)), [
    'tk.rep.toc.askAt {"n":1,"q":"Intro:"}',
    "F2 – What happens to an expired rule?",
    "F5 – Why the length again?",
    'tk.rep.toc.askAt {"n":4,"q":"Your answer:"}',
  ]);
});

test("model: optionParts takes an option's own key ('A – Keep'), else the letter of its place", async () => {
  const m = await load();
  assert.deepEqual(plain(m.optionParts("A – Ja, ausblenden", 0)), { key: "A", name: "Ja, ausblenden" });
  assert.deepEqual(plain(m.optionParts("B2 - Wait", 0)), { key: "B2", name: "Wait" });
  assert.deepEqual(plain(m.optionParts("是", 1)), { key: "B", name: "是" });
  assert.deepEqual(plain(m.optionParts("Ship – now or later", 2)), { key: "C", name: "Ship – now or later" });
});

test("model: answerAt finds the choice and own answers; hereIndex picks the place being read", async () => {
  const m = await load();
  const notes = (...texts: string[]) => texts.map((text) => ({ text, id: text }));
  const at = (n: ReturnType<typeof notes>) => plain(m.answerAt(["A", "B"], n, "?!"));
  assert.deepEqual(at([]), { picked: null, pick: null, own: false });
  assert.deepEqual(at(notes("A", "B")), { picked: "B", pick: { text: "B", id: "B" }, own: false }, "the latest");
  assert.deepEqual(at(notes("?!")).picked, "?!");
  assert.deepEqual(at(notes("my own")), { picked: null, pick: null, own: true });
  assert.equal(m.hereIndex([], 100), -1);
  assert.equal(m.hereIndex([300, 500], 100), 0, "the first place before any has passed");
  assert.equal(m.hereIndex([-400, 40, 90, 300], 100), 2);
});

const noUi = { notes: [], editing: null, open() {}, edit() {}, remove() {}, save: async () => {}, cancel() {} };

test("#1656/#1652: the daemon's question status and the reader's answer buttons follow one contract", async () => {
  const m = await load();
  const renderer = await realRenderer();
  const { asksOwner } = await import("../src/task-report-status.js");
  const corpus: [string, boolean][] = [
    ["Ship it? [? Yes | No]", true],
    [`Ship it? [? ${"x".repeat(120)} | No]`, true],
    [`Ship it? [? ${"x".repeat(121)} | No]`, false],
    ["**Deine Antwort:** [? A – Bei der Messung mitzählen, dann entscheiden | B – Nicht weiter verfolgen]", true],
    ["Ship it? [? Yes | Yes]", false],
    ["Ship it? [? Yes]", false],
    ["- Ship it? [? Yes | No]", true],
    ["1. Ship it? [? Yes | No]", true],
    ["- [? Yes | No]", false],
    ["## Ship it? [? Yes | No]", false],
    ["#Ship it? [? Yes | No]", true],
    ["| Ship it? [? Yes | No]", true],
    ["| Ship it? | Yes or no |\n|---|---|\n| [? Yes | No] | b |", false],
    ["```\nShip it? [? Yes | No]\n```", false],
    ["```\ncode\n```\nShip it? [? Yes | No]", true],
    ["Ship it? `[? Yes | No]`", false],
    ["Ship it? `code` [? Yes | No]", true],
    ["Ship it? [? `Yes` | No]", false],
    ["Ship it? [? **Yes** | No]", false],
    ["Literal \\[? Yes | No]", false],
    ["Ship it? [? Yes | No] <!-- marker -->", true],
    // #1665/#1662: indented code and an indented fence are code; list text and a lazy line are not
    ["Text\n\n    Ship it? [? Yes | No]", false],
    ["Text\n\n\tShip it? [? Yes | No]", false],
    ["- step\n  ```\n  Ship it? [? Yes | No]\n  ```", false],
    ["Text\n    Ship it? [? Yes | No]", true],
    ["- item\n\n    Ship it? [? Yes | No]", true],
    ["Text\n\n    code\nShip it? [? Yes | No]", true],
    // #1665: the prose under a pipe table is a piece of its own for the reader and the status
    ["Intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n    Ship it? [? Yes | No]", false],
    ["- item\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n\n    Ship it? [? Yes | No]", false],
    ["| a | b |\n|---|---|\n| 1 | 2 |\nShip it? [? Yes | No]", true],
    // #1671: a bare address before the marker ends before its trailing punctuation, for both alike
    ["Open http://127.0.0.1:6723/ui/, then: ship it? [? Yes | No]", true],
    ["Ship it, see http://a/b? [? Yes | No]", true],
    ["Ship it? http://a/b[? Yes | No]", false],
    // #1717: a marker joined to the text before it is a literal; a space or a line of its own asks
    ["Use Matrix[?a|b] here: Matrix[?a|b]", false],
    ["Ship it?[? Yes | No]", false],
    ["**Ship it?**[? Yes | No]", false],
    ["**Ship it?** [? Yes | No]", true],
    ["Ship it? [?a|b]", true],
    ["Ship it?\n[? Yes | No]", true],
    ["Ship it?\n\n[? Yes | No]", true],
  ];
  for (const [body, want] of corpus) {
    const shown = m.annotateReport(renderer.render(body), noUi).toc.asks.length > 0;
    assert.equal(shown, want, `reader: ${body}`);
    assert.equal(asksOwner(body), want, `daemon: ${body}`);
  }
});

test("#1652: an escaped marker stays text, shown without its backslash; a normal one still asks", async () => {
  const m = await load();
  const renderer = await realRenderer();
  const out = m.annotateReport(
    renderer.render(["Literal \\[? Yes | No]", "", "- Item \\[? A | B]", "", "Ship it? [? Yes | No]"].join("\n")),
    noUi
  );
  const [literal, list, asked] = out.nodes;
  assert.equal(literal.find("tk-ask").length, 0, "no answer buttons");
  assert.match(literal.textContent, /^Literal \[\? Yes \| No\]tk\.rep\.note\.add$/, "shown as written, no backslash");
  assert.equal(literal.find("tk-an__btn").length, 1, "a plain place with the note button");
  assert.match(list.children[0].textContent, /^Item \[\? A \| B\]tk\.rep\.note\.add$/);
  assert.equal(list.find("tk-ask").length, 0);
  assert.equal(asked.find("tk-ask").length, 1, "a normal marker still asks");
  assert.equal(out.toc.asks.length, 1);
  assert.equal(m.askOf("Literal \\[? Yes | No]"), null);
});

test("#1717: a marker joined to the word before it is shown as written, without buttons or outline entry", async () => {
  const m = await load();
  const renderer = await realRenderer();
  const out = m.annotateReport(renderer.render(["Read the Matrix[?a|b]", "", "- Item[? A | B]"].join("\n")), noUi);
  const [literal, list] = out.nodes;
  assert.equal(literal.find("tk-ask").length + list.find("tk-ask").length, 0, "no answer buttons");
  assert.match(literal.textContent, /^Read the Matrix\[\?a\|b\]tk\.rep\.note\.add$/, "the literal stays in the text");
  assert.equal(out.toc.asks.length, 0, "no outline entry");
  assert.deepEqual(plain(m.askOf("Read the Matrix [?a|b]")).options, ["a", "b"], "with a space it asks");
});
