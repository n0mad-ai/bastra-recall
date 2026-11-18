// Editing a memory in the reader (#1446), as pure logic: the editable fields
// of a node detail, the editor's states, the change set a save sends to
// POST /ui/memory/edit and how the daemon's answer is read.
//
// States: "view" → edit → "edit" → save → "saving" → saved "view"
//                                                   | failed "edit" (message)
//                                                   | conflict "conflict"
// "conflict" keeps the draft; reloaded → "edit" on the current version with
// the draft kept aside (`stash`), useStash puts it back. cancel → "view".
// Title, type, sensitivity and recall mode are fields too (#1558); the area
// is not (it follows the folder), so it is not a field at all.
// A change of type or recall mode that makes a memory a rule or ends one
// (a rule without its own declaration) is shown before the save; the first
// save click then asks once more ("confirm") and the second one saves.

// The daemon's auto-related block (core save-text.ts AUTO_RELATED_START) is
// generated; the editor shows and replaces only the text above it.
export const AUTO_RELATED_START = "<!-- bastra:auto-related:start -->";
export const SUMMARY_MAX = 400; // core summary.ts — longer is refused, never cut
/** Types a memory can take here; documents and bookmarks keep theirs (core MemoryTypeEnum). */
export const TYPES = [
  "lesson",
  "preference",
  "project-fact",
  "meta-working",
  "decision",
  "workflow",
  "reference",
  "user-preference",
];
export const SENSITIVITIES = ["public", "team", "private"];

const str = (v) => (typeof v === "string" ? v : "");

/** The authored part of a memory body (without the generated block). */
export function authoredBody(body) {
  const text = str(body),
    i = text.indexOf(AUTO_RELATED_START);
  return (i < 0 ? text : text.slice(0, text.lastIndexOf("\n", i) + 1)).trim();
}

/** Whether the rule fields may be edited: a rule or a plain note. A pending
 *  proposal is decided with accept / reject, an inactive memory not at all. */
export const ruleEditable = (rule) => rule?.state === "rule" || rule?.state === "note";

/** The editable fields of a node detail (GET /ui/graph/node). */
export function editFields(d) {
  const rule = d?.rule?.state === "rule" ? d.rule : null;
  return {
    body: authoredBody(d?.body),
    summary: str(d?.summary),
    tags: (Array.isArray(d?.tags) ? d.tags.filter((x) => typeof x === "string") : []).join(", "),
    rulebook: rule ? str(rule.rulebook) || "on-demand" : "",
    applies_when: rule ? str(rule.applies_when) : "",
    ...ownFields(d),
  };
}

/** Title, type, sensitivity and recall mode of a node detail (#1558). */
function ownFields(d) {
  return {
    title: str(d?.title),
    type: str(d?.type),
    sensitivity: str(d?.sensitivity) || "team", // the schema's default
    recall_mode: d?.recall_mode === "reflex" ? "reflex" : "deliberate",
  };
}

/** Whether the type may be changed here (not for documents and bookmarks). */
export const typeEditable = (type) => TYPES.includes(type);

export const splitTags = (text) =>
  str(text)
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

export const editInit = () => ({
  mode: "view",
  base: null,
  revision: null,
  rule: null,
  draft: null,
  stash: null,
  error: null,
  confirm: false,
});

const open = (s) => s.mode === "edit" || s.mode === "conflict";

// One handler per event; each leaves the state alone where it does not apply.
const STEPS = {
  // a (fresh) detail while viewing; an open editor keeps its base
  load: (s, ev) =>
    s.mode === "view"
      ? { ...s, base: editFields(ev.detail), revision: ev.detail.revision ?? null, rule: ev.detail.rule ?? null }
      : s,
  edit: (s) =>
    s.mode === "view" && s.base && s.revision ? { ...s, mode: "edit", draft: { ...s.base }, error: null } : s,
  input: (s, ev) => (open(s) ? { ...s, draft: { ...s.draft, [ev.field]: ev.value }, confirm: false } : s),
  cancel: (s) => (open(s) ? { ...s, mode: "view", draft: null, stash: null, error: null, confirm: false } : s),
  // a change to the rule effect asks once in the same place before it is saved
  save: (s) =>
    s.mode !== "edit"
      ? s
      : ruleShift(s) && !s.confirm
        ? { ...s, confirm: true }
        : { ...s, mode: "saving", error: null, confirm: false },
  saved: (s, ev) =>
    s.mode === "saving"
      ? { ...s, mode: "view", base: s.draft, revision: ev.revision, rule: ev.rule ?? s.rule, draft: null, stash: null }
      : s,
  failed: (s, ev) => (s.mode === "saving" ? { ...s, mode: "edit", error: ev.error } : s),
  conflict: (s) => (s.mode === "saving" ? { ...s, mode: "conflict", error: "mb.ed.conflict" } : s),
  reloaded: (s, ev) => reloaded(s, ev.detail),
  useStash: (s) => (s.mode === "edit" && s.stash ? { ...s, draft: s.stash, stash: null, confirm: false } : s),
};

/** One step of the editor. */
export function editStep(s, ev) {
  return Object.hasOwn(STEPS, ev.type) ? STEPS[ev.type](s, ev) : s;
}

function reloaded(s, d) {
  if (s.mode !== "conflict") return s;
  const base = editFields(d);
  return {
    ...s,
    mode: "edit",
    base,
    revision: d.revision ?? null,
    rule: d.rule ?? null,
    draft: { ...base },
    stash: s.draft,
    error: null,
    confirm: false,
  };
}

// ── the change set ──
const same = (a, b) => str(a).replace(/\r\n?/g, "\n").trim() === str(b).replace(/\r\n?/g, "\n").trim();

function textChanges(d, b) {
  const out = {};
  if (!same(d.body, b.body)) out.body = d.body;
  if (same(d.summary, b.summary)) return { out };
  const summary = d.summary.trim();
  if (!summary) return { error: "mb.ed.needSummary" };
  if (summary.length > SUMMARY_MAX) return { error: "mb.ed.summaryLong" };
  return { out: { ...out, summary } };
}

function tagChanges(d, b) {
  const tags = splitTags(d.tags);
  if (tags.join("\n") === splitTags(b.tags).join("\n")) return { out: {} };
  return tags.length ? { out: { tags } } : { error: "mb.ed.needTag" };
}

function ruleChanges(d, b) {
  if (d.rulebook === b.rulebook && same(d.applies_when, b.applies_when)) return { out: {} };
  if (!d.rulebook) return { out: {} }; // a rule is not removed here (the daemon has no such edit)
  if (!d.applies_when.trim()) return { error: "mb.ed.needWhen" };
  return { out: { rule: { rulebook: d.rulebook, applies_when: d.applies_when.trim() } } };
}

/** Title, type, sensitivity and recall mode (#1558): only what changed. */
function fieldChanges(d, b) {
  const out = {};
  if (d.title.trim() !== b.title.trim()) {
    if (!d.title.trim()) return { error: "mb.ed.needTitle" };
    out.title = d.title.trim();
  }
  for (const k of ["type", "sensitivity", "recall_mode"]) if (d[k] !== b[k]) out[k] = d[k];
  return { out };
}

/** The request for a save: { payload } (null when nothing changed) or
 *  { error: i18n key } when a field is not valid. */
export function editPatch(s, id) {
  if (!s.draft || !s.base) return { payload: null };
  const parts = [
    fieldChanges(s.draft, s.base),
    textChanges(s.draft, s.base),
    tagChanges(s.draft, s.base),
    ruleChanges(s.draft, s.base),
  ];
  const bad = parts.find((p) => p.error);
  if (bad) return { error: bad.error };
  const changes = Object.assign({}, ...parts.map((p) => p.out));
  return { payload: Object.keys(changes).length ? { id, expected_revision: s.revision, ...changes } : null };
}

/** How a save would change the rule effect through type or recall mode:
 *  "gain" (becomes an on-demand rule), "loss" (is no longer a rule) or null.
 *  The daemon sends the membership per pair (`rule.by_type_mode`) only where
 *  those two fields decide it; an explicit rule edit in the same save wins. */
export function ruleShift(s) {
  const map = s.rule?.by_type_mode;
  if (!map || !s.draft || !s.base) return null;
  if (ruleChanges(s.draft, s.base).out?.rule) return null;
  const key = (f) => `${f.type} ${f.recall_mode}`;
  const before = map[key(s.base)],
    after = map[key(s.draft)];
  if (typeof before !== "boolean" || typeof after !== "boolean" || before === after) return null;
  return after ? "gain" : "loss";
}

/** What the controls show. */
export function editView(s, id) {
  const patch = open(s) ? editPatch(s, id) : { payload: null };
  return {
    editing: s.mode !== "view",
    saving: s.mode === "saving",
    conflict: s.mode === "conflict",
    dirty: !!patch.payload,
    canSave: s.mode === "edit" && !!patch.payload,
    invalid: patch.error ?? null,
    error: s.error,
    stash: !!s.stash,
    ruleShift: s.mode === "edit" && patch.payload ? ruleShift(s) : null,
    confirm: s.mode === "edit" && s.confirm,
  };
}

/** The daemon's answer to a write → { ok, revision, rule } | { conflict } | { error: i18n key }.
 *  `status` 0 = no answer at all. 404/405 can also be a daemon that predates the route. */
export function writeOutcome(status, body) {
  if (status >= 200 && status < 300)
    return { ok: true, revision: body?.revision ?? null, rule: body?.rule ?? null, body };
  if (status === 409) return { conflict: true };
  if (status === 400) return { error: "mb.ed.invalid", detail: str(body?.error) };
  if (status === 413) return { error: "mb.ed.tooLong" };
  if (status === 404 || status === 405) return { error: "mb.ed.gone" };
  if (status === 0) return { error: "mb.ed.offline" };
  return { error: "mb.ed.fail" };
}

/** After archiving `id`: the memory to show next (the following row, else
 *  the one before), or null when the list is then empty. */
export function nextSelection(order, id) {
  const i = order.indexOf(id);
  if (i < 0) return null;
  return order[i + 1] ?? order[i - 1] ?? null;
}
