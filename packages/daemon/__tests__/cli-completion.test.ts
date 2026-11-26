/**
 * `bastra completion` (#21) — and the drift gate that keeps it honest.
 *
 * A completion script is a copy of the CLI's vocabulary, and copies rot. The
 * failure is quiet and user-facing: Tab keeps offering last release's commands
 * while silently omitting the new one, and it reads as authoritative because
 * it comes from the tool itself. So the real test here is not "does it emit
 * bash syntax" — it is "does COMMANDS still match the dispatch table".
 *
 * Runner: `tsx --test __tests__/cli-completion.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COMMANDS, SURFACES, SHELLS, completionScript, isShell } from "../src/cli/completion.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The commands cli.ts actually dispatches on, read from the source. */
async function dispatchedCommands(): Promise<Set<string>> {
  const src = await readFile(join(here, "..", "src", "cli.ts"), "utf8");
  // The switches over args.command (dispatch and the functions it hands on to),
  // up to the last default branch, so later helpers cannot leak in.
  const body = src.slice(src.indexOf("switch (args.command)"), src.lastIndexOf("error: unknown command"));
  const found = new Set<string>();
  for (const m of body.matchAll(/case\s+"([a-z-]+)"/g)) found.add(m[1]);
  return found;
}

test("completion: every dispatched command is offered by Tab (drift gate)", async () => {
  const dispatched = await dispatchedCommands();
  assert.ok(dispatched.size > 10, "sanity: the dispatch table was parsed");

  const offered = new Set<string>(COMMANDS);
  const missing = [...dispatched].filter((c) => !offered.has(c));
  assert.deepEqual(
    missing,
    [],
    `these commands dispatch but are not completable — add them to COMMANDS in cli/completion.ts: ${missing.join(", ")}`
  );
});

test("completion: nothing is offered that the CLI would reject", async () => {
  const dispatched = await dispatchedCommands();
  // `help` is handled before the switch, so it never appears as a case.
  const alsoValid = new Set([...dispatched, "help"]);
  const phantom = COMMANDS.filter((c) => !alsoValid.has(c));
  assert.deepEqual(phantom, [], `completion offers commands the CLI does not accept: ${phantom.join(", ")}`);
});

test("completion: each shell gets a script that carries the vocabulary", () => {
  for (const shell of SHELLS) {
    const script = completionScript(shell);
    assert.ok(script.length > 100, `${shell}: script is suspiciously short`);
    for (const cmd of ["install", "doctor", "logs", "onboard"]) {
      assert.ok(script.includes(cmd), `${shell}: script omits '${cmd}'`);
    }
    for (const surface of SURFACES) {
      assert.ok(script.includes(surface), `${shell}: script omits surface '${surface}'`);
    }
  }
});

test("completion: shell scripts carry their own install instructions", () => {
  // Someone runs `bastra completion zsh`, sees output, and needs to know what
  // to do with it — without that line the command is a riddle.
  for (const shell of SHELLS) {
    assert.match(completionScript(shell), /install:/, `${shell}: no install hint in the emitted script`);
  }
});

test("completion: zsh script starts with the compdef line zsh requires", () => {
  // Without #compdef on the very first line, dropping the file into fpath does
  // nothing at all — and it fails silently.
  assert.ok(completionScript("zsh").startsWith("#compdef bastra"));
});

test("completion: unknown shells are rejected, not guessed at", () => {
  assert.equal(isShell("bash"), true);
  assert.equal(isShell("powershell"), false);
  assert.equal(isShell(""), false);
});
