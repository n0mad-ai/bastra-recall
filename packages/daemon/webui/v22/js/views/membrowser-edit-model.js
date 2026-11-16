// Editing a memory in the reader (#1446), as pure logic: the editable fields
// of a node detail, the editor's states, the change set a save sends to
// POST /ui/memory/edit and how the daemon's answer is read.
//
// States: "view" → edit → "edit" → save → "saving" → saved "view"
//                                                   | failed "edit" (message)
//                                                   | conflict "conflict"
// "conflict" keeps the draft; reloaded → "edit" on the current version with
// the draft kept aside (`stash`), useStash puts it back. cancel → "view".
// What the daemon cannot change here (title, type, area, sensitivity, recall
// mode) is not a field at all.

// The daemon's auto-related block (core save-text.ts AUTO_RELATED_START) is
// generated; the editor shows and replaces only the text above it.
export const AUTO_RELATED_START = "<!-- bastra:auto-related:start -->";
export const SUMMARY_MAX = 400; // core summary.ts — longer is refused, never cut

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
  };
}

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
  input: (s, ev) => (open(s) ? { ...s, draft: { ...s.draft, [ev.field]: ev.value } } : s),
  cancel: (s) => (open(s) ? { ...s, mode: "view", draft: null, stash: null, error: null } : s),
  save: (s) => (s.mode === "edit" ? { ...s, mode: "saving", error: null } : s),
  saved: (s, ev) =>
    s.mode === "saving"
      ? { ...s, mode: "view", base: s.draft, revision: ev.revision, rule: ev.rule ?? s.rule, draft: null, stash: null }
      : s,
  failed: (s, ev) => (s.mode === "saving" ? { ...s, mode: "edit", error: ev.error } : s),
  conflict: (s) => (s.mode === "saving" ? { ...s, mode: "conflict", error: "mb.ed.conflict" } : s),
  reloaded: (s, ev) => reloaded(s, ev.detail),
  useStash: (s) => (s.mode === "edit" && s.stash ? { ...s, draft: s.stash, stash: null } : s),
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

/** The request for a save: { payload } (null when nothing changed) or
 *  { error: i18n key } when a field is not valid. */
export function editPatch(s, id) {
  if (!s.draft || !s.base) return { payload: null };
  const parts = [textChanges(s.draft, s.base), tagChanges(s.draft, s.base), ruleChanges(s.draft, s.base)];
  const bad = parts.find((p) => p.error);
  if (bad) return { error: bad.error };
  const changes = Object.assign({}, ...parts.map((p) => p.out));
  return { payload: Object.keys(changes).length ? { id, expected_revision: s.revision, ...changes } : null };
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
