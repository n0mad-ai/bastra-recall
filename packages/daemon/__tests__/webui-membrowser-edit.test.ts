// #1446: editing a memory in the memory browser's reader, as pure logic —
// view → edit → save → saved | failed | conflict → reload (draft kept aside)
// → put the draft back, and the change set a save sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { AUTO_RELATED_START, MemoryTypeEnum, SUMMARY_MAX } from "@bastra-recall/core";

const NAMES =
  "AUTO_RELATED_START, SUMMARY_MAX, TYPES, SENSITIVITIES, authoredBody, editFields, editInit, editStep, editPatch, editView, writeOutcome, nextSelection, ruleEditable, splitTags, typeEditable";

async function load() {
  const source = await readFile(new URL("../webui/app/js/views/membrowser-edit-model.js", import.meta.url), "utf8");
  return runInNewContext(source.replace(/^export /gm, "") + `\n({${NAMES}})`, {});
}

const detail = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  revision: "sha256:0000000000000001",
  summary: "Old summary",
  tags: ["alpha", "beta"],
  body: `\nOld text.\n\n${AUTO_RELATED_START}\n- [[x]]\n<!-- bastra:auto-related:end -->\n`,
  rule: { state: "note" },
  ...over,
});

test("the model mirrors the daemon's constants", async () => {
  const m = await load();
  assert.equal(m.AUTO_RELATED_START, AUTO_RELATED_START);
  assert.equal(m.SUMMARY_MAX, SUMMARY_MAX);
});

test("fields: only the authored text, tags as a list, rule fields for rules only", async () => {
  const m = await load();
  const f = m.editFields(detail());
  assert.equal(f.body, "Old text.", "the generated block is not offered for editing");
  assert.equal(f.tags, "alpha, beta");
  assert.equal(f.rulebook, "");
  const rule = m.editFields(detail({ rule: { state: "rule", rulebook: "always", applies_when: "Before X." } }));
  assert.deepEqual([rule.rulebook, rule.applies_when], ["always", "Before X."]);
  assert.equal(m.ruleEditable({ state: "proposal" }), false, "a proposal is accepted or rejected, not edited");
  assert.equal(m.ruleEditable({ state: "inactive" }), false);
  assert.deepEqual([...m.splitTags(" a, b ,,\nc ")], ["a", "b", "c"]);
});

test("view → edit → save → saved: the change set holds only what changed, with the revision", async () => {
  const m = await load();
  let s = m.editStep(m.editInit(), { type: "edit" });
  assert.equal(s.mode, "view", "no editing before the detail (and its revision) is there");
  s = m.editStep(s, { type: "load", detail: detail() });
  s = m.editStep(s, { type: "edit" });
  assert.equal(s.mode, "edit");
  assert.equal(m.editView(s, "m1").canSave, false, "nothing changed yet");
  s = m.editStep(s, { type: "input", field: "body", value: "New text." });
  s = m.editStep(s, { type: "input", field: "tags", value: "alpha, gamma" });
  const { payload } = m.editPatch(s, "m1");
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    id: "m1",
    expected_revision: "sha256:0000000000000001",
    body: "New text.",
    tags: ["alpha", "gamma"],
  });
  assert.equal(m.editView(s, "m1").canSave, true);
  s = m.editStep(s, { type: "save" });
  assert.equal(m.editView(s, "m1").saving, true);
  assert.equal(
    m.editStep(s, { type: "input", field: "body", value: "typed late" }),
    s,
    "fields are frozen while saving"
  );
  s = m.editStep(s, { type: "saved", revision: "sha256:0000000000000002", rule: { state: "note" } });
  assert.equal(s.mode, "view");
  assert.equal(s.revision, "sha256:0000000000000002", "the next edit builds on the saved state");
  assert.equal(s.base.body, "New text.");
});

test("cancel drops the draft; a failed save keeps it with the message", async () => {
  const m = await load();
  let s = m.editStep(m.editStep(m.editInit(), { type: "load", detail: detail() }), { type: "edit" });
  s = m.editStep(s, { type: "input", field: "summary", value: "Changed" });
  const cancelled = m.editStep(s, { type: "cancel" });
  assert.equal(cancelled.mode, "view");
  assert.equal(cancelled.draft, null);
  s = m.editStep(m.editStep(s, { type: "save" }), { type: "failed", error: "mb.ed.offline" });
  assert.equal(s.mode, "edit");
  assert.equal(s.draft.summary, "Changed");
  assert.equal(m.editView(s, "m1").error, "mb.ed.offline");
});

test("conflict keeps the draft; reload shows the current version and keeps the draft aside to put back", async () => {
  const m = await load();
  let s = m.editStep(m.editStep(m.editInit(), { type: "load", detail: detail() }), { type: "edit" });
  s = m.editStep(s, { type: "input", field: "body", value: "My draft." });
  s = m.editStep(m.editStep(s, { type: "save" }), { type: "conflict" });
  assert.equal(s.mode, "conflict");
  assert.equal(s.draft.body, "My draft.", "nothing the user typed is lost");
  const v = m.editView(s, "m1");
  assert.equal(v.conflict, true);
  assert.equal(v.canSave, false, "no blind second save over the other change");
  assert.equal(m.editStep(s, { type: "save" }), s);
  s = m.editStep(s, {
    type: "reloaded",
    detail: detail({ revision: "sha256:0000000000000009", body: "\nTheir change.\n" }),
  });
  assert.equal(s.mode, "edit");
  assert.equal(s.draft.body, "Their change.");
  assert.equal(s.revision, "sha256:0000000000000009");
  assert.equal(m.editView(s, "m1").stash, true);
  s = m.editStep(s, { type: "useStash" });
  assert.equal(s.draft.body, "My draft.");
  assert.equal(m.editPatch(s, "m1").payload.expected_revision, "sha256:0000000000000009");
});

test("a detail refresh does not touch an open editor", async () => {
  const m = await load();
  let s = m.editStep(m.editStep(m.editInit(), { type: "load", detail: detail() }), { type: "edit" });
  s = m.editStep(s, { type: "input", field: "body", value: "Draft." });
  const after = m.editStep(s, { type: "load", detail: detail({ revision: "sha256:00000000000000ff" }) });
  assert.equal(after, s);
});

test("validation: empty or long summary, no tags, a rule without 'applies when' are refused, nothing cut", async () => {
  const m = await load();
  const open = (field: string, value: string, d = detail()) =>
    m.editStep(m.editStep(m.editStep(m.editInit(), { type: "load", detail: d }), { type: "edit" }), {
      type: "input",
      field,
      value,
    });
  assert.equal(m.editPatch(open("summary", "  "), "m1").error, "mb.ed.needSummary");
  assert.equal(m.editPatch(open("summary", "x".repeat(401)), "m1").error, "mb.ed.summaryLong");
  assert.equal(m.editPatch(open("summary", "x".repeat(400)), "m1").payload.summary.length, 400);
  assert.equal(m.editPatch(open("tags", " , "), "m1").error, "mb.ed.needTag");
  assert.equal(m.editPatch(open("rulebook", "always"), "m1").error, "mb.ed.needWhen");
  const v = m.editView(open("tags", ""), "m1");
  assert.deepEqual([v.canSave, v.invalid], [false, "mb.ed.needTag"]);
  let s = open("rulebook", "on-demand");
  s = m.editStep(s, { type: "input", field: "applies_when", value: " When fixtures change. " });
  assert.deepEqual(JSON.parse(JSON.stringify(m.editPatch(s, "m1").payload.rule)), {
    rulebook: "on-demand",
    applies_when: "When fixtures change.",
  });
});

test("answers and the selection after an archive", async () => {
  const m = await load();
  assert.equal(m.writeOutcome(200, { revision: "r", rule: null }).ok, true);
  assert.equal(m.writeOutcome(409, { conflict: true }).conflict, true);
  assert.deepEqual({ ...m.writeOutcome(400, { error: "tags: x" }) }, { error: "mb.ed.invalid", detail: "tags: x" });
  assert.equal(m.writeOutcome(413, null).error, "mb.ed.tooLong");
  assert.equal(m.writeOutcome(404, null).error, "mb.ed.gone");
  assert.equal(m.writeOutcome(0, null).error, "mb.ed.offline");
  assert.equal(m.writeOutcome(500, null).error, "mb.ed.fail");
  assert.equal(m.nextSelection(["a", "b", "c"], "b"), "c");
  assert.equal(m.nextSelection(["a", "b", "c"], "c"), "b");
  assert.equal(m.nextSelection(["a"], "a"), null, "an empty list shows the hint, not a ghost");
});

// ── #1558: title, type, sensitivity and recall mode ──

test("the offered types and sensitivities mirror the daemon's schema (documents and bookmarks excluded)", async () => {
  const m = await load();
  assert.deepEqual(
    [...m.TYPES],
    MemoryTypeEnum.options.filter((x) => x !== "doc" && x !== "bookmark")
  );
  assert.deepEqual([...m.SENSITIVITIES], ["public", "team", "private"]);
  assert.equal(m.typeEditable("lesson"), true);
  assert.equal(m.typeEditable("doc"), false);
  assert.equal(m.typeEditable("bookmark"), false);
});

test("title, type, sensitivity and recall mode: read from the detail, sent only when changed", async () => {
  const m = await load();
  const d = detail({ title: "Old title", type: "lesson", sensitivity: "team", recall_mode: null });
  const f = m.editFields(d);
  assert.deepEqual([f.title, f.type, f.sensitivity, f.recall_mode], ["Old title", "lesson", "team", "deliberate"]);
  assert.equal(m.editFields(detail({ sensitivity: undefined })).sensitivity, "team", "the schema default");
  let s = m.editStep(m.editInit(), { type: "load", detail: d });
  s = m.editStep(s, { type: "edit" });
  s = m.editStep(s, { type: "input", field: "title", value: "  New title " });
  s = m.editStep(s, { type: "input", field: "sensitivity", value: "private" });
  s = m.editStep(s, { type: "input", field: "recall_mode", value: "reflex" });
  assert.deepEqual(JSON.parse(JSON.stringify(m.editPatch(s, "m1").payload)), {
    id: "m1",
    expected_revision: "sha256:0000000000000001",
    title: "New title",
    sensitivity: "private",
    recall_mode: "reflex",
  });
  s = m.editStep(s, { type: "input", field: "title", value: "Old title" });
  s = m.editStep(s, { type: "input", field: "sensitivity", value: "team" });
  s = m.editStep(s, { type: "input", field: "recall_mode", value: "deliberate" });
  s = m.editStep(s, { type: "input", field: "type", value: "decision" });
  assert.deepEqual(JSON.parse(JSON.stringify(m.editPatch(s, "m1").payload)), {
    id: "m1",
    expected_revision: "sha256:0000000000000001",
    type: "decision",
  });
  s = m.editStep(s, { type: "input", field: "title", value: "   " });
  assert.equal(m.editPatch(s, "m1").error, "mb.ed.needTitle");
  assert.equal(m.editView(s, "m1").canSave, false);
});

test("a conflict keeps the changed title aside; reload shows the current one, the draft can be put back", async () => {
  const m = await load();
  let s = m.editStep(m.editInit(), { type: "load", detail: detail({ title: "Old title", type: "lesson" }) });
  s = m.editStep(s, { type: "edit" });
  s = m.editStep(s, { type: "input", field: "title", value: "My title" });
  s = m.editStep(s, { type: "save" });
  s = m.editStep(s, { type: "conflict" });
  assert.equal(s.draft.title, "My title", "the draft stays");
  s = m.editStep(s, {
    type: "reloaded",
    detail: detail({ title: "Their title", type: "lesson", revision: "sha256:0000000000000002" }),
  });
  assert.equal(s.draft.title, "Their title");
  s = m.editStep(s, { type: "useStash" });
  assert.equal(s.draft.title, "My title");
  assert.equal(m.editPatch(s, "m1").payload.expected_revision, "sha256:0000000000000002");
});
