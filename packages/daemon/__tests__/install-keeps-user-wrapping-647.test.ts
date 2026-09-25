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
import { planHookEntries } from "../src/cli/adapters/claude-code.js";
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
  assert.deepEqual(commandsOf(plan.after.UserPromptSubmit), [`/usr/local/bin/hook-timer node ${PROMPT_HOOK_BIN}`]);

  // Switching to the stub replaces the runner, still inside the wrapper.
  const stub = planHookEntries("install", { UserPromptSubmit: [wrapped] }, { includeStop: false, stubPresent: true });
  assert.deepEqual(commandsOf(stub.after.UserPromptSubmit), [`/usr/local/bin/hook-timer ${HOOK_STUB_BIN} prompt`]);

  // Idempotent: installing over the result changes nothing.
  const again = planHookEntries("install", plan.after, { includeStop: false, stubPresent: false });
  assert.deepEqual(again.after, plan.after);

  // An unwrapped install stays exactly what it was.
  const plain = planHookEntries("install", {}, { includeStop: false, stubPresent: false });
  assert.deepEqual(commandsOf(plain.after.UserPromptSubmit), [`node ${PROMPT_HOOK_BIN}`]);
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
