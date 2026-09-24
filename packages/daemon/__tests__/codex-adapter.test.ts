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
import { applyPatchPaths, normalizeWritePayload, type WritePayloadShape } from "../src/hook-write-input.js";
import { hookClient } from "../src/hook-surface.js";
import { codeTargets, MAX_CODE_TARGETS } from "../src/write-lane.js";
import { repoRelative } from "../src/code-graph/dependents-block.js";
import { fileSizeNote, thresholdsFor } from "../src/file-size-check.js";

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
  // #542: T is inferred from the literal argument by default, which loses the
  // `file_path`/`file_paths` the function adds at runtime — pin it to the
  // (loose) WritePayloadShape instead.
  const normalized = normalizeWritePayload<WritePayloadShape>({ tool_name: "apply_patch", tool_input: { command } });
  assert.equal(normalized?.tool_input?.file_path, "packages/daemon/src/a.ts");
  assert.deepEqual(normalized?.tool_input?.file_paths, ["packages/daemon/src/a.ts", "packages/daemon/src/b.ts"]);
  assert.equal(normalized?.tool_input?.command, command);
});

test("code blocks see every apply_patch target as an absolute path (#584)", () => {
  const cwd = "/work/repo";
  const normalized = normalizeWritePayload({
    tool_name: "apply_patch",
    tool_input: {
      command: [
        "*** Begin Patch",
        "*** Update File: packages/daemon/src/index.ts",
        "*** Update File: packages/core/src/save.ts",
        "*** End Patch",
      ].join("\n"),
    },
  })!;
  const input = normalized.tool_input as Record<string, unknown>;
  const targets = codeTargets(input, input.file_path as string, cwd);
  assert.deepEqual(targets, [
    join(cwd, "packages/daemon/src/index.ts"),
    join(cwd, "packages/core/src/save.ts"),
  ]);
  // The repro from the review: the raw path was refused, the resolved one is not.
  assert.equal(repoRelative(cwd, "packages/daemon/src/index.ts"), null);
  assert.equal(repoRelative(cwd, targets[0]!), "packages/daemon/src/index.ts");
});

test("code targets: absolute paths pass through, duplicates collapse, the count is capped", () => {
  assert.deepEqual(codeTargets({}, "/abs/a.ts", "/cwd"), ["/abs/a.ts"]);
  const many = Array.from({ length: MAX_CODE_TARGETS + 3 }, (_, i) => `f${i}.ts`);
  const t = codeTargets({ file_paths: ["f0.ts", "f0.ts", ...many] }, "f0.ts", "/cwd");
  assert.equal(t.length, MAX_CODE_TARGETS);
  assert.equal(new Set(t).size, t.length);
});

test("surface detection prefers explicit Codex markers and keeps Claude default", () => {
  assert.equal(hookClient({ bastra_client: "codex" }), "codex");
  assert.equal(hookClient({ bastra_client: "claude-code", tool_name: "apply_patch" }), "claude-code");
  assert.equal(hookClient({ model: "claude-opus-4-1" }), "claude-code");
  assert.equal(hookClient({ turn_id: "turn-1" }), "claude-code");
  assert.equal(hookClient({ tool_name: "apply_patch" }), "codex");
  assert.equal(hookClient({ tool_name: "Write" }), "claude-code");
});

test("#572 NotebookEdit names its target notebook_path, and the write lane reads file_path", () => {
  // The lane returns on its first line without a `file_path`, so the notebook
  // was never booked and the task boundary rendered it exactly like a file
  // nothing depends on. Revert-check: drop the NotebookEdit branch in
  // normalizeWritePayload and both assertions go red.
  const cwd = "/work/repo";
  const normalized = normalizeWritePayload({
    tool_name: "NotebookEdit",
    tool_input: { notebook_path: "notebooks/train.ipynb", new_source: "x = 1", edit_mode: "replace" },
  })!;
  const input = normalized.tool_input as Record<string, unknown>;
  assert.equal(input.file_path, "notebooks/train.ipynb");
  assert.deepEqual(codeTargets(input, input.file_path as string, cwd), [join(cwd, "notebooks/train.ipynb")]);
  assert.equal(input.new_source, "x = 1", "the rest of the call is untouched");

  // Nothing to normalize is still nothing: a call with neither key has no target.
  assert.equal(normalizeWritePayload({ tool_name: "NotebookEdit", tool_input: {} }), null);
});

test("#572 the normalized notebook path does not put a .ipynb under the size convention", async () => {
  // Normalizing `notebook_path` turns the whole write lane on for NotebookEdit,
  // which the lane's own SUPPORTED_TOOLS already names. The one part that would
  // read a notebook wrongly is the size note — it would report the JSON's line
  // count as the file's length — and it does not, because `.ipynb` is not a
  // code extension. Revert-check: add ".ipynb" to CODE_EXTS in
  // file-size-check.ts and both assertions go red.
  assert.equal(thresholdsFor("/work/repo/notebooks/train.ipynb"), null);
  assert.notEqual(thresholdsFor("/work/repo/src/train.ts"), null);
  assert.equal(await fileSizeNote("/work/repo/notebooks/train.ipynb"), null);
});
