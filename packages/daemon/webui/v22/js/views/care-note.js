// Vault-care note field (memory browser, UI v2): the growing textarea with
// "improve text" — the local model rewrites a dictated note without fillers
// (POST /ui/improve-text) — and "undo" back to the original until the user
// types on or saves. Used for a new flag and for editing a saved one, and for
// the notes on task reports (sections/tasks-report-notes.js).
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

// The daemon gives the model 45 s; the page waits a little longer, never forever.
const CLIENT_TIMEOUT_MS = 60_000;

/** i18n key for a failed improve: an HTTP status, or "offline" (no answer
 *  at all), "timeout" (the page gave up), "empty" (200 without usable text).
 *  404/405 = a daemon that predates the route — it needs a restart. */
export function improveError(status) {
  if (status === 503) return "mb.improveNoModel";
  if (status === 504 || status === "timeout") return "mb.improveSlow";
  if (status === 502) return "mb.improveModel";
  if (status === 413) return "mb.improveTooLong";
  if (status === 404 || status === 405) return "mb.improveOld";
  if (status === "offline") return "mb.improveOffline";
  if (status === "empty") return "mb.improveEmpty";
  return "mb.improveFail";
}

/** The daemon's answer → { text } or { error: i18n key }. */
export function improveOutcome(status, body) {
  if (status < 200 || status > 299) return { error: improveError(status) };
  return typeof body?.text === "string" && body.text.trim() ? { text: body.text } : { error: improveError("empty") };
}

async function requestImprove(text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CLIENT_TIMEOUT_MS);
  try {
    const r = await fetch("/ui/improve-text", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    });
    return improveOutcome(r.status, await r.json().catch(() => null));
  } catch (err) {
    return { error: improveError(err?.name === "AbortError" ? "timeout" : "offline") };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The note editor. `saveLabel` / `busyLabel` name the save button at rest and
 * while storing. `onSave(text)` resolves when stored or rejects with an
 * Error whose message is shown; `onCancel` adds a cancel button (editing);
 * `placeholder` names what the field is for (default: the vault-care question).
 * Returns { el, focus, improve } — `improve()` starts "improve text" as if
 * its button was clicked (the saved flag's overview button uses it).
 */
export function noteEditor({
  value = "",
  required = false,
  saveLabel,
  busyLabel,
  onSave,
  onCancel,
  draft = {},
  placeholder = t("mb.careNote"),
}) {
  draft.state ||= noteInit(value);
  draft.saving ||= false;
  draft.saveError ||= "";
  const area = h("textarea.mb-care__note", {
    rows: "2",
    placeholder,
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
  const row = h("div.cn__row", null, save, improve, undo, cancel);
  // The status sits right above the buttons and both are scrolled into view,
  // so a click always shows its effect — even at the bottom of the reader.
  const reveal = () => row.isConnected && row.scrollIntoView({ block: "nearest" });

  function paint() {
    const s = draft.state;
    const v = noteView(s, required);
    if (area.value !== s.text) area.value = s.text; // result and undo as plain text, never markup
    area.readOnly = v.working || draft.saving;
    growTextarea(area);
    improve.textContent = t(v.working ? "mb.improving" : "mb.improve");
    improve.disabled = !v.canImprove || draft.saving;
    improve.classList.toggle("is-busy", v.working);
    undo.hidden = !v.canUndo;
    save.disabled = !v.canSave || draft.saving;
    save.textContent = draft.saving ? busyLabel : saveLabel;
    if (cancel) cancel.disabled = v.working || draft.saving;
    msg.textContent = v.error ? t(v.error) : draft.saveError;
  }
  function step(ev) {
    if (ev.type === "input" && draft.saving) return;
    if (ev.type === "input") draft.saveError = "";
    draft.state = noteStep(draft.state, ev);
    draft.paint();
  }
  async function runImprove() {
    if (!noteView(draft.state).canImprove) return;
    const text = draft.state.text;
    step({ type: "improve" });
    reveal();
    const r = await requestImprove(text);
    step(r.text !== undefined ? { type: "improved", text: r.text } : { type: "failed", error: r.error });
    reveal();
  }
  async function runSave() {
    if (!noteView(draft.state, required).canSave || draft.saving) return;
    draft.saving = true;
    draft.saveError = "";
    save.textContent = busyLabel;
    paint();
    try {
      await onSave(draft.state.text.trim());
      step({ type: "saved" });
    } catch (err) {
      draft.saveError = err?.message || t("mb.careFail");
    } finally {
      draft.saving = false;
      save.textContent = saveLabel;
      draft.paint();
      if (draft.saveError) reveal();
    }
  }
  const el = h("div.mb-care__compose", null, area, msg, row);
  draft.paint = paint;
  paint();
  return {
    el,
    focus: () => {
      area.focus();
      growTextarea(area);
    },
    improve: runImprove,
  };
}
