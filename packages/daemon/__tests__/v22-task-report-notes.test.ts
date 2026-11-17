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

const read = (path: string) => readFile(new URL(`../webui/v22/js/${path}`, import.meta.url), "utf8");
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const strip = (source: string) => source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "");

// ── a fake DOM: just what dom.js h(), markdown output and the decoration use ──
class Node_ {
  tagName: string;
  children: Node_[] = [];
  parent: Node_ | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(e?: unknown) => unknown>> = {};
  own = "";
  value = "";
  readOnly = false;
  disabled = false;
  hidden = false;
  style = { setProperty() {}, height: "" };
  private set = new Set<string>();
  classList = {
    add: (...c: string[]) => c.forEach((x) => this.set.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.set.delete(x)),
    toggle: (c: string, on: boolean) => (on ? this.set.add(c) : this.set.delete(c)),
    contains: (c: string) => this.set.has(c),
  };
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get className() {
    return [...this.set].join(" ");
  }
  set className(v: string) {
    this.set = new Set(v.split(" ").filter(Boolean));
  }
  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.own = String(v);
    this.children = [];
  }
  get isConnected() {
    return false;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(ev: string, fn: (e?: unknown) => unknown) {
    (this.listeners[ev] ||= []).push(fn);
  }
  append(...nodes: Array<Node_ | string>) {
    for (const n of nodes) {
      const node = typeof n === "string" ? Object.assign(new Node_("#text"), { own: n }) : n;
      node.parent = this;
      this.children.push(node);
    }
  }
  after(node: Node_) {
    const siblings = this.parent!.children;
    siblings.splice(siblings.indexOf(this) + 1, 0, node);
    node.parent = this.parent;
  }
  all(): Node_[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelectorAll(sel: string) {
    const [outer, inner] = sel.split(" ").map((s) => s.toUpperCase());
    return this.all()
      .filter((n) => n.tagName === outer)
      .flatMap((n) => n.all().filter((c) => c.tagName === inner));
  }
  find(cls: string) {
    return this.all().filter((n) => n.classList.contains(cls));
  }
  click() {
    return Promise.all((this.listeners.click ?? []).map((fn) => fn()));
  }
  scrollIntoView() {}
  focus() {}
}

const present = (v: unknown) => v !== undefined && v !== null && v !== false;

function applyProp(el: Node_, k: string, v: any) {
  if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn as never);
  else if (k === "text") el.textContent = v;
  else if (k === "cls") el.classList.add(...String(v).split(" ").filter(Boolean));
  else el.setAttribute(k, String(v));
}

function h(tag: string, props: Record<string, any> | null, ...children: unknown[]) {
  const [name, ...classes] = tag.split(".");
  const el = new Node_(name || "div");
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(props ?? {})) if (present(v)) applyProp(el, k, v);
  for (const c of children.flat(Infinity as 1)) if (present(c)) el.append(c as Node_);
  return el;
}

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
      "\n({ reportRows, noteRows, excerptOf, notesAt, reportBlocksIn, annotateReport, noteEditor })",
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
      { id: "r1", title: "A", created_at: 1, notes_open: 2 },
      { id: "r2", title: "B", created_at: 2 },
    ],
  });
  assert.deepEqual(plain(rows.map((r: any) => [r.id, r.notesOpen])), [
    ["r2", 0],
    ["r1", 2],
  ]);
  const notes = m.noteRows({
    notes: [
      stored({}),
      stored({ id: "x", state: "done", done_at: 20, reply: "erledigt", updated_at: 15 }),
      stored({ id: "bad-kind", anchor: { kind: "code", index: 1, excerpt: "" } }),
      stored({ id: "bad-index", anchor: { kind: "item", index: 0, excerpt: "" } }),
      stored({ id: "" }),
      null,
    ],
  });
  assert.deepEqual(plain(notes.map((n: any) => [n.id, n.kind, n.index, n.done, n.at, n.reply])), [
    ["00000000-0000-4000-8000-000000000001", "item", 2, false, 10, ""],
    ["x", "item", 2, true, 15, "erledigt"],
  ]);
  assert.equal(m.notesAt(notes, "item", 2).length, 2);
  assert.equal(m.notesAt(notes, "row", 2).length, 0);
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

test("decoration: a note button per block, saved notes below their block, the open field, lost notes at the end", async () => {
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
  const [heading, editorBox, list, para, , table, lost] = out.nodes;

  const buttons = out.nodes
    .flatMap((n: Node_) => [n, ...n.all()])
    .filter((n: Node_) => n.classList.contains("tk-an__btn"));
  assert.equal(buttons.length, 6, "one button per annotatable block");
  assert.equal(buttons[0].attrs.type, "button", "a native button: reachable and usable by keyboard");
  assert.match(buttons[1].attrs["aria-label"], /Preis- und Abrechnungsmodell/);
  await buttons[1].click();
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [
    { kind: "item", index: 2, excerpt: "Preis- und Abrechnungsmodell für Pulse" },
  ]);

  assert.equal(heading.tagName, "H3");
  assert.ok(editorBox.classList.contains("tk-an__box"), "the open field sits right below the heading");
  assert.equal(editorBox.find("mb-care__note").length, 1, "the vault-care note field");
  assert.equal(editorBox.find("cn__improve").length, 1, "with its improve-text button");
  assert.equal(typeof out.focus, "function");

  const item = list.children[0];
  assert.ok(item.classList.contains("has-open"));
  assert.match(item.find("tk-an__box")[0].textContent, /Preise verifizieren/);
  assert.equal(list.children[1].find("tk-an__box").length, 0, "no notes, no box");
  assert.equal(para.tagName, "P");

  const rows = table.querySelectorAll("tbody tr");
  assert.equal(rows.length, 3, "a note row follows the annotated table row");
  assert.ok(rows[2].classList.contains("tk-an__tr"));
  assert.equal(rows[2].children[0].attrs.colspan, "3");
  assert.match(rows[2].textContent, /tk\.rep\.note\.done/);
  assert.match(rows[2].textContent, /Name steht\./);
  assert.equal(table.querySelectorAll("thead tr")[0].children.length, 3, "the head row gets the button column too");

  assert.ok(lost.classList.contains("tk-an__lost"), "a note whose block is gone is still shown");
  assert.match(lost.textContent, /alter Absatz/);
  assert.match(lost.textContent, /verloren\?/);
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
});

test("Escape closes an open note field before it closes the report view", async () => {
  const src = await read("sections/tasks-reports.js");
  const esc = /export function escapeReports\(\) \{[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
  assert.match(esc, /if \(R\.edit\) notesUi\.cancel\(\);\s*else closeReports\(\);/);
});

test("numbering with the real renderer: nested lists, quotes, code, blank lines and a table with head", async () => {
  const m = await load();
  const mb = await read("views/memory-browser.js");
  const reports = await read("sections/tasks-reports.js");
  const pick = (src: string, re: RegExp) => re.exec(src)?.[0] ?? assert.fail(`not found: ${re}`);
  const renderer = runInNewContext(
    [
      strip(await read("sections/tasks-reports-model.js")),
      pick(mb, /const INLINE =[\s\S]*?;\n/),
      pick(mb, /function inline\(text, onLink\) \{[\s\S]*?\n\}/),
      pick(mb, /export function markdown\(md, onLink\) \{[\s\S]*?\n\}/).replace(/^export /, ""),
      pick(reports, /function table\(b\) \{[\s\S]*?\n\}/),
      "({ render: (md) => reportBlocks(md).flatMap((b) => (b.kind === 'table' ? [table(b)] : markdown(b.text, () => {}))) })",
    ].join("\n"),
    { h, vault: () => null }
  );
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
