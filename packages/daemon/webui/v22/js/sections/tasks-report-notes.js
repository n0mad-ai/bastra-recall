// Tasks › Reports — notes on single places of a report (Daniel 17.11.2026):
// while reading, the owner leaves a note on a heading, paragraph, list item or
// table row ("research the prices again", "this is how it should be"). The
// next agent session is told about open notes (daemon: task-report-notice.ts),
// acts on them and marks each one done with a short reply shown here.
// Every annotatable block gets a small "note" button (shown on hover / focus);
// the note field is the vault-care field with "improve text" (views/care-note.js).
// Saved notes stand right below their block with an amber edge. A note whose
// block is no longer found (another renderer) is listed at the end, never lost.
// Report and note texts are external data: text nodes only.
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

/** One saved note: state, time, actions; the agent's reply under it once done. */
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
        h("button.mb-btn.is-quiet.tk-an__act", {
          type: "button",
          text: t("tk.rep.note.edit"),
          on: { click: () => ui.edit(n) },
        }),
        h("button.mb-btn.is-quiet.tk-an__act", {
          type: "button",
          text: t("tk.rep.note.delete"),
          on: { click: () => ui.remove(n) },
        })
      )
    ),
    h("div.tk-an__text", { text: n.text }),
    n.done && n.reply
      ? h("div.tk-an__reply", null, h("span.tk-an__rk", { text: t("tk.rep.note.reply") }), n.reply)
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

function box(list, ui, kind, index, out) {
  const edit = ui.editing;
  const parts = list.map((n) => (edit?.noteId === n.id ? editor(ui, n.text, out) : savedNote(n, ui)));
  if (sameAnchor(edit, kind, index) && edit.noteId === null) parts.push(editor(ui, "", out));
  return parts.length ? h("div.tk-an__box", null, parts) : null;
}

/** Adds the note button and the notes to every block of the rendered report.
 *  ui: { notes, editing: null | { anchor, noteId, draft }, open(anchor), edit(note), remove(note),
 *  save(text), cancel() }. Returns { nodes, focus } — focus() puts the cursor into an open note field. */
export function annotateReport(nodes, ui) {
  const out = { nodes: [...nodes], focus: null };
  const placed = new Set();
  for (const b of reportBlocksIn(nodes)) {
    const anchor = { kind: b.kind, index: b.index, excerpt: b.excerpt };
    const list = notesAt(ui.notes, b.kind, b.index);
    for (const n of list) placed.add(n.id);
    const btn = h("button.tk-an__btn", {
      type: "button",
      text: t("tk.rep.note.add"),
      title: t("tk.rep.note.addTip"),
      "aria-label": t("tk.rep.note.addAt", { excerpt: b.excerpt }),
      on: { click: () => ui.open(anchor) },
    });
    b.el.classList.add("tk-an");
    if (list.some((n) => !n.done)) b.el.classList.add("has-open");
    const notes = box(list, ui, b.kind, b.index, out);
    if (b.kind === "row") {
      b.el.append(h("td.tk-an__cell", null, btn));
      if (notes) b.el.after(h("tr.tk-an__tr", null, h("td", { colspan: String(b.el.children.length) }, notes)));
    } else {
      b.el.append(btn);
      if (b.kind === "item") {
        if (notes) b.el.append(notes);
      } else if (notes) out.nodes.splice(out.nodes.indexOf(b.el) + 1, 0, notes);
    }
  }
  // header rows get the empty cell the body rows got for their button
  for (const tr of out.nodes.flatMap((n) => [...(n.querySelectorAll?.("thead tr") ?? [])]))
    tr.append(h("th.tk-an__cell"));
  const lost = ui.notes.filter((n) => !placed.has(n.id));
  if (lost.length)
    out.nodes.push(
      h(
        "div.tk-an__lost",
        null,
        h("div.tk-an__lh", { text: t("tk.rep.note.lost") }),
        lost.map((n) =>
          h(
            "div.tk-an__lostitem",
            null,
            h("div.tk-an__excerpt", { text: n.excerpt }),
            ui.editing?.noteId === n.id ? editor(ui, n.text, out) : savedNote(n, ui)
          )
        )
      )
    );
  return out;
}
