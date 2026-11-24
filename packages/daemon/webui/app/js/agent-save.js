// "Save as memory" under an answer in the agent window (#1445). One click
// opens an editable preview (title, type, area, text); only "Save" writes,
// through POST /ui/save-memory — the daemon's normal save_memory path with
// write_origin user-directed. Nothing is ever saved automatically.
import { h, s, clear, growTextarea } from "./dom.js";
import { addStrings, t } from "./i18n.js";
import { data, loadGraph } from "./data.js";
import { dialog, btn, status, setStatus } from "./sections/dialogs.js";
import { setBusy } from "./sections/loading.js";
import en from "./i18n/agent-save-en.js";
import de from "./i18n/agent-save-de.js";

addStrings(en, de);

// Authored types, same set and order as the daemon (webui-save-memory.ts).
export const SAVE_TYPES = [
  "reference",
  "project-fact",
  "decision",
  "lesson",
  "workflow",
  "preference",
  "user-preference",
  "meta-working",
];
const TITLE_MAX = 80;

// ── pure: suggestions ──────────────────────────────────────────────────────
const plainLine = (line) =>
  String(line || "")
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

const firstLine = (text) =>
  String(text || "")
    .split("\n")
    .find((l) => l.trim()) || "";

/** Cut at a word boundary; no ellipsis, a title is not a teaser. */
function cutWords(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s\p{P}]+$/u, "");
}

/** Title proposal without a model call: a heading the answer opens with,
 *  else the question, else the answer's first line — trailing punctuation
 *  dropped, cut at a word boundary, first letter upper case. */
export function suggestTitle(question, answer) {
  const lead = firstLine(answer);
  const heading = /^\s*#{1,6}\s/.test(lead) ? plainLine(lead) : "";
  const base = (heading || plainLine(firstLine(question)) || plainLine(lead)).replace(/[\s\p{P}]+$/u, "");
  const title = cutWords(base, TITLE_MAX);
  return title ? title.charAt(0).toLocaleUpperCase() + title.slice(1) : "";
}

/** Areas (scopes) of the vault, most used first. */
export function scopeChoices(nodes) {
  const count = new Map();
  for (const n of Array.isArray(nodes) ? nodes : [])
    if (n && n.kind === "memory" && typeof n.scope === "string" && n.scope)
      count.set(n.scope, (count.get(n.scope) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
}

/** The area most of the answer's sources live in; without sources the
 *  vault's most used area. */
export function suggestScope(sourceIds, nodes) {
  const byId = new Map((Array.isArray(nodes) ? nodes : []).filter((n) => n && n.id).map((n) => [n.id, n]));
  const picked = scopeChoices(sourceIds.map((id) => byId.get(id)).filter(Boolean));
  return picked[0] || scopeChoices(nodes)[0] || "";
}

/** Does one of the answer's sources carry sensitivity private? */
export function hasPrivateSource(sourceIds, nodes) {
  const ids = new Set(sourceIds);
  return (Array.isArray(nodes) ? nodes : []).some((n) => n && ids.has(n.id) && n.sensitivity === "private");
}

// ── pure: preview state { draft, phase: edit | saving | saved, error, existing, saved } ──
export const draftInit = (draft) => ({ draft, phase: "edit", error: null, existing: [], saved: null });

const complete = (d) => !!(d.title.trim() && d.type && d.scope.trim() && d.body.trim());

/** Events: input {field, value}, save, saved {memory}, failed {error, existing}.
 *  While saving and after success the draft is frozen; a failure keeps it. */
export function draftStep(st, ev) {
  const editing = st.phase === "edit";
  switch (ev.type) {
    case "input":
      return editing ? { ...st, draft: { ...st.draft, [ev.field]: ev.value }, error: null, existing: [] } : st;
    case "save":
      return editing && complete(st.draft) ? { ...st, phase: "saving", error: null, existing: [] } : st;
    case "saved":
      return st.phase === "saving" ? { ...st, phase: "saved", saved: ev.memory } : st;
    case "failed":
      return st.phase === "saving" ? { ...st, phase: "edit", error: ev.error, existing: ev.existing || [] } : st;
    default:
      return st;
  }
}

export function draftView(st) {
  return {
    working: st.phase === "saving",
    done: st.phase === "saved",
    canSave: st.phase === "edit" && complete(st.draft),
    error: st.error,
    existing: st.existing,
  };
}

const REFUSED = { exists: "agent.save.exists", held: "agent.save.held" };

/** Answer of POST /ui/save-memory → { error: i18n key, existing: [{id, title}] }.
 *  status 0 = the request never arrived. */
export function saveFailure(statusCode, body) {
  const existing = (Array.isArray(body?.existing) ? body.existing : [])
    .filter((x) => x && typeof x.id === "string")
    .map((x) => ({ id: x.id, title: typeof x.title === "string" ? x.title : x.id }));
  if (statusCode === 409 && REFUSED[body?.code]) return { error: REFUSED[body.code], existing };
  // 404 "ui disabled" is the switch; any other 404 means this daemon does not
  // know the route yet (running build older than the page).
  const off = statusCode === 404 && body?.error === "ui disabled";
  const key = off
    ? "agent.save.off"
    : { 0: "agent.save.offline", 400: "agent.save.invalid", 413: "agent.save.tooLarge" }[statusCode] ||
      "agent.save.failed";
  return { error: key, existing: [] };
}

// ── saved answers (this page session): the button shows "saved" ────────────
const savedAnswers = new Map();
const answerKey = (q, a) => `${q}\u0000${a}`;

async function postSave(draft, sources, conversationId) {
  try {
    const r = await fetch("/ui/save-memory", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...draft, sources, conversation_id: conversationId }),
    });
    const b = await r.json().catch(() => ({}));
    return { ok: r.ok && typeof b.id === "string", status: r.status, body: b };
  } catch {
    return { ok: false, status: 0, body: {} };
  }
}

const field = (label, control) => h("label.asv__f", null, h("span.asv__l", { text: label }), control);

function typeSelect(value, onChange) {
  const sel = h(
    "select.st-select.asv__type",
    { on: { change: (e) => onChange(e.target.value) } },
    SAVE_TYPES.map((k) => h("option", { value: k, text: t(`agent.save.type.${k}`) }))
  );
  sel.value = value;
  return h("span.st-selw", null, sel);
}

/** The preview's inputs, prefilled from the draft; `set(field)` takes input. */
function draftFields(draft, set) {
  const title = h("input.dlg-in", { type: "text", maxlength: 200, value: draft.title, on: { input: set("title") } });
  const scope = h("input.dlg-in", {
    type: "text",
    spellcheck: "false",
    list: "asv-scopes",
    value: draft.scope,
    placeholder: t("agent.save.scopePh"),
    on: { input: set("scope") },
  });
  const text = h("textarea.dlg-ta.asv__ta", {
    spellcheck: "false",
    on: {
      input: (e) => {
        growTextarea(text);
        set("body")(e);
      },
    },
  });
  text.value = draft.body;
  const type = typeSelect(draft.type, (v) => set("type")({ target: { value: v } }));
  return { title, scope, text, type };
}

/** Buttons that open the memories a refused save names. */
const existingLinks = (list, open) =>
  list.map((m) =>
    h("button.asv__ref", {
      type: "button",
      text: m.title,
      title: t("agent.save.openExisting"),
      on: { click: () => open(m.id) },
    })
  );

/** The confirmation after the save: title, private note, close or open. */
const doneView = (m, close, open) => [
  h("p.asv__done", null, h("span.asv__tick", { text: "✓" }), t("agent.save.done", { title: m.title })),
  ...(m.sensitivity === "private" ? [h("p.dlg__hint.asv__priv", { text: t("agent.save.donePrivate") })] : []),
  h(
    "div.dlg__foot",
    null,
    btn(t("agent.save.close"), close),
    btn(t("agent.save.open"), () => open(m.id), "is-primary")
  ),
];

/** Opens the preview for one answer { q, a, sources: [[title, type, id]], conversationId? }. */
function openPreview(answer, onOpen, onSaved) {
  const nodes = data.graph?.nodes;
  const sourceIds = answer.sources.map((x) => x[2]).filter(Boolean);
  let st = draftInit({
    title: suggestTitle(answer.q, answer.a),
    type: SAVE_TYPES[0],
    scope: suggestScope(sourceIds, nodes),
    body: answer.a,
  });
  const { body, close } = dialog({
    kicker: t("agent.save.kicker"),
    title: t("agent.save.title"),
    cls: "dlg--asv",
    canClose: () => st.phase !== "saving",
  });
  const set = (fld) => (e) => {
    st = draftStep(st, { type: "input", field: fld, value: e.target.value });
    sync();
  };
  const f = draftFields(st.draft, set);
  const note = status();
  const refs = h("div.asv__refs");
  const save = btn(t("agent.save.save"), () => submit(), "is-primary");
  const form = h(
    "div.asv",
    null,
    h("p.dlg__text", { text: t("agent.save.help") }),
    field(t("agent.save.fTitle"), f.title),
    h("div.asv__row", null, field(t("agent.save.fType"), f.type), field(t("agent.save.fScope"), f.scope)),
    h(
      "datalist",
      { id: "asv-scopes" },
      scopeChoices(nodes).map((k) => h("option", { value: k }))
    ),
    field(t("agent.save.fBody"), f.text),
    hasPrivateSource(sourceIds, nodes) ? h("p.dlg__hint.asv__priv", { text: t("agent.save.privateHint") }) : null,
    note,
    refs,
    h(
      "div.dlg__foot",
      null,
      btn(t("agent.save.cancel"), () => close()),
      save
    )
  );
  body.append(form);
  growTextarea(f.text);
  f.title.focus();

  async function openMemory(id) {
    await loadGraph();
    close();
    onOpen(id);
  }
  function sync() {
    const v = draftView(st);
    save.disabled = !v.canSave;
    setBusy(save, v.working);
    for (const el of [f.title, f.scope, f.text]) el.readOnly = v.working;
    if (v.working) setStatus(note, t("agent.save.saving"), "busy");
    else if (v.error) setStatus(note, t(v.error), "err");
    else setStatus(note, "");
    refs.replaceChildren(...existingLinks(v.existing, openMemory));
  }
  async function submit() {
    st = draftStep(st, { type: "save" });
    if (st.phase !== "saving") return;
    sync();
    const r = await postSave(st.draft, sourceIds, answer.conversationId);
    if (r.ok) {
      st = draftStep(st, { type: "saved", memory: r.body });
      onSaved(r.body);
      loadGraph();
      clear(form).append(...doneView(r.body, () => close(), openMemory));
      return;
    }
    st = draftStep(st, { type: "failed", ...saveFailure(r.status, r.body) });
    sync();
  }
  sync();
}

const SAVE_ICON = "M6 4h9l3 3v13H6zM9 4v5h6M12 13v5M9.5 15.5h5";

/** The action under one answer: "Save as memory", or "Saved" (opens the
 *  memory) once it was saved in this session. `answer.saveable` false (an
 *  error text, the no-model notice) shows nothing. Returns a list to spread
 *  into append(): empty or the one action row. */
export function saveAction(answer, onOpen, rerender) {
  if (!answer || answer.saveable === false || !String(answer.a || "").trim()) return [];
  const key = answerKey(answer.q, answer.a);
  const done = savedAnswers.get(key);
  return [
    h(
      "div.agent__acts",
      null,
      h(
        "button.agent__act",
        {
          type: "button",
          cls: done ? "is-done" : "",
          title: done ? t("agent.save.savedTitle", { title: done.title }) : t("agent.save.btnTitle"),
          on: {
            click: () =>
              done
                ? onOpen(done.id)
                : openPreview(answer, onOpen, (m) => {
                    savedAnswers.set(key, { id: m.id, title: m.title });
                    rerender();
                  }),
          },
        },
        s(
          "svg",
          { viewBox: "0 0 24 24", "aria-hidden": "true" },
          s("path", { d: done ? "M5 12.5l4.5 4.5L19 7" : SAVE_ICON })
        ),
        h("span", { text: done ? t("agent.save.saved") : t("agent.save.btn") })
      )
    ),
  ];
}
