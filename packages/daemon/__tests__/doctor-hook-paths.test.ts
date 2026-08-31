/**
 * doctor checks the paths its hooks execute, not just that they are there (#321).
 *
 * Found in the VM verifying #304: after an update from 0.8.8 one of seven
 * Claude Code hooks still pointed at `~/.bastra/runtime/0.8.8/…`, and doctor
 * reported `hooks: 7/7 registered` + `ok`. The check that detects exactly this
 * shape had existed since #304 — it was applied to the MCP forwarder path and
 * to nothing else, so the surface ran replaced code and said it was healthy.
 *
 * The scenario reproduced here is that exact settings.json state.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/doctor-hook-paths.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  checkHookPaths,
  hookCommandPath,
  registeredHookBins,
  registeredHookCommands,
} from "../src/cli/adapters/claude-code.js";

const HOME = "/Users/tester";
const CURRENT = "/opt/homebrew/lib/node_modules/@bastra-recall/daemon/dist";
const OLD_PIN = join(HOME, ".bastra", "runtime", "0.8.8", "node_modules", "@bastra-recall", "daemon", "dist");

/** settings.json as the VM had it: six current hooks, Stop left on 0.8.8. */
function vmSettings(): Record<string, unknown> {
  const entry = (cmd: string) => ({ hooks: [{ type: "command", command: cmd, __bastraRecall: true }] });
  return {
    SessionStart: [entry(`node ${CURRENT}/session-hook.js`)],
    UserPromptSubmit: [entry(`node ${CURRENT}/prompt-hook.js`)],
    PreToolUse: [
      entry(`node ${CURRENT}/hook.js`),
      entry(`node ${CURRENT}/todo-hook.js`),
      entry(`node ${CURRENT}/bash-pre-hook.js`),
    ],
    PostToolUse: [entry(`node ${CURRENT}/bash-fail-hook.js`)],
    Stop: [entry(`node ${OLD_PIN}/stop-hook.js`)],
  };
}

const allExist = async () => true;

test("the stale pin that survived #304 is now reported", async () => {
  const found = registeredHookBins(vmSettings());
  assert.equal(found.size, 7, "sanity: the VM state registers all seven hooks");

  const problems = await checkHookPaths(found, { exists: allExist, running: "0.8.9", home: HOME });
  assert.equal(problems.length, 1, `expected exactly the Stop hook to be flagged, got: ${problems.join(" | ")}`);
  assert.match(problems[0], /^stop-hook\.js →/);
  assert.match(problems[0], /STALE PIN/);
  assert.match(problems[0], /runs 0\.8\.8, but 0\.8\.9 is installed/);
});

test("hooks on the running version are not flagged", async () => {
  const settings = vmSettings();
  settings.Stop = [{ hooks: [{ type: "command", command: `node ${CURRENT}/stop-hook.js`, __bastraRecall: true }] }];
  const problems = await checkHookPaths(registeredHookBins(settings), {
    exists: allExist,
    running: "0.8.9",
    home: HOME,
  });
  assert.deepEqual(problems, [], "a healthy surface must produce no noise");
});

test("a hook whose file is gone is reported as missing, not as present", async () => {
  const found = registeredHookBins(vmSettings());
  const gone = async (p: string) => !p.includes("bash-pre-hook.js");
  const problems = await checkHookPaths(found, { exists: gone, running: "0.8.9", home: HOME });
  const missing = problems.find((p) => p.startsWith("bash-pre-hook.js"));
  assert.ok(missing, `bash-pre-hook.js was deleted and not reported: ${problems.join(" | ")}`);
  assert.match(missing, /MISSING/);
});

test("a hook run from the npx cache is reported as ephemeral", async () => {
  const settings = vmSettings();
  const cached = "/Users/tester/.npm/_npx/abc123/node_modules/@bastra-recall/daemon/dist/hook.js";
  settings.PreToolUse = [{ hooks: [{ type: "command", command: `node ${cached}`, __bastraRecall: true }] }];
  const problems = await checkHookPaths(registeredHookBins(settings), {
    exists: allExist,
    running: "0.8.9",
    home: HOME,
  });
  assert.ok(problems.some((p) => p.startsWith("hook.js") && /EPHEMERAL/.test(p)), problems.join(" | "));
});

test("every registered hook is checked, not just the first one", async () => {
  const entry = (cmd: string) => ({ hooks: [{ type: "command", command: cmd, __bastraRecall: true }] });
  const settings = {
    SessionStart: [entry(`node ${OLD_PIN}/session-hook.js`)],
    UserPromptSubmit: [entry(`node ${OLD_PIN}/prompt-hook.js`)],
    Stop: [entry(`node ${OLD_PIN}/stop-hook.js`)],
  };
  const problems = await checkHookPaths(registeredHookBins(settings), {
    exists: allExist,
    running: "0.9.0",
    home: HOME,
  });
  assert.equal(problems.length, 3, `all three are stale; reported: ${problems.join(" | ")}`);
});

test("both event registrations of the shared bash-fail binary are path-checked", async () => {
  const entry = (cmd: string) => ({ hooks: [{ type: "command", command: cmd, __bastraRecall: true }] });
  const settings = vmSettings();
  settings.PostToolUseFailure = [entry(`node ${CURRENT}/bash-fail-hook.js`)];
  settings.PostToolUse = [entry(`node ${OLD_PIN}/bash-fail-hook.js`)];

  const commands = registeredHookCommands(settings);
  assert.equal(
    commands.filter(([file]) => file === "bash-fail-hook.js").length,
    2,
    "the two event registrations must not collapse before path validation",
  );
  const problems = await checkHookPaths(commands, { exists: allExist, running: "0.8.9", home: HOME });
  assert.ok(
    problems.some((problem) => problem.startsWith("bash-fail-hook.js") && /STALE PIN/.test(problem)),
    problems.join(" | "),
  );
});

// ─── path extraction ─────────────────────────────────────────────────────────

test("the executed path is pulled out of the command in every form we write", () => {
  assert.equal(
    hookCommandPath(`node ${CURRENT}/hook.js`, "hook.js", HOME),
    `${CURRENT}/hook.js`,
  );
  assert.equal(
    hookCommandPath(`node "/Users/t/My Vault/dist/hook.js"`, "hook.js", HOME),
    "/Users/t/My Vault/dist/hook.js",
    "a quoted path with spaces must survive intact",
  );
  assert.equal(
    hookCommandPath("node ~/.bastra/runtime/0.8.8/dist/stop-hook.js", "stop-hook.js", HOME),
    join(HOME, ".bastra/runtime/0.8.8/dist/stop-hook.js"),
    "~ must expand — the stale-pin check compares against a real path",
  );
  assert.equal(
    hookCommandPath("node /some/other/thing.js", "hook.js", HOME),
    null,
    "no match is null, never a guess",
  );
});

test("a command with no resolvable path is a problem, not a silent pass", async () => {
  // The filename is in there (so it registers), but nothing that reads as a
  // path — the old code counted this as 1/7 and said nothing.
  const found = new Map([["hook.js", "run-my-wrapper --with hook.js-mode"]]);
  const problems = await checkHookPaths(found, { exists: allExist, running: "0.9.0", home: HOME });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no path in/);
});
