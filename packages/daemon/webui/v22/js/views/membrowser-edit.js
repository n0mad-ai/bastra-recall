// Editing a memory directly in the memory browser's reader (#1446).
//
// "EDIT" swaps the summary and the text for fields in the same place; save
// goes to POST /ui/memory/edit (the daemon's edit_memory path) with the
// revision the reader showed, so a change made meanwhile is refused (409):
// the draft stays in the fields and "reload" fetches the current version,
// keeping the draft aside to put back. An open editor survives switching to
// another memory and closing the browser (held per memory below); leaving
// the page with one asks first. "ARCHIVE" moves the memory into the vault
// trash (archive_memory) in one click; "undo" restores it from there.
// Pure state and change set: membrowser-edit-model.js.
import { h, growTextarea } from "../dom.js";
import { t } from "../i18n.js";
import {
  editInit,
  editStep,
  editView,
  editPatch,
  ruleEditable,
  writeOutcome,
  SUMMARY_MAX,
} from "./membrowser-edit-model.js";

const states = new Map(); // id → an open editor's state (view states are not kept)
const savedAt = new Map(); // id → time of the last save: its reader says "saved" for a moment
let lastArchived = null; // { id, title, where, next } until undone, dismissed or moved on

/** Whether `id` has an open editor (its reader must not redraw under it). */
export const editing = (id) => !!id && states.has(id);

let guarded = false;
function guardUnload() {
  if (guarded) return;
  guarded = true;
  window.addEventListener("beforeunload", (e) => {
    if (states.size) e.preventDefault(); // unsaved edits: the browser asks before leaving
  });
}

async function post(path, payload) {
  try {
    const r = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return writeOutcome(r.status, await r.json().catch(() => null));
  } catch {
    return writeOutcome(0, null);
  }
}

const errorText = (r) => (r.detail ? `${t(r.error)} (${r.detail})` : t(r.error));

/** The rule state chip: rule · level, proposal, note or inactive. */
function ruleText(rule) {
  if (rule.state !== "rule") return t(`mb.rule.${rule.state}`);
  const level = t(`mb.rule.${rule.rulebook === "always" ? "always" : "onDemand"}`);
  return `${t("mb.rule.rule", { level })}${rule.delivered === false ? ` · ${t("mb.rule.private")}` : ""}`;
}

const LEVELS = [
  ["", "mb.ed.noRule"],
  ["on-demand", "mb.ed.onDemand"],
  ["always", "mb.ed.always"],
];

/** The edit fields, built once per open editor; typing never repaints them. */
function editorForm(rule, act) {
  const area = (name, rows) => {
    const ta = h("textarea.mb-care__note.mb-ed__ta", { rows: String(rows), name });
    ta.addEventListener("input", () => {
      growTextarea(ta);
      act.input(name, ta.value);
    });
    return ta;
  };
  const summary = area("summary", 2),
    body = area("body", 8),
    when = area("applies_when", 2);
  const tags = h("input.st-text.mb-ed__tags", { type: "text", spellcheck: "false", name: "tags" });
  tags.addEventListener("input", () => act.input("tags", tags.value));
  const level = h(
    "select.st-select",
    { name: "rulebook" },
    LEVELS.filter(([v]) => v || rule?.state !== "rule").map(([v, key]) => h("option", { value: v, text: t(key) }))
  );
  level.addEventListener("change", () => act.input("rulebook", level.value));
  const count = h("span.mb-ed__count");
  const whenField = h("label.mb-ed__f", null, h("span.mb-rd__k", { text: t("mb.ed.when") }), when);
  const ruleField = ruleEditable(rule)
    ? h(
        "div.mb-ed__rule",
        null,
        h("label.mb-ed__f", null, h("span.mb-rd__k", { text: t("mb.ed.rule") }), h("span.st-selw", null, level)),
        whenField
      )
    : null;
  const msg = h("div.cn__msg", { role: "status" });
  const save = h("button.mb-btn.is-primary", { type: "button", on: { click: act.save } });
  const cancel = h("button.mb-btn.is-quiet", { type: "button", text: t("mb.ed.cancel"), on: { click: act.cancel } });
  const reload = h("button.mb-btn", { type: "button", text: t("mb.ed.reload"), on: { click: act.reload } });
  const stash = h("button.mb-btn.is-quiet", { type: "button", text: t("mb.ed.useStash"), on: { click: act.useStash } });
  const row = h("div.cn__row", null, save, reload, stash, cancel);
  const el = h(
    "div.mb-ed",
    null,
    h(
      "label.mb-ed__f",
      null,
      h("span.mb-ed__k", null, h("span.mb-rd__k", { text: t("mb.ed.summary") }), count),
      summary
    ),
    h("label.mb-ed__f", null, h("span.mb-rd__k", { text: t("mb.ed.body") }), body),
    h("label.mb-ed__f", null, h("span.mb-rd__k", { text: t("mb.ed.tags") }), tags),
    ruleField,
    h("div.mb-care__hint.mb-ed__fixed", { text: t("mb.ed.fixed") }),
    msg,
    row
  );
  return {
    el,
    fill(d) {
      summary.value = d.summary;
      body.value = d.body;
      tags.value = d.tags;
      level.value = d.rulebook;
      when.value = d.applies_when;
      for (const ta of [summary, body, when]) growTextarea(ta);
    },
    paint(v, d) {
      const n = d.summary.trim().length;
      count.textContent = `${n} / ${SUMMARY_MAX}`;
      count.classList.toggle("is-over", n > SUMMARY_MAX);
      whenField.hidden = !d.rulebook;
      if (!whenField.hidden) growTextarea(when);
      for (const f of [summary, body, tags, level, when]) f.readOnly = v.saving;
      level.disabled = v.saving;
      save.disabled = !v.canSave;
      save.textContent = t(v.saving ? "mb.ed.saving" : "mb.ed.save");
      reload.hidden = !v.conflict;
      stash.hidden = !v.stash;
      msg.textContent = v.error ? t(v.error) : v.invalid ? t(v.invalid) : "";
      // the status sits above the buttons and both stay in view
      if (msg.textContent && row.isConnected) row.scrollIntoView({ block: "nearest" });
    },
    focus: () => body.focus(),
  };
}

/**
 * The reader's edit controls for memory `m`. `anchor`: the title (the editor
 * goes right below it); `box` / `text`: the summary box and the text it
 * replaces. `refresh()`: reload graph and reader after a write;
 * `rerender()`: redraw when the reader allows; `reload(id)`: the current
 * detail, fetched fresh; `archived(id)`: the memory left the vault — returns
 * the memory selected next. Returns { badge, acts, attach(detail) }.
 */
export function readerEdit(m, { anchor, box, text, refresh, rerender, reload, archived }) {
  let s = states.get(m.id) || editInit();
  let form = null;
  const badge = h("span.mb-rd__rule", { hidden: true });
  const msg = h("div.cn__msg.mb-ed__msg", { role: "status" });
  const editBtn = h("button.mb-btn", {
    type: "button",
    text: t("mb.ed.edit"),
    on: { click: () => go({ type: "edit" }) },
  });
  const archiveBtn = h("button.mb-btn.is-quiet", {
    type: "button",
    text: t("mb.ed.archive"),
    on: { click: runArchive },
  });
  const accept = h("button.mb-btn", { type: "button", text: t("mb.ed.accept"), on: { click: () => decide("accept") } });
  const reject = h("button.mb-btn.is-quiet", {
    type: "button",
    text: t("mb.ed.reject"),
    on: { click: () => decide("reject") },
  });
  if (Date.now() - (savedAt.get(m.id) ?? 0) < 4000) msg.textContent = t("mb.ed.saved");

  const act = {
    input: (field, value) => go({ type: "input", field, value }),
    save: runSave,
    cancel: () => {
      go({ type: "cancel" });
      rerender();
    },
    reload: runReload,
    useStash: () => {
      go({ type: "useStash" });
      form?.fill(s.draft);
      paint();
    },
  };

  function go(ev) {
    const was = s.mode;
    s = editStep(s, ev);
    if (s.mode === "view") states.delete(m.id);
    else {
      states.set(m.id, s);
      guardUnload();
    }
    paint();
    if (was === "view" && s.mode === "edit") form?.focus();
  }

  function paintForm(v) {
    if (v.editing && !form && anchor.parentNode) {
      form = editorForm(s.rule, act);
      anchor.after(form.el);
      form.fill(s.draft); // on screen first: the fields measure their height
    } else if (!v.editing && form) {
      form.el.remove();
      form = null;
    }
    if (form) form.paint(v, s.draft);
  }

  function paint() {
    const v = editView(s, m.id);
    const proposal = !v.editing && s.rule?.state === "proposal" && !s.rule.archive;
    badge.hidden = !s.rule;
    if (s.rule) {
      badge.textContent = ruleText(s.rule);
      badge.dataset.state = s.rule.state;
    }
    box.hidden = text.hidden = v.editing;
    editBtn.hidden = archiveBtn.hidden = v.editing;
    editBtn.disabled = archiveBtn.disabled = !s.revision;
    accept.hidden = reject.hidden = !proposal;
    if (v.editing) msg.textContent = "";
    paintForm(v);
  }

  async function runSave() {
    const { payload } = editPatch(s, m.id);
    if (!payload || s.mode !== "edit") return;
    go({ type: "save" });
    const r = await post("/ui/memory/edit", payload);
    if (r.ok) {
      go({ type: "saved", revision: r.revision, rule: r.rule });
      savedAt.set(m.id, Date.now());
      refresh();
    } else go(r.conflict ? { type: "conflict" } : { type: "failed", error: r.error });
  }

  async function runReload() {
    const d = await reload(m.id);
    if (!d) return;
    go({ type: "reloaded", detail: d });
    form?.fill(s.draft);
    paint();
  }

  async function runArchive() {
    archiveBtn.disabled = true;
    msg.textContent = t("mb.ed.archiving");
    const r = await post("/ui/memory/archive", { id: m.id, expected_revision: s.revision });
    if (r.ok) {
      lastArchived = { id: m.id, title: m.title, where: r.body?.archived_to || "", next: null };
      lastArchived.next = archived(m.id);
      return;
    }
    archiveBtn.disabled = false;
    msg.textContent = r.conflict ? t("mb.ed.staleView") : errorText(r);
  }

  async function decide(decision) {
    accept.disabled = reject.disabled = true;
    const r = await post("/ui/memory/edit", { id: m.id, expected_revision: s.revision, rule_decision: decision });
    accept.disabled = reject.disabled = false;
    if (r.ok) {
      savedAt.set(m.id, Date.now());
      refresh();
    } else msg.textContent = r.conflict ? t("mb.ed.staleView") : errorText(r);
  }

  paint();
  return {
    badge,
    acts: [editBtn, accept, reject, archiveBtn, msg],
    /** The loaded detail (null = failed); called once the reader is on screen. */
    attach(d) {
      if (d) go({ type: "load", detail: d });
      else paint();
    },
  };
}

/** The note after an archive, with "undo" — shown while the memory selected
 *  next is on screen. `restored(id)`: it is back in the vault. */
export function archiveNotice(sel, { restored }) {
  const a = lastArchived;
  if (!a || a.next !== (sel ?? null)) return null;
  const msg = h("span.cn__msg");
  const undo = h("button.mb-btn.is-quiet.mb-care__edit", { type: "button", text: t("mb.ed.undo") });
  const close = h("button.mb-ed__x", { type: "button", text: "×", title: t("mb.ed.dismiss") });
  const el = h(
    "div.mb-ed__notice",
    { role: "status" },
    h("span.mb-ed__done", { text: t("mb.ed.archived", { m: a.title, where: a.where || ".bastra/trash" }) }),
    undo,
    close,
    msg
  );
  undo.addEventListener("click", async () => {
    undo.disabled = true;
    const r = await post("/ui/memory/restore", { id: a.id });
    if (r.ok) {
      lastArchived = null;
      restored(a.id);
      return;
    }
    undo.disabled = false;
    msg.textContent = r.conflict ? t("mb.ed.restoreFail") : errorText(r);
  });
  close.addEventListener("click", () => {
    lastArchived = null;
    el.remove();
  });
  return el;
}
