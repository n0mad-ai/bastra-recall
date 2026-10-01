/**
 * #647 — a re-install replaces what it owns and keeps what the user added.
 *
 * Two observed losses, same invariant:
 *   · the Claude Code hook commands came back as bare `node …/hook.js`, the
 *     user's logging shim around them gone without a word
 *   · `BASTRA_FORWARDER_SPAWN=0` vanished from the MCP registration env, and
 *     with the ssh tunnel down the forwarder spawned a local daemon on a stale
 *     mirror
 *
 * Pure data — no adapter here touches a real config file.
 *
 * Runner: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";

import { blocksMatch, buildServerBlock, foreignEnv } from "../src/cli/helpers.js";
import { codexServerMatches } from "../src/cli/codex-cli.js";
import { missingRequiredHookRegistrations, planHookEntries, registeredHookBins } from "../src/cli/adapters/claude-code.js";
import { planCodexHooks } from "../src/cli/adapters/codex.js";
import { hookWrapper } from "../src/cli/adapters/command-paths.js";
import { PROMPT_HOOK_BIN, HOOK_STUB_BIN } from "../src/cli/paths.js";

const commandsOf = (entries: unknown[]): string[] =>
  entries.flatMap((e) => ((e as { hooks?: Array<{ command?: string }> }).hooks ?? []).map((h) => String(h.command)));

test("MCP: env keys the installer does not own survive a rewrite", () => {
  const existing = {
    command: "node",
    args: ["/old/runtime/mcp-forwarder.js"],
    env: {
      BASTRA_VAULT_PATH: "/vault",
      BASTRA_TOOL_SURFACE: "write",
      BASTRA_FORWARDER_SPAWN: "0",
      NEXUS_VAULT_PATH: "/legacy-vault",
    },
  };
  assert.deepEqual(foreignEnv(existing), { BASTRA_FORWARDER_SPAWN: "0" }, "owned keys, legacy names included, are not 'foreign'");

  const target = buildServerBlock("/vault", "/new/runtime/mcp-forwarder.js", "write", null, foreignEnv(existing));
  assert.equal(target.env.BASTRA_FORWARDER_SPAWN, "0", "the user's key is in the block that gets written");
  assert.equal(target.env.BASTRA_VAULT_PATH, "/vault");
  assert.equal(blocksMatch(existing, target), false, "the forwarder moved, so it is rewritten…");

  // …and once written, a second install sees nothing to do instead of
  // dropping the key as an unexpected extra.
  assert.equal(blocksMatch(target, buildServerBlock("/vault", "/new/runtime/mcp-forwarder.js", "write", null, foreignEnv(target))), true);

  // Codex: the same block goes through `codex mcp add --env …`.
  const codexTarget = buildServerBlock("/vault", "/new/fwd.js", "write", null, foreignEnv({ env: existing.env }));
  assert.equal(codexServerMatches(
    { name: "bastra-recall", transport: { type: "stdio", command: "node", args: ["/new/fwd.js"], env: { BASTRA_VAULT_PATH: "/vault", BASTRA_TOOL_SURFACE: "write" } } },
    codexTarget,
  ), false, "a Codex registration missing the key is re-registered with it");
});

test("MCP: an owned key the user did not set is still not invented", () => {
  assert.deepEqual(foreignEnv({ env: { BASTRA_VAULT_PATH: "/v" } }), {});
  assert.deepEqual(foreignEnv(undefined), {});
  assert.deepEqual(foreignEnv({ env: { X: 1 } }), {}, "a non-string value is not carried into a string env");
});

test("hookWrapper finds the runner and returns what wraps it", () => {
  assert.deepEqual(
    hookWrapper("/usr/local/bin/hook-timer --tag p node /old/dist/prompt-hook.js --trace", "prompt-hook.js", "prompt"),
    { prefix: "/usr/local/bin/hook-timer --tag p ", suffix: " --trace" },
  );
  assert.deepEqual(hookWrapper("node /old/dist/prompt-hook.js", "prompt-hook.js", "prompt"), { prefix: "", suffix: "" });
  assert.deepEqual(hookWrapper("env FOO=1 /x/stub/bastra-hook prompt", "prompt-hook.js", "prompt"), { prefix: "env FOO=1 ", suffix: "" });
  assert.equal(hookWrapper("node /old/dist/session-hook.js", "prompt-hook.js", "prompt"), null, "another lane");
  // An unquoted path with a space cannot be split safely — no wrapper is guessed.
  assert.equal(hookWrapper("node /Users/Jane Doe/dist/prompt-hook.js", "prompt-hook.js", "prompt"), null);
});

test("Claude Code: a re-install keeps the user's wrapper around a hook command", () => {
  const wrapped = {
    hooks: [{ type: "command", command: "/usr/local/bin/hook-timer node /old/runtime/dist/prompt-hook.js", timeout: 2, __bastraRecall: true }],
  };
  const plan = planHookEntries("install", { UserPromptSubmit: [wrapped] }, { includeStop: false, stubPresent: false });
  assert.deepEqual(commandsOf(plan.after.UserPromptSubmit), [`BASTRA_HOOK_CLIENT=claude-code /usr/local/bin/hook-timer node ${PROMPT_HOOK_BIN}`]);

  // Switching to the stub replaces the runner, still inside the wrapper.
  const stub = planHookEntries("install", { UserPromptSubmit: [wrapped] }, { includeStop: false, stubPresent: true });
  assert.deepEqual(commandsOf(stub.after.UserPromptSubmit), [`BASTRA_HOOK_CLIENT=claude-code /usr/local/bin/hook-timer ${HOOK_STUB_BIN} prompt`]);

  // Idempotent: installing over the result changes nothing.
  const again = planHookEntries("install", plan.after, { includeStop: false, stubPresent: false });
  assert.deepEqual(again.after, plan.after);

  // An unwrapped install stays exactly what it was.
  const plain = planHookEntries("install", {}, { includeStop: false, stubPresent: false });
  assert.deepEqual(commandsOf(plain.after.UserPromptSubmit), [`BASTRA_HOOK_CLIENT=claude-code node ${PROMPT_HOOK_BIN}`]);
});

test("Codex: a re-install keeps the wrapper and writes the client marker once", () => {
  const wrapped = {
    hooks: [{ type: "command", command: "/usr/local/bin/hook-timer BASTRA_HOOK_CLIENT=codex node '/old/dist/prompt-hook.js'", timeout: 2 }],
  };
  const plan = planCodexHooks("install", { UserPromptSubmit: [wrapped] }, { includeStop: false, stubPresent: false });
  assert.deepEqual(commandsOf(plan.after.UserPromptSubmit), [`/usr/local/bin/hook-timer BASTRA_HOOK_CLIENT=codex node '${PROMPT_HOOK_BIN}'`]);
  const again = planCodexHooks("install", plan.after, { includeStop: false, stubPresent: false });
  assert.deepEqual(again.after, plan.after, "idempotent");
  const plain = planCodexHooks("install", {}, { includeStop: false, stubPresent: false });
  assert.deepEqual(commandsOf(plain.after.UserPromptSubmit), [`BASTRA_HOOK_CLIENT=codex node '${PROMPT_HOOK_BIN}'`]);
});

test("#698: re-installing over the old plan-lane matcher moves it to the new one and keeps the wrapper", () => {
  const old = {
    matcher: "TodoWrite|TaskCreate",
    hooks: [{ type: "command", command: "/usr/local/bin/hook-timer node /old/runtime/dist/todo-hook.js", timeout: 2, __bastraRecall: true }],
  };
  const plan = planHookEntries("install", { PreToolUse: [old] }, { includeStop: false, stubPresent: false });
  const todo = (plan.after.PreToolUse as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>).filter((e) =>
    (e.hooks ?? []).some((h) => (h.command ?? "").includes("todo-hook.js")),
  );
  assert.equal(todo.length, 1, "one plan-lane entry, the old one replaced");
  assert.equal(todo[0].matcher, "TodoWrite|TaskCreate|ExitPlanMode");
  assert.match(String(todo[0].hooks?.[0]?.command), /\/usr\/local\/bin\/hook-timer node .*todo-hook\.js$/);
});

test("Claude Code: a wrapped registration on the stub is still seen as registered", () => {
  // The shape install itself writes on the stub: marker, wrapper, stub, lane.
  const wrap = (file: string, matcher?: string) => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command: `/usr/local/bin/hook-timer node /old/packages/daemon/dist/${file}`, timeout: 2 }],
  });
  const hooks = {
    SessionStart: [wrap("session-hook.js", "startup|resume|clear|compact")],
    UserPromptSubmit: [wrap("prompt-hook.js")],
    PreToolUse: [wrap("hook.js", "Write|Edit|MultiEdit|NotebookEdit"), wrap("todo-hook.js", "TodoWrite|TaskCreate|ExitPlanMode"), wrap("bash-pre-hook.js", "Bash")],
    PostToolUse: [wrap("bash-fail-hook.js", "Bash")],
    PostToolUseFailure: [wrap("bash-fail-hook.js", "Bash")],
  };
  const plan = planHookEntries("install", hooks, { includeStop: false, stubPresent: true });
  for (const c of Object.values(plan.after).flatMap((e) => commandsOf(e as unknown[]))) {
    assert.ok(c.startsWith(`BASTRA_HOOK_CLIENT=claude-code /usr/local/bin/hook-timer ${HOOK_STUB_BIN} `), c);
  }
  assert.deepEqual(missingRequiredHookRegistrations(plan.after), [], "doctor: no required lane missing");
  assert.equal(registeredHookBins(plan.after).size, 6, "doctor: every required lane registered");
  const again = planHookEntries("install", plan.after, { includeStop: false, stubPresent: true });
  assert.deepEqual(again.after, plan.after, "idempotent");
});

test("Claude Code: a second handler the user put into our entry survives a re-install", () => {
  const entry = {
    hooks: [
      { type: "command", command: "node /old/runtime/dist/prompt-hook.js", timeout: 2, __bastraRecall: true },
      { type: "command", command: "/usr/local/bin/my-prompt-logger", timeout: 1 },
    ],
  };
  const plan = planHookEntries("install", { UserPromptSubmit: [entry] }, { includeStop: false, stubPresent: false });
  const all = commandsOf(plan.after.UserPromptSubmit);
  assert.ok(all.includes("/usr/local/bin/my-prompt-logger"), `user handler dropped: ${JSON.stringify(all)}`);
  assert.ok(all.includes(`BASTRA_HOOK_CLIENT=claude-code node ${PROMPT_HOOK_BIN}`));
  // Uninstall takes ours out and leaves theirs.
  const gone = planHookEntries("uninstall", { UserPromptSubmit: [entry] }, { includeStop: false, stubPresent: false });
  assert.deepEqual(commandsOf(gone.after.UserPromptSubmit), ["/usr/local/bin/my-prompt-logger"]);
});

test("Claude Code: a wrapper that takes the runner as one quoted argument is kept", () => {
  const entry = {
    hooks: [{ type: "command", command: `/usr/local/bin/hook-timer --tag p -- "node /old/runtime/dist/prompt-hook.js"`, timeout: 2, __bastraRecall: true }],
  };
  const plan = planHookEntries("install", { UserPromptSubmit: [entry] }, { includeStop: false, stubPresent: false });
  assert.deepEqual(commandsOf(plan.after.UserPromptSubmit), [
    `BASTRA_HOOK_CLIENT=claude-code /usr/local/bin/hook-timer --tag p -- "node ${PROMPT_HOOK_BIN}"`,
  ]);
});

test("Claude Code: behind `cd /dir &&` the client marker scopes to the runner, not to cd", () => {
  const entry = {
    hooks: [{ type: "command", command: "cd /work && node /old/runtime/dist/prompt-hook.js", timeout: 2, __bastraRecall: true }],
  };
  const plan = planHookEntries("install", { UserPromptSubmit: [entry] }, { includeStop: false, stubPresent: false });
  assert.deepEqual(commandsOf(plan.after.UserPromptSubmit), [`cd /work && BASTRA_HOOK_CLIENT=claude-code node ${PROMPT_HOOK_BIN}`]);
});
