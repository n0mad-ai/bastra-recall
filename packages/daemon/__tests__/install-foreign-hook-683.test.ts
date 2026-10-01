/**
 * #683 — install recognises its hook entries by the runner they invoke.
 *
 * The old test was two substrings (`bastra-recall` and `hook`) anywhere in the
 * command, so a user's own `~/bin/my-bastra-recall-audit-hook.sh` was claimed
 * and deleted on install without a word. A foreign script survives install and
 * uninstall on both adapters and is named; every shape we ever wrote is still
 * replaced.
 *
 * Pure data, plus a temp hooks.json for the Codex file path and a temp HOME
 * for the checkout script.
 *
 * Runner: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { planHookEntries } from "../src/cli/adapters/claude-code.js";
import { planCodexHooks, patchCodexHooks } from "../src/cli/adapters/codex.js";
import { runsOurHookRunner } from "../src/cli/adapters/command-paths.js";

const FILES = ["hook.js", "session-hook.js", "prompt-hook.js", "todo-hook.js", "bash-pre-hook.js", "bash-fail-hook.js", "stop-hook.js"];
const entry = (command: string, extra: Record<string, unknown> = {}, matcher?: string): Record<string, unknown> => ({
  ...(matcher ? { matcher } : {}),
  hooks: [{ type: "command", command, timeout: 2, ...extra }],
});
const commandsOf = (entries: unknown[]): string[] =>
  entries.flatMap((e) => ((e as { hooks?: Array<{ command?: string }> }).hooks ?? []).map((h) => String(h.command)));

test("runsOurHookRunner: the program run decides, not the text", () => {
  const cc = "BASTRA_HOOK_CLIENT=claude-code";
  for (const ours of [
    "node /opt/x/node_modules/@bastra-recall/daemon/dist/prompt-hook.js",
    "node C:\\Users\\j\\AppData\\npm\\node_modules\\@bastra-recall\\daemon\\dist\\hook.js",
    "node \"/Users/Jane Doe/repo/packages/daemon/dist/session-hook.js\"",
    "/Users/j/.bastra/stub/bastra-hook prompt",
    "bastra-recall-session-hook",
    "/usr/local/bin/bastra-recall-hook",
    "nexus-recall-hook",
    "/usr/local/bin/hook-timer node /opt/x/daemon/dist/todo-hook.js --trace",
    `${cc} node /old/runtime/dist/stop-hook.js`,
  ]) assert.equal(runsOurHookRunner(ours, FILES, cc), true, ours);
  for (const foreign of [
    "~/bin/my-bastra-recall-audit-hook.sh",
    "/opt/tools/nexus-recall-hook-logger --all",
    "node /home/u/project/dist/hook.js",
    "~/bin/my-bastra-hook-audit.sh",
    "bastra-recall-mcp --hook",
    "echo bastra-recall hook",
  ]) assert.equal(runsOurHookRunner(foreign, FILES, cc), false, foreign);
});

test("Claude Code: a foreign script named like ours survives install and uninstall", () => {
  const foreign = entry("~/bin/my-bastra-recall-audit-hook.sh");
  const hooks = { UserPromptSubmit: [foreign], Stop: [foreign] };

  const installed = planHookEntries("install", hooks, { includeStop: false, stubPresent: false });
  assert.equal(installed.after.UserPromptSubmit[0], foreign, "kept verbatim, in place");
  assert.equal(installed.after.UserPromptSubmit.length, 2, "ours is added next to it");
  assert.deepEqual(installed.after.Stop, [foreign], "not mistaken for a Stop opt-in");
  assert.equal(installed.stopPreserved, false);
  assert.deepEqual(installed.leftAlone, ["~/bin/my-bastra-recall-audit-hook.sh"], "named once");

  const again = planHookEntries("install", installed.after, { includeStop: false, stubPresent: false });
  assert.deepEqual(again.after, installed.after, "idempotent");

  const removed = planHookEntries("uninstall", installed.after, { includeStop: false });
  assert.deepEqual(removed.after.UserPromptSubmit, [foreign]);
  assert.deepEqual(removed.after.Stop, [foreign]);
  assert.deepEqual(removed.leftAlone, ["~/bin/my-bastra-recall-audit-hook.sh"]);
});

test("Claude Code: our entries, current and legacy shapes, are still replaced", () => {
  const ours = [
    entry("BASTRA_HOOK_CLIENT=claude-code node /old/runtime/1.0.0/dist/prompt-hook.js", { __bastraRecall: true }),
    entry("BASTRA_HOOK_CLIENT=claude-code /old/stub/bastra-hook prompt", { __bastraRecall: true }),
    entry("node /old/checkout/packages/daemon/dist/prompt-hook.js"),
    entry("/old/stub/bastra-hook prompt"),
    entry("bastra-recall-prompt-hook"),
    entry("nexus-recall-hook"),
    entry("/some/moved/wrapper.sh", { __nexusRecall: true }),
  ];
  const plan = planHookEntries("install", { UserPromptSubmit: ours }, { includeStop: false, stubPresent: false });
  assert.equal(plan.after.UserPromptSubmit.length, 1, "all seven old entries replaced by one current entry");
  assert.match(commandsOf(plan.after.UserPromptSubmit)[0], /^BASTRA_HOOK_CLIENT=claude-code node .*prompt-hook\.js$/);
  assert.deepEqual(plan.leftAlone, []);

  const removed = planHookEntries("uninstall", { UserPromptSubmit: ours }, { includeStop: false });
  assert.deepEqual(removed.after.UserPromptSubmit, []);
});

test("Codex: a foreign script named like ours survives install and uninstall", () => {
  const foreign = entry("BASTRA_HOOK_CLIENT=codex ~/bin/my-bastra-hook-audit.sh", {}, "^Bash$");
  const installed = planCodexHooks("install", { PreToolUse: [foreign] }, { includeStop: false, stubPresent: false });
  assert.equal(installed.after.PreToolUse[0], foreign);
  assert.equal(installed.after.PreToolUse.length, 4, "the three PreToolUse lanes are added next to it");
  assert.deepEqual(installed.leftAlone, ["BASTRA_HOOK_CLIENT=codex ~/bin/my-bastra-hook-audit.sh"]);
  // The registered events are unchanged by the recognition fix.
  assert.deepEqual(Object.keys(installed.after), ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);

  const removed = planCodexHooks("uninstall", installed.after, { includeStop: false, stubPresent: false });
  assert.deepEqual(removed.after.PreToolUse, [foreign]);
});

test("Codex: our entries, current and legacy shapes, are still replaced", () => {
  const ours = [
    entry("BASTRA_HOOK_CLIENT=codex node '/old/runtime/dist/prompt-hook.js'", { statusMessage: "Bastra Recall · recalling for prompt" }),
    entry("BASTRA_HOOK_CLIENT=codex '/old/stub/bastra-hook' prompt", { statusMessage: "Bastra Recall · recalling for prompt" }),
    entry("node /old/dist/prompt-hook.js", { statusMessage: "bastra-recall: prompt" }),
    entry("BASTRA_HOOK_CLIENT=codex node '/old/runtime/dist/prompt-hook.js'"),
    entry("BASTRA_HOOK_CLIENT=codex '/old/stub/bastra-hook' prompt"),
  ];
  const plan = planCodexHooks("install", { UserPromptSubmit: ours }, { includeStop: false, stubPresent: false });
  assert.equal(plan.after.UserPromptSubmit.length, 1);
  assert.match(commandsOf(plan.after.UserPromptSubmit)[0], /^BASTRA_HOOK_CLIENT=codex node '.*prompt-hook\.js'$/);
  assert.deepEqual(plan.leftAlone, []);
});

// The checkout script carries its own copy of the recognition (inline node in
// bash). `--print` writes nothing but the resulting JSON; HOME is a temp dir.
test("install-hook.sh: the same rule — foreign script kept and named, our legacy forms replaced", { skip: process.platform === "win32" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "bastra-install-hook-683-"));
  try {
    await mkdir(join(home, ".claude"));
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          entry("~/bin/my-bastra-recall-audit-hook.sh"),
          entry("bastra-recall-prompt-hook"),
          entry("node /old/checkout/packages/daemon/dist/prompt-hook.js"),
        ],
      },
    }), "utf8");
    const script = fileURLToPath(new URL("../../skill/install-hook.sh", import.meta.url));
    const run = spawnSync("bash", [script, "--print"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const commands = commandsOf(JSON.parse(run.stdout).hooks.UserPromptSubmit);
    assert.equal(commands.length, 2);
    assert.equal(commands[0], "~/bin/my-bastra-recall-audit-hook.sh");
    assert.match(commands[1], /^node .*\/daemon\/dist\/prompt-hook\.js$/);
    assert.match(run.stderr, /left alone.*my-bastra-recall-audit-hook\.sh/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex hooks.json: the foreign script is still in the file after install and uninstall, and both say so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-codex-683-"));
  const hooksPath = join(dir, "hooks.json");
  const foreign = entry("BASTRA_HOOK_CLIENT=codex ~/bin/my-bastra-hook-audit.sh");
  try {
    await writeFile(hooksPath, JSON.stringify({ hooks: { UserPromptSubmit: [foreign] } }), "utf8");
    const io = { dryRun: false, hooksPath, stubPresent: false, exists: async () => true };

    const installed = await patchCodexHooks("install", io);
    assert.equal(installed.status, "installed");
    assert.match(installed.note ?? "", /left alone.*my-bastra-hook-audit\.sh/);
    assert.deepEqual(JSON.parse(await readFile(hooksPath, "utf8")).hooks.UserPromptSubmit[0], foreign);

    const second = await patchCodexHooks("install", io);
    assert.equal(second.status, "already-installed");
    assert.match(second.note ?? "", /left alone/, "named on every run");

    const removed = await patchCodexHooks("uninstall", io);
    assert.equal(removed.status, "removed");
    assert.match(removed.note ?? "", /left alone/);
    assert.deepEqual(JSON.parse(await readFile(hooksPath, "utf8")).hooks, { UserPromptSubmit: [foreign] });

    // Nothing of ours, nothing that looks like ours: no line.
    await writeFile(hooksPath, JSON.stringify({ hooks: { UserPromptSubmit: [entry("foreign-hook")] } }), "utf8");
    assert.equal((await patchCodexHooks("install", io)).note, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
