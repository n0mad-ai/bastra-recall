import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { dropSuggestionsAfterSave, type SaveSuggestion } from "../src/stop-heuristics.js";
import type { TranscriptTurn } from "../src/stop-lane.js";

const SUGGESTION = {
  heuristic: "architecture-decision",
  summary: "Decision-language in the last 1 user turns",
  body: "x",
} as unknown as SaveSuggestion;

const user = (content: string): TranscriptTurn => ({ role: "user", content });
const assistant = (content: string, tools?: string[]): TranscriptTurn => ({ role: "assistant", content, ...(tools ? { tools } : {}) });

describe("#1376: no save suggestion after a save in the same round", () => {
  it("keeps the suggestion when no save tool ran after the latest user turn", () => {
    const turns = [user("we decided on option B"), assistant("ok", ["Read"])];
    assert.deepEqual(dropSuggestionsAfterSave(turns, [SUGGESTION]), [SUGGESTION]);
  });

  for (const tool of ["save_memory", "mcp__bastra-recall__save_memory", "edit_memory", "mcp__bastra-recall__edit_memory"]) {
    it(`drops the suggestion when ${tool} ran after the latest user turn`, () => {
      const turns = [user("we decided on option B"), assistant("saved", [tool])];
      assert.deepEqual(dropSuggestionsAfterSave(turns, [SUGGESTION]), []);
    });
  }

  it("keeps the suggestion when the save belongs to an earlier round", () => {
    const turns = [user("a"), assistant("saved", ["save_memory"]), user("we decided on option B"), assistant("ok")];
    assert.deepEqual(dropSuggestionsAfterSave(turns, [SUGGESTION]), [SUGGESTION]);
  });

  it("ignores a prose mention of save_memory", () => {
    const turns = [user("we decided on option B"), assistant("I will call save_memory next")];
    assert.deepEqual(dropSuggestionsAfterSave(turns, [SUGGESTION]), [SUGGESTION]);
  });
});
