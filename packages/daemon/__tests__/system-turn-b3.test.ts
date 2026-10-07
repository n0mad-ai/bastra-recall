import test from "node:test";
import assert from "node:assert/strict";
import { isSystemInjectedTurn } from "../src/system-turn.js";

test("B3: AGENTS headers follow the fixed path-prefix rule, including whitespace and relative paths", () => {
  for (const text of [
    "# AGENTS.md instructions for my repo\n\nPlease rewrite the documentation.",
    "# AGENTS.md instructions for the team\n\nPlease rewrite the documentation.",
    "# AGENTS.md instructions are outdated, please rewrite them",
  ]) assert.equal(isSystemInjectedTurn(text), false);
  for (const path of [
    "/work/fixture", "/Users/Fixture User/Fixture Project", "C:\\Users\\Fixture User\\proj",
    "C:\\Program Files\\x", "C:/work/Fixture Project", "~/Fixture Projects/x",
    "/Users/x/Library/Application Support/app", "\\\\server\\share with spaces\\fixture",
    "\\work\\fixture", "/work/fixture ", "/work/fixture\t", ".", "./sub", "../sub",
  ]) assert.equal(isSystemInjectedTurn(`# AGENTS.md instructions for ${path}\n\nKeep generated files separate.`), true, path);
  // Documented boundary: path-shaped prose is deliberately treated as injected.
  assert.equal(isSystemInjectedTurn("# AGENTS.md instructions for /work/fixture are outdated\n\nPlease rewrite them."), true);
  assert.equal(isSystemInjectedTurn("# AGENTS.md instructions for /work/fixture\nNo blank line."), false);
  assert.equal(isSystemInjectedTurn("# AGENTS.md instructions for /work/fixture\n\n"), false);
});
