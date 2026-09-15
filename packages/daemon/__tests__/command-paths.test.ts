/**
 * Hook commands are matched on forward slashes whatever the platform wrote.
 * The Windows install writes `C:\…\dist\session-hook.js` into both the command
 * AND every adapter's own bin table (`path.resolve` on win32), so both sides of
 * a comparison have to go through the same normalisation.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/command-paths.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { win32 } from "node:path";
import { fileOf, slashes } from "../src/cli/adapters/command-paths.js";
import { registeredCodexHookFiles } from "../src/cli/adapters/codex.js";
import { hookDefinitions, missingRequiredHookRegistrations, registeredHookBins, stubSubcommandForFile } from "../src/cli/adapters/claude-code.js";

const WIN_DIST = "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\bastra-recall\\node_modules\\@bastra-recall\\daemon\\dist";

test("fileOf reads the file name out of a win32 bin exactly as path.resolve builds it", () => {
  const bin = win32.resolve(WIN_DIST, "session-hook.js");
  assert.equal(fileOf(bin), "session-hook.js");
  assert.equal(fileOf("/opt/homebrew/opt/bastra-recall/libexec/packages/daemon/dist/hook.js"), "hook.js");
  assert.equal(slashes(bin), bin.replaceAll("\\", "/"));
});

test("Codex: hooks registered with Windows paths are all recognised", () => {
  const entry = (file: string) => ({
    hooks: [{ type: "command", command: `BASTRA_HOOK_CLIENT=codex node ${WIN_DIST}\\${file}`, statusMessage: "Bastra Recall · x" }],
  });
  const files = ["session-hook.js", "prompt-hook.js", "hook.js", "todo-hook.js", "bash-pre-hook.js", "bash-fail-hook.js"];
  const hooks = { SessionStart: [entry(files[0])], UserPromptSubmit: [entry(files[1])], PreToolUse: files.slice(2, 5).map(entry), PostToolUse: [entry(files[5])] };
  assert.deepEqual([...registeredCodexHookFiles(hooks)].sort(), [...files].sort());
});

test("Claude Code: a Windows entry without the __bastraRecall marker is still ours", () => {
  // Hand-written or pre-marker settings carry only the command. Ownership then
  // rests on the path, which the marker had been hiding in every other fixture.
  // A source checkout path, so the name-based fallback ("bastra-recall" + "hook") cannot carry it.
  const hooks = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node D:\\src\\recall\\packages\\daemon\\dist\\bash-pre-hook.js" }] }] };
  assert.equal(registeredHookBins(hooks).has("bash-pre-hook.js"), true);
});

test("Claude Code: the definitions table itself in win32 form still matches its own registrations", () => {
  // On Windows `path.resolve` builds every def.bin with backslashes — the other
  // side of each comparison. CI runs on Linux, so the table is built here as
  // Windows builds it.
  const winDefs = hookDefinitions({ includeStop: true }).map((d) => ({ ...d, bin: win32.resolve(WIN_DIST, fileOf(d.bin)) }));
  const settings: Record<string, unknown[]> = {};
  for (const def of winDefs) {
    (settings[def.event] ??= []).push({ ...(def.matcher ? { matcher: def.matcher } : {}), hooks: [{ type: "command", command: `node ${def.bin}` }] });
  }
  assert.deepEqual(missingRequiredHookRegistrations(settings, winDefs), []);
  assert.equal(stubSubcommandForFile("session-hook.js", winDefs), "session");
});
