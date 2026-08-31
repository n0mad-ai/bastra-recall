/**
 * Codex/ChatGPT desktop adapter contract tests (#15).
 *
 * The real ~/.codex directory is never touched: hook paths live in a temporary
 * directory, while MCP JSON and hook merges are exercised as pure data.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCodexMcpServer, codexServerMatches } from "../src/cli/codex-cli.js";
import { planCodexHooks, patchCodexHooks } from "../src/cli/adapters/codex.js";
import { applyPatchPaths, normalizeWritePayload } from "../src/hook-write-input.js";
import { hookClient } from "../src/hook-surface.js";

test("Codex MCP JSON matches the same stable stdio block ChatGPT desktop reads", () => {
  const raw = JSON.stringify({
    name: "bastra-recall",
    enabled: true,
    transport: {
      type: "stdio",
      command: "node",
      args: ["/stable/mcp-forwarder.js"],
      env: { BASTRA_VAULT_PATH: "/vault", FOREIGN: "preserved" },
    },
  });
  const parsed = parseCodexMcpServer(raw);
  assert.ok(parsed);
  assert.equal(codexServerMatches(parsed, {
    command: "node",
    args: ["/stable/mcp-forwarder.js"],
    env: { BASTRA_VAULT_PATH: "/vault" },
  }), true);
  assert.equal(codexServerMatches(parsed, {
    command: "node",
    args: ["/other/mcp-forwarder.js"],
    env: { BASTRA_VAULT_PATH: "/vault" },
  }), false);
});

test("Codex hook planner installs seven native lanes and preserves foreign hooks", () => {
  const foreign = { matcher: "foreign", hooks: [{ type: "command", command: "foreign-hook" }] };
  const installed = planCodexHooks("install", { PreToolUse: [foreign] }, {
    includeStop: true,
    stubPresent: false,
    mapBin: (path) => `/stable/${path.split("/").pop()}`,
  });
  assert.equal(installed.after.SessionStart.length, 1);
  assert.equal(installed.after.UserPromptSubmit.length, 1);
  assert.equal(installed.after.PreToolUse.length, 4);
  assert.equal(installed.after.PostToolUse.length, 1);
  assert.equal(installed.after.Stop.length, 1);
  assert.equal(installed.after.PreToolUse[0], foreign);
  const serialized = JSON.stringify(installed.after);
  assert.match(serialized, /\^apply_patch\$/);
  assert.match(serialized, /\^update_plan\$/);
  assert.match(serialized, /BASTRA_HOOK_CLIENT=codex/);
  assert.match(serialized, /Bastra Recall · loading context/);
  assert.match(serialized, /Bastra Recall · recalling for patch/);
  assert.doesNotMatch(serialized, /__bastraRecall/);

  const removed = planCodexHooks("uninstall", installed.after, {
    includeStop: false,
    stubPresent: false,
  });
  assert.deepEqual(removed.after.PreToolUse, [foreign]);
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"] as const) {
    assert.deepEqual(removed.after[event], []);
  }
});

test("Codex hook file install is idempotent and uninstall keeps foreign entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-codex-hooks-"));
  const hooksPath = join(dir, "hooks.json");
  try {
    const first = await patchCodexHooks("install", {
      dryRun: false,
      includeStop: true,
      hooksPath,
      stubPresent: false,
      exists: async () => true,
    });
    assert.equal(first.status, "installed");
    const second = await patchCodexHooks("install", {
      dryRun: false,
      includeStop: true,
      hooksPath,
      stubPresent: false,
      exists: async () => true,
    });
    assert.equal(second.status, "already-installed");

    const document = JSON.parse(await readFile(hooksPath, "utf8"));
    document.hooks.PreToolUse.unshift({ matcher: "foreign", hooks: [{ type: "command", command: "foreign-hook" }] });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(hooksPath, JSON.stringify(document), "utf8");
    const removed = await patchCodexHooks("uninstall", { dryRun: false, hooksPath, stubPresent: false });
    assert.equal(removed.status, "removed");
    const after = JSON.parse(await readFile(hooksPath, "utf8"));
    assert.equal(after.hooks.PreToolUse.length, 1);
    assert.equal(after.hooks.PreToolUse[0].matcher, "foreign");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex hook uninstall dry-run is a read-only lifecycle preflight", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-codex-hooks-preflight-"));
  const hooksPath = join(dir, "hooks.json");
  try {
    await patchCodexHooks("install", {
      dryRun: false,
      includeStop: true,
      hooksPath,
      stubPresent: false,
      exists: async () => true,
    });
    const before = await readFile(hooksPath, "utf8");
    const planned = await patchCodexHooks("uninstall", {
      dryRun: true,
      hooksPath,
      stubPresent: false,
    });
    assert.equal(planned.status, "would-remove");
    assert.equal(await readFile(hooksPath, "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("apply_patch payloads expose target paths and retain the patch body", () => {
  const command = [
    "*** Begin Patch",
    "*** Update File: packages/daemon/src/a.ts",
    "@@",
    "+new line",
    "*** Add File: packages/daemon/src/b.ts",
    "+second",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(applyPatchPaths(command), [
    "packages/daemon/src/a.ts",
    "packages/daemon/src/b.ts",
  ]);
  const normalized = normalizeWritePayload({ tool_name: "apply_patch", tool_input: { command } });
  assert.equal(normalized?.tool_input?.file_path, "packages/daemon/src/a.ts");
  assert.deepEqual(normalized?.tool_input?.file_paths, ["packages/daemon/src/a.ts", "packages/daemon/src/b.ts"]);
  assert.equal(normalized?.tool_input?.command, command);
});

test("surface detection prefers explicit Codex markers and keeps Claude default", () => {
  assert.equal(hookClient({ bastra_client: "codex" }), "codex");
  assert.equal(hookClient({ bastra_client: "claude-code", tool_name: "apply_patch" }), "claude-code");
  assert.equal(hookClient({ model: "claude-opus-4-1" }), "claude-code");
  assert.equal(hookClient({ turn_id: "turn-1" }), "claude-code");
  assert.equal(hookClient({ tool_name: "apply_patch" }), "codex");
  assert.equal(hookClient({ tool_name: "Write" }), "claude-code");
});
