// Vault-care note field (memory browser, UI v2): the growing textarea with
// "improve text" — the local model rewrites a dictated note without fillers
// (POST /ui/improve-text) — and "undo" back to the original until the user
// types on or saves. Used for a new flag and for editing a saved one.
import { h, growTextarea } from "../dom.js";
import { t } from "../i18n.js";

// ── pure state: { text, phase: "idle" | "working", undo: string | null, error } ──
export const noteInit = (text = "") => ({ text, phase: "idle", undo: null, error: null });

/** One step of the note field. Events: input {text}, improve, improved
 *  {text}, failed {error}, undo, saved. While the model works the field is
 *  frozen: a second improve, typing or undo change nothing. */
export function noteStep(s, ev) {
  const working = s.phase === "working";
  switch (ev.type) {
    case "input":
      return working ? s : { text: ev.text, phase: "idle", undo: null, error: null };
    case "improve":
      return working || !s.text.trim() ? s : { ...s, phase: "working", error: null };
    case "improved":
      return working ? { text: ev.text, phase: "idle", undo: s.text, error: null } : s;
    case "failed":
      return working ? { ...s, phase: "idle", error: ev.error } : s;
    case "undo":
      return working || s.undo === null ? s : { text: s.undo, phase: "idle", undo: null, error: null };
    case "saved":
      return { ...s, undo: null, error: null };
    default:
      return s;
  }
}

/** What the controls show. `required`: saving needs text (editing a saved
 *  note); a new flag may go without one, as before. */
export function noteView(s, required = false) {
  const working = s.phase === "working";
  const filled = !!s.text.trim();
  return {
    working,
    canImprove: filled && !working,
    canUndo: s.undo !== null && !working,
    canSave: !working && (filled || !required),
    error: s.error,
  };
}

/** i18n key for a failed improve, by HTTP status (0 = no answer at all). */
export function improveError(status) {
  if (status === 503) return "mb.improveNoModel";
  if (status === 504) return "mb.improveSlow";
  if (status === 413) return "mb.improveTooLong";
  return "mb.improveFail";
}

async function requestImprove(text) {
  let r;
  try {
    r = await fetch("/ui/improve-text", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    return { error: improveError(0) };
  }
  const b = await r.json().catch(() => null);
  return r.ok && typeof b?.text === "string" && b.text.trim() ? { text: b.text } : { error: improveError(r.status) };
}

/**
 * The note editor. `saveLabel` / `busyLabel` name the save button at rest and
 * while storing. `onSave(text)` resolves when stored or rejects with an
 * Error whose message is shown; `onCancel` adds a cancel button (editing).
 * Returns { el, focus }.
 */
export function noteEditor({ value = "", required = false, saveLabel, busyLabel, onSave, onCancel }) {
  let s = noteInit(value);
  let saving = false;
  let saveError = "";
  const area = h("textarea.mb-care__note", {
    rows: "2",
    placeholder: t("mb.careNote"),
    on: { input: () => step({ type: "input", text: area.value }) },
  });
  area.value = value;
  const improve = h("button.mb-btn.is-quiet.cn__improve", { type: "button", on: { click: runImprove } });
  const undo = h("button.mb-btn.is-quiet", {
    type: "button",
    text: t("mb.undo"),
    on: { click: () => step({ type: "undo" }) },
  });
  const save = h("button.mb-btn.is-primary.mb-care__send", { type: "button", text: saveLabel, on: { click: runSave } });
  const cancel = onCancel
    ? h("button.mb-btn.is-quiet", { type: "button", text: t("mb.careCancel"), on: { click: onCancel } })
    : null;
  const msg = h("div.cn__msg", { role: "status" });

  function paint() {
    const v = noteView(s, required);
    if (area.value !== s.text) area.value = s.text; // result and undo as plain text, never markup
    area.readOnly = v.working;
    growTextarea(area);
    improve.textContent = t(v.working ? "mb.improving" : "mb.improve");
    improve.disabled = !v.canImprove || saving;
    improve.classList.toggle("is-busy", v.working);
    undo.hidden = !v.canUndo;
    save.disabled = !v.canSave || saving;
    msg.textContent = v.error ? t(v.error) : saveError;
  }
  function step(ev) {
    if (ev.type === "input") saveError = "";
    s = noteStep(s, ev);
    paint();
  }
  async function runImprove() {
    if (!noteView(s).canImprove) return;
    const text = s.text;
    step({ type: "improve" });
    const r = await requestImprove(text);
    step(r.text !== undefined ? { type: "improved", text: r.text } : { type: "failed", error: r.error });
  }
  async function runSave() {
    if (!noteView(s, required).canSave || saving) return;
    saving = true;
    saveError = "";
    save.textContent = busyLabel;
    paint();
    try {
      await onSave(s.text.trim());
      step({ type: "saved" });
    } catch (err) {
      saveError = err?.message || t("mb.careFail");
    } finally {
      saving = false;
      save.textContent = saveLabel;
      if (save.isConnected) paint();
    }
  }
  const el = h("div.mb-care__compose", null, area, h("div.cn__row", null, save, improve, undo, cancel), msg);
  paint();
  return {
    el,
    focus: () => {
      area.focus();
      growTextarea(area);
    },
  };
}
