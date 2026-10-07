import test from "node:test";
import assert from "node:assert/strict";
import { isSystemInjectedTurn, ownerPromptText } from "../src/system-turn.js";
import { parseTranscriptFile } from "../src/stop-transcript.js";

test("B2: complete observed harness forms stay injected, typed opening mentions stay user text", () => {
  const typed = [
    "# AGENTS.md instructions are outdated, please rewrite them",
    "<turn_aborted> shows up in my logs",
    "# AGENTS.md instructions for /work/fixture are outdated, please rewrite them",
  ];
  for (const text of typed) {
    assert.equal(isSystemInjectedTurn(text), false);
    assert.equal(ownerPromptText(text), text);
    for (const row of [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
      { type: "user", message: { role: "user", content: text } },
    ]) assert.equal(parseTranscriptFile(JSON.stringify(row))[0].role, "user");
  }
  const injected = [
    "# AGENTS.md instructions for /work/fixture\n\n<INSTRUCTIONS>\nKeep generated files separate.\n</INSTRUCTIONS>",
    "# AGENTS.md instructions for /work/fixture\n\n## Development\nKeep generated files separate.\n",
    "<turn_aborted>\nThe preceding operation was stopped before completion.\n</turn_aborted>",
  ];
  for (const text of injected) {
    assert.equal(isSystemInjectedTurn(text), true);
    assert.equal(ownerPromptText(text), null);
    assert.equal(parseTranscriptFile(JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }))[0].role, "system-injected");
  }
});
