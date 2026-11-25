// Vault care in the memory browser's reader (old map inspector): the open
// flags of a memory — each editable in place — plus the kind buttons and the
// note for a new flag. Flags go to vault-care.md via POST /ui/annotate; an
// edit sends the entry as last read (`previous`) so the daemon replaces
// exactly that one, or answers 409 when it changed meanwhile.
import { h } from "../dom.js";
import { t } from "../i18n.js";
import { noteEditor, noteInit } from "./care-note.js";
import { jsonRequest } from "../session-client.js";

// Drafts live for the page session, independent of reader DOM and selection.
const drafts = new Map();

const str = (v) => (typeof v === "string" ? v : "");

// ── pure state of one saved flag: "view" → "edit" → (save) "view" | (cancel) "view" ──
/** Events: edit, improve (the overview's "improve text": opens the editor and
 *  starts the model there), cancel, saved. */
export function flagStep(mode, ev) {
  if (ev.type === "edit" || ev.type === "improve") return mode === "view" ? "edit" : mode;
  if (ev.type === "cancel" || ev.type === "saved") return mode === "edit" ? "view" : mode;
  return mode;
}

/** HTTP status of a failed save → i18n key. */
export function careSaveError(status) {
  if (status === 409) return "mb.careConflict";
  if (status === 413) return "mb.careTooLong";
  return "mb.careFail";
}

async function postCare(payload) {
  const r = await jsonRequest("/ui/annotate", payload).catch(() => null);
  if (!r?.ok) throw new Error(t(careSaveError(r?.status ?? 0)));
  const b = await r.json().catch(() => ({}));
  return b?.entry && typeof b.entry === "object" ? b.entry : null;
}

/** One saved flag: kind · note · date, "edit" swaps the note for the editor. */
function flagItem(m, a, rerender, draft) {
  draft.mode ||= "view";
  draft.rerender = rerender;
  const item = h("div.mb-care__item");
  function paint() {
    item.classList.toggle("is-editing", draft.mode === "edit");
    const head = [h("span.mb-care__kind", { text: t(`mb.careKind.${a.kind}`) })];
    if (draft.mode === "view") {
      item.replaceChildren(
        ...head,
        h("span.mb-care__note-text", { text: str(a.note) || "—" }),
        h("span.mb-care__date", { text: str(a.date) }),
        h(
          "div.mb-care__acts",
          null,
          h("button.mb-btn.is-quiet.mb-care__edit", {
            type: "button",
            text: t("mb.careEdit"),
            on: { click: () => go({ type: "edit" }) },
          }),
          str(a.note).trim()
            ? h("button.mb-btn.is-quiet.mb-care__edit", {
                type: "button",
                text: t("mb.improve"),
                on: { click: () => go({ type: "improve" }) },
              })
            : null
        )
      );
      return;
    }
    const ed = noteEditor({
      value: str(a.note),
      draft,
      required: true,
      saveLabel: t("mb.careSave"),
      busyLabel: t("mb.careSaving"),
      onCancel: () => go({ type: "cancel" }),
      onSave: async (note) => {
        const previous = { kind: a.kind, date: str(a.date), note: str(a.note) };
        const entry = await postCare({ id: m.id, kind: a.kind, note, previous });
        Object.assign(a, entry || { note });
        go({ type: "saved" });
        draft.rerender();
      },
    });
    item.replaceChildren(...head, h("span.mb-care__date", { text: str(a.date) }), ed.el);
    return ed;
  }
  function go(ev) {
    draft.mode = flagStep(draft.mode, ev);
    if (ev.type === "cancel") draft.state = undefined;
    const ed = paint();
    if (!ed) return;
    // the overview's "improve text" runs right in the opened editor
    if (ev.type === "improve") ed.improve();
    else ed.focus();
  }
  paint();
  return item;
}

/** Match drafts by their entry during local edits, and by occurrence if the
 *  entries were parsed again. A save can change the occurrence of its twin. */
function savedFlags(m, open, draft, rerender) {
  const previous = draft.flags;
  const counts = new Map();
  draft.flags = new Map();
  return open.map((a) => {
    const text = JSON.stringify([a.kind, a.date, a.note]);
    const n = counts.get(text) ?? 0;
    counts.set(text, n + 1);
    const key = `${text}:${n}`;
    const flag = draft.entries.get(a) ?? previous.get(key) ?? {};
    draft.entries.set(a, flag);
    draft.flags.set(key, flag);
    return flagItem(m, a, rerender, flag);
  });
}

/**
 * The care section of one memory. `care`: the loaded flag list (entries are
 * updated in place on edit); `add(entry)`: store a new flag; `rerender()`:
 * redraw the reader.
 */
export function careBlock(m, { care, add, rerender }) {
  if (!drafts.has(m.id)) drafts.set(m.id, { kind: null, compose: {}, flags: new Map(), entries: new WeakMap() });
  const draft = drafts.get(m.id);
  draft.rerender = rerender;
  const open = care.filter((a) => a.id === m.id && !a.done);
  const compose = noteEditor({
    draft: draft.compose,
    saveLabel: t("mb.careSend"),
    busyLabel: t("mb.careSending"),
    onSave: async (note) => {
      const entry = await postCare({ id: m.id, kind: draft.kind, note });
      add(entry || { id: m.id, kind: draft.kind, note, date: new Date().toISOString().slice(0, 10), done: false });
      draft.kind = null;
      draft.compose.state = noteInit();
      draft.rerender();
    },
  });
  compose.el.hidden = !draft.kind;
  const kinds = ["edit", "delete", "note"].map((k) =>
    h("button.mb-btn.is-quiet", {
      type: "button",
      text: t(`mb.care.${k}`),
      "data-k": k,
      cls: draft.kind === k ? "is-on" : "",
      on: {
        click: (e) => {
          draft.kind = k;
          kinds.forEach((b) => b.classList.toggle("is-on", b === e.currentTarget));
          compose.el.hidden = false;
          compose.focus();
        },
      },
    })
  );
  return h(
    "div.mb-care",
    null,
    h("div.mb-rd__k", { text: t("mb.care") }),
    h("div.mb-care__hint", { text: t("mb.careHint") }),
    open.length ? h("div.mb-care__open", null, savedFlags(m, open, draft, rerender)) : null,
    h("div.mb-care__kinds", null, kinds),
    compose.el
  );
}
