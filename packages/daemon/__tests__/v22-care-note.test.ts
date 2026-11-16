// UI v2 vault care: the note field's "improve text" / undo states and the
// view → edit → save/cancel states of a saved flag, as pure logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

async function load(file: string, names: string) {
  const source = await readFile(new URL(`../webui/v22/js/views/${file}`, import.meta.url), "utf8");
  return runInNewContext(source.replace(/^import .*;$/gm, "").replace(/^export /gm, "") + `\n({${names}})`, {
    h() {},
    growTextarea() {},
    t: (key: string) => key,
    noteEditor() {},
  });
}

test("note field: improve → working → result with undo; typing or saving drops undo", async () => {
  const { noteInit, noteStep, noteView } = await load("care-note.js", "noteInit, noteStep, noteView");
  let s = noteInit("ähm also bitte, äh, prüfen");
  assert.deepEqual(
    { ...noteView(s) },
    { working: false, canImprove: true, canUndo: false, canSave: true, error: null }
  );

  s = noteStep(s, { type: "improve" });
  assert.equal(noteView(s).working, true);
  assert.equal(noteView(s).canImprove, false, "no second request while the model works");
  assert.equal(noteView(s).canSave, false);
  assert.equal(noteStep(s, { type: "improve" }), s, "a second click changes nothing");
  assert.equal(noteStep(s, { type: "input", text: "typed meanwhile" }), s, "the field is frozen while working");

  s = noteStep(s, { type: "improved", text: "Bitte prüfen." });
  assert.equal(s.text, "Bitte prüfen.");
  assert.equal(noteView(s).canUndo, true);

  const undone = noteStep(s, { type: "undo" });
  assert.equal(undone.text, "ähm also bitte, äh, prüfen", "undo restores the original");
  assert.equal(noteView(undone).canUndo, false);

  const typed = noteStep(s, { type: "input", text: "Bitte prüfen. Danke" });
  assert.equal(noteView(typed).canUndo, false, "typing on ends the undo offer");
  assert.equal(typed.text, "Bitte prüfen. Danke");

  const saved = noteStep(s, { type: "saved" });
  assert.equal(noteView(saved).canUndo, false, "saving ends the undo offer");
  assert.equal(saved.text, "Bitte prüfen.");
});

test("note field: a failed improve keeps the original text and shows the reason", async () => {
  const { noteInit, noteStep, noteView, improveError } = await load(
    "care-note.js",
    "noteInit, noteStep, noteView, improveError"
  );
  let s = noteStep(noteInit("original text"), { type: "improve" });
  s = noteStep(s, { type: "failed", error: improveError(503) });
  assert.equal(s.text, "original text");
  assert.equal(noteView(s).error, "mb.improveNoModel");
  assert.equal(noteView(s).canImprove, true, "can try again");
  assert.equal(improveError(504), "mb.improveSlow");
  assert.equal(improveError(413), "mb.improveTooLong");
  assert.equal(improveError(0), "mb.improveFail");
  assert.equal(improveError(502), "mb.improveFail");
  assert.equal(noteStep(s, { type: "input", text: "x" }).error, null, "typing clears the message");
  // late answers after the field moved on are ignored
  assert.equal(noteStep(noteInit("a"), { type: "improved", text: "b" }).text, "a");
});

test("note field: empty text cannot be improved; editing a saved note needs text to save", async () => {
  const { noteInit, noteStep, noteView } = await load("care-note.js", "noteInit, noteStep, noteView");
  const empty = noteInit("  \n ");
  assert.equal(noteView(empty).canImprove, false);
  assert.equal(noteStep(empty, { type: "improve" }), empty);
  assert.equal(noteView(empty).canSave, true, "a new delete/edit flag may go without a note");
  assert.equal(noteView(empty, true).canSave, false, "an edited note is never saved empty");
  assert.equal(noteView(noteInit("x"), true).canSave, true);
});

test("saved flag: view → edit → cancel/save → view; save errors by status", async () => {
  const { flagStep, careSaveError } = await load("membrowser-care.js", "flagStep, careSaveError");
  assert.equal(flagStep("view", { type: "edit" }), "edit");
  assert.equal(flagStep("edit", { type: "cancel" }), "view");
  assert.equal(flagStep("edit", { type: "saved" }), "view");
  assert.equal(flagStep("view", { type: "cancel" }), "view");
  assert.equal(flagStep("edit", { type: "edit" }), "edit");
  assert.equal(careSaveError(409), "mb.careConflict");
  assert.equal(careSaveError(413), "mb.careTooLong");
  assert.equal(careSaveError(0), "mb.careFail");
});
