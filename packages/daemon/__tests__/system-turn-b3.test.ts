import test from "node:test";
import assert from "node:assert/strict";
import { isSystemInjectedTurn } from "../src/system-turn.js";

test("B3 prerequisite: instruction headers require a path shape, not prose", () => {
  for (const text of [
    "# AGENTS.md instructions for my repo\n\nPlease rewrite the documentation.",
    "# AGENTS.md instructions for /work/fixture are outdated\n\nPlease rewrite them.",
  ]) assert.equal(isSystemInjectedTurn(text), false);
  for (const path of ["/work/fixture", "C:\\work\\fixture", "C:/work/fixture", "\\\\server\\share\\fixture", "~/work/fixture"]) {
    assert.equal(isSystemInjectedTurn(`# AGENTS.md instructions for ${path}\n\nKeep generated files separate.`), true);
  }
});
