// Tasks › Reports — notes on single places of a report (Daniel 17.11.2026):
// while reading, the owner leaves a note on a heading, paragraph, list item or
// table row ("research the prices again", "this is how it should be"). The
// next agent session is told about open notes (daemon: task-report-notice.ts),
// acts on them and marks each one done with a short reply shown here.
// A block without notes gets a small "note" button (shown on hover / focus only).
// A block with notes, or with an open note field, becomes a framed card: the
// report text on top, its notes below, "+ another note" at the bottom (Daniel
// 17.11.2026: a thin edge alone did not set the note apart from the report).
// Table rows are marked and get their notes in a full-width row right below.
// The note field is the vault-care field with "improve text" (views/care-note.js).
// A note whose block is no longer found (another renderer) is listed at the end
// as a card of its own, never lost. Report and note texts are external data:
// text nodes only.
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { noteEditor } from "../views/care-note.js";
import { fmtAt } from "./tasks-api.js";
import { excerptOf, notesAt } from "./tasks-reports-model.js";

/** The annotatable blocks of the rendered report in reading order (as markdown() and the
 *  table renderer build them): headings, paragraphs, list items, table body rows. */
export function reportBlocksIn(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.tagName === "H3") out.push({ el: n, kind: "heading" });
    else if (n.tagName === "P") out.push({ el: n, kind: "paragraph" });
    else if (n.tagName === "UL") for (const li of [...n.children]) out.push({ el: li, kind: "item" });
    else if (n.classList?.contains("tk-rep__tbl"))
      for (const tr of [...n.querySelectorAll("tbody tr")]) out.push({ el: tr, kind: "row" });
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
  return h(
    "div.tk-an__note",
    { cls: n.done ? "is-done" : "" },
    h(
      "div.tk-an__head",
      null,
      h("span.tk-an__state", { text: t(n.done ? "tk.rep.note.done" : "tk.rep.note.open") }),
      h("span.tk-an__at", { text: fmtAt(n.at) }),
      h(
        "span.tk-an__acts",
        null,
        h("button.tk-an__act", { type: "button", text: t("tk.rep.note.edit"), on: { click: () => ui.edit(n) } }),
        h("button.tk-an__act", { type: "button", text: t("tk.rep.note.delete"), on: { click: () => ui.remove(n) } })
      )
    ),
    h("div.tk-an__text", { text: n.text }),
    n.done && n.reply
      ? h(
          "div.tk-an__reply",
          null,
          h("div.tk-an__rk", { text: t("tk.rep.note.reply") }),
          h("div.tk-an__rtext", { text: n.reply })
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

/** A place with notes (or an open field) becomes a card: its text on top as the subject, the
 *  notes below. A list item is the card itself; a heading or paragraph is wrapped into one; a
 *  table row is marked and its notes follow in a full-width row, so the table stays intact. */
function markPlace(b, box, out) {
  if (b.kind === "row") {
    b.el.classList.add("is-marked");
    b.el.append(h("td.tk-an__cell"));
    b.el.after(h("tr.tk-an__tr", null, h("td.tk-an__tcell", { colspan: String(b.el.children.length) }, box)));
  } else if (b.kind === "item") {
    const subject = h("div.tk-an__subj", null, [...b.el.childNodes]);
    b.el.classList.add("tk-an__card");
    b.el.replaceChildren(subject, box);
  } else {
    b.el.classList.add("tk-an__subj");
    out.nodes[out.nodes.indexOf(b.el)] = h("div.tk-an__card", null, b.el, box);
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

/** Adds the note button or the note card to every block of the rendered report.
 *  ui: { notes, editing: null | { anchor, noteId, draft }, open(anchor), edit(note), remove(note),
 *  save(text), cancel() }. Returns { nodes, focus } — focus() puts the cursor into an open note field. */
export function annotateReport(nodes, ui) {
  const out = { nodes: [...nodes], focus: null };
  const placed = new Set();
  for (const b of reportBlocksIn(nodes)) {
    const anchor = { kind: b.kind, index: b.index, excerpt: b.excerpt };
    const list = notesAt(ui.notes, b.kind, b.index);
    for (const n of list) placed.add(n.id);
    b.el.classList.add("tk-an");
    if (list.some((n) => !n.done)) b.el.classList.add("has-open");
    const box = notesBox(list, ui, anchor, out);
    if (box) markPlace(b, box, out);
    else addButton(b, ui, anchor);
  }
  // header rows get the empty cell the body rows got for their button
  for (const tr of out.nodes.flatMap((n) => [...(n.querySelectorAll?.("thead tr") ?? [])]))
    tr.append(h("th.tk-an__cell"));
  const lost = ui.notes.filter((n) => !placed.has(n.id));
  if (lost.length) out.nodes.push(lostNotes(lost, ui, out));
  return out;
}
