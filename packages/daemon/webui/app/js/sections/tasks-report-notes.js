// Tasks › Reports — notes on single places of a report (Daniel 17.11.2026):
// while reading, the owner leaves a note on a heading, paragraph, list item or
// table row ("research the prices again", "this is how it should be"). A note
// is a draft until the owner hands the report's drafts over ("Hand over to
// agent" in the reader's head); the next agent session is then told about them
// (daemon: task-report-notice.ts), acts on them and marks each one done with a
// short reply shown here. Badge per note: draft · handed over, open · done.
// A block without notes gets a small "note" button (shown on hover / focus only).
// A block with notes, or with an open note field, becomes a framed card: the
// report text on top, its notes below, "+ another note" at the bottom (Daniel
// 17.11.2026: a thin edge alone did not set the note apart from the report).
// Table rows are marked and get their notes in a full-width row right below.
// The note field is the vault-care field with "improve text" (views/care-note.js).
// A note whose block is no longer found (another renderer: kind, number or
// excerpt differ, #1608) is listed at the end as a card of its own, never lost. Report and note texts are external data:
// text nodes only.
// A list item or paragraph that ends with answer options "[? Yes | No]" (askOf, Daniel 18.11.2026)
// shows them as buttons instead of the "note" button, plus "own answer" (the note field) and "needs
// clarification", together one framed answer area. A click saves the choice as an ordinary note on
// that place; once answered, the place is a card like any other and the answer area stays in it
// with the choice marked in amber (Daniel 18.11.2026: everything stays open, the options stay
// visible). Another option then rewrites that note instead of adding a second one.
// annotateReport also returns the report's outline for the jump list in the right panel
// (tasks-reports-toc.js): its headings and its questions with their answered state.
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { noteEditor } from "../views/care-note.js";
import { fmtAt } from "./tasks-api.js";
import { excerptOf, notesAt, askOf, unescapeAsk, answerAt, optionParts } from "./tasks-reports-model.js";

/** The annotatable blocks of the rendered report in reading order (as markdown() and the
 *  table renderer build them): headings, paragraphs, list items, table body rows. */
export function reportBlocksIn(nodes) {
  const out = [];
  let previous = "";
  const prose = (el, kind) => {
    out.push({ el, kind, previous });
    previous = el.textContent;
  };
  for (const n of nodes) {
    if (n.tagName === "P") prose(n, "paragraph");
    else if (n.tagName === "UL") for (const li of [...n.children]) prose(li, "item");
    else {
      previous = "";
      if (n.tagName === "H3") out.push({ el: n, kind: "heading" });
      else if (n.classList?.contains("tk-rep__tbl"))
        for (const tr of [...n.querySelectorAll("tbody tr")]) out.push({ el: tr, kind: "row" });
    }
  }
  return out.map((b, i) => ({
    ...b,
    index: i + 1,
    excerpt: excerptOf(b.kind === "row" ? [...b.el.children].map((c) => c.textContent).join(" | ") : b.el.textContent),
  }));
}

const sameAnchor = (edit, kind, index) => edit && edit.anchor.kind === kind && edit.anchor.index === index;

/** One saved note: state badge, time, quiet text actions; the agent's reply under it once done. */
function savedNote(n, ui) {
  const state = n.done ? "done" : n.draft ? "draft" : "open";
  const agentText = n.done ? n.reply : n.draft ? "" : n.progress;
  return h(
    "div.tk-an__note",
    { cls: `is-${state}` },
    h(
      "div.tk-an__head",
      null,
      h("span.tk-an__state", { text: t(`tk.rep.note.${state}`), title: t(`tk.rep.note.${state}Tip`) }),
      h("span.tk-an__at", { text: fmtAt(n.at) }),
      h(
        "span.tk-an__acts",
        null,
        h("button.tk-an__act", { type: "button", text: t("tk.rep.note.edit"), on: { click: () => ui.edit(n) } }),
        h("button.tk-an__act", { type: "button", text: t("tk.rep.note.delete"), on: { click: () => ui.remove(n) } })
      )
    ),
    h("div.tk-an__text", { text: n.text }),
    agentText
      ? h(
          "div.tk-an__reply",
          null,
          h("div.tk-an__rk", { text: t(n.done ? "tk.rep.note.reply" : "tk.rep.note.progress") }),
          h("div.tk-an__rtext", { text: agentText })
        )
      : null
  );
}

/** The note field: a new note (noteId null) or a saved one being rewritten. */
function editor(ui, value, out) {
  const ed = noteEditor({
    value,
    required: true,
    placeholder: t("tk.rep.note.ph"),
    saveLabel: t("tk.rep.note.save"),
    busyLabel: t("tk.rep.note.saving"),
    onSave: ui.save,
    onCancel: ui.cancel,
    draft: ui.editing.draft,
  });
  out.focus = ed.focus;
  return h("div.tk-an__note.is-editing", null, ed.el);
}

/** The notes of one place, the open field among them, and "+ another note" while no field is open
 *  there. null when the place has neither notes nor an open field. */
function notesBox(list, ui, anchor, out) {
  const edit = ui.editing,
    here = sameAnchor(edit, anchor.kind, anchor.index);
  const parts = list.map((n) => (edit?.noteId === n.id ? editor(ui, n.text, out) : savedNote(n, ui)));
  if (here && edit.noteId === null) parts.push(editor(ui, "", out));
  if (!parts.length) return null;
  const more = here
    ? null
    : h("button.tk-an__more", {
        type: "button",
        text: t("tk.rep.note.more"),
        "aria-label": t("tk.rep.note.moreAt", { excerpt: anchor.excerpt }),
        on: { click: () => ui.open(anchor) },
      });
  return h("div.tk-an__box", null, parts, more);
}

/** A place without notes: the "note" button behind its text (in its own cell for a table row). */
function addButton(b, ui, anchor) {
  const btn = h("button.tk-an__btn", {
    type: "button",
    text: t("tk.rep.note.add"),
    title: t("tk.rep.note.addTip"),
    "aria-label": t("tk.rep.note.addAt", { excerpt: b.excerpt }),
    on: { click: () => ui.open(anchor) },
  });
  b.el.append(b.kind === "row" ? h("td.tk-an__cell", null, btn) : btn);
}

/** A question with answer options on a list item or paragraph: the marker leaves the shown text (it
 *  has to stand in the last text node; formatting inside it leaves the line as plain text) and the
 *  options are returned. The anchor's excerpt keeps the marker, so an agent sees the options too.
 *  An escaped marker "\[? … ]" stays text and loses only its backslash (#1652). */
function takeAsk(b) {
  if (b.kind !== "item" && b.kind !== "paragraph") return null;
  const ask = askOf(b.el.textContent, b.previous),
    last = [...b.el.childNodes].at(-1);
  if (last?.nodeType !== 3) return null;
  if (!ask) {
    last.textContent = unescapeAsk(last.textContent);
    return null;
  }
  const marker = b.el.textContent.slice(ask.at);
  if (!last.textContent.endsWith(marker)) return null;
  last.textContent = last.textContent.slice(0, -marker.length).trimEnd();
  return ask;
}

/** The answer area (Daniel 18.11.2026, draft D): one row of equal answer fields across its whole
 *  width, first the agent's options, then "own answer" and "clarify" in the same form; each field
 *  shows its key in a small frame and its name below (the two fixed ones a sign instead of a letter).
 *  What the owner chose is pressed (amber). A pressed option does nothing on a second click; another
 *  option or clarification rewrites the earlier choice. */
function askButtons(ask, ui, anchor, list) {
  const clarify = t("tk.rep.ask.clarifyNote"),
    a = answerAt(ask.options, list, clarify);
  const choose = (text) => () => (a.picked === text ? undefined : ui.answer(anchor, text, a.pick?.id ?? null));
  const btn = (cls, { key, name }, title, on, click) =>
    h(
      `button.tk-ask__opt${cls}`,
      { type: "button", title, cls: on ? "is-on" : "", "aria-pressed": String(on), on: { click } },
      h("span.tk-ask__key", { text: key, "aria-hidden": "true" }),
      h("span.tk-ask__name", { text: name })
    );
  return h(
    "div.tk-ask",
    { role: "group", "aria-label": t("tk.rep.ask.label") },
    ask.options.map((o, i) => btn("", optionParts(o, i), t("tk.rep.ask.pickTip"), a.picked === o, choose(o))),
    btn(".is-free", { key: "…", name: t("tk.rep.ask.free") }, t("tk.rep.ask.freeTip"), a.own, () => ui.open(anchor)),
    btn(
      ".is-clarify",
      { key: "?", name: t("tk.rep.ask.clarify") },
      t("tk.rep.ask.clarifyTip"),
      a.picked === clarify,
      choose(clarify)
    )
  );
}

/** A place with notes (or an open field) becomes a card: its text on top as the subject, the
 *  notes below. A list item is the card itself; a heading or paragraph is wrapped into one; a
 *  table row is marked and its notes follow in a full-width row, so the table stays intact.
 *  settled: every note there is done, so the card takes the done colour instead of amber.
 *  answers: a question's answer area, kept between the question and its notes (null otherwise). */
function markPlace(b, box, out, settled, answers) {
  const cls = settled ? "is-done" : "";
  if (b.kind === "row") {
    b.el.classList.add("is-marked");
    if (settled) b.el.classList.add(cls);
    b.el.append(h("td.tk-an__cell"));
    b.el.after(h("tr.tk-an__tr", { cls }, h("td.tk-an__tcell", { colspan: String(b.el.children.length) }, box)));
  } else if (b.kind === "item") {
    const subject = h("div.tk-an__subj", null, [...b.el.childNodes]);
    b.el.classList.add("tk-an__card");
    if (settled) b.el.classList.add(cls);
    b.el.replaceChildren(subject, ...[answers, box].filter(Boolean));
  } else {
    b.el.classList.add("tk-an__subj");
    out.nodes[out.nodes.indexOf(b.el)] = h("div.tk-an__card", { cls }, b.el, answers, box);
  }
}

/** Notes whose block is gone: one card each, the stored excerpt as its subject. */
function lostNotes(lost, ui, out) {
  return h(
    "div.tk-an__lost",
    null,
    h("div.tk-an__lh", { text: t("tk.rep.note.lost") }),
    lost.map((n) =>
      h(
        "div.tk-an__card.is-lost",
        null,
        h("div.tk-an__subj.tk-an__excerpt", { text: n.excerpt }),
        h("div.tk-an__box", null, ui.editing?.noteId === n.id ? editor(ui, n.text, out) : savedNote(n, ui))
      )
    )
  );
}

/** Adds the note button, the answer buttons or the note card to every block of the rendered report.
 *  ui: { notes, editing: null | { anchor, noteId, draft }, open(anchor), edit(note), remove(note),
 *  save(text), answer(anchor, text, noteId), cancel() }. Returns { nodes, focus, toc } — focus() puts
 *  the cursor into an open note field; toc = { heads, asks }, each entry { text, el, index } in reading
 *  order (index: the block's number), a question with `answered` (a note is at its place). */
/** The report's outline for the jump list, filled block by block in reading order. A question is
 *  named after the nearest heading before it that no earlier question took (Daniel 18.11.2026: not
 *  "Your answer" three times), else "Question n – " and its own text; by structure, never by words. */
function outlineOf() {
  const toc = { heads: [], asks: [] };
  let headFree = null;
  function add(b, ask, answered) {
    if (b.kind === "heading") {
      toc.heads.push({ text: b.el.textContent, el: b.el, index: b.index });
      headFree = b.el.textContent.trim() || null;
    }
    if (!ask) return;
    const text = headFree ?? t("tk.rep.toc.askAt", { n: toc.asks.length + 1, q: ask.question });
    toc.asks.push({ text, el: b.el, index: b.index, answered });
    headFree = null;
  }
  return { toc, add };
}

export function annotateReport(nodes, ui) {
  const outline = outlineOf();
  const out = { nodes: [...nodes], focus: null, toc: outline.toc };
  const placed = new Set();
  for (const b of reportBlocksIn(nodes)) {
    const anchor = { kind: b.kind, index: b.index, excerpt: b.excerpt };
    const list = notesAt(ui.notes, b.kind, b.index, b.excerpt);
    for (const n of list) placed.add(n.id);
    b.el.classList.add("tk-an");
    if (list.some((n) => !n.done)) b.el.classList.add("has-open");
    const ask = takeAsk(b);
    outline.add(b, ask, list.length > 0);
    const answers = ask ? askButtons(ask, ui, anchor, list) : null;
    const box = notesBox(list, ui, anchor, out);
    const adding = sameAnchor(ui.editing, b.kind, b.index) && ui.editing.noteId === null;
    if (box) markPlace(b, box, out, list.length > 0 && !adding && list.every((n) => n.done), answers);
    else if (answers) b.el.append(answers);
    else addButton(b, ui, anchor);
  }
  // header rows get the empty cell the body rows got for their button
  for (const tr of out.nodes.flatMap((n) => [...(n.querySelectorAll?.("thead tr") ?? [])]))
    tr.append(h("th.tk-an__cell"));
  const lost = ui.notes.filter((n) => !placed.has(n.id));
  if (lost.length) out.nodes.push(lostNotes(lost, ui, out));
  return out;
}
