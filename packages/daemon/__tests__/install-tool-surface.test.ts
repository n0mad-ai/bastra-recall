/**
 * The tool surface must survive a reinstall (#481).
 *
 * `bastra install` always built its target block with the install default
 * (`write`), so a user who had widened their config to `full` by hand saw the
 * block judged a mismatch and rewritten on the next install. The vault path
 * has always survived a reinstall; the surface now does too.
 *
 * Pure data — no adapter here touches a real config file.
 *
 * Runner: npx tsx --test packages/daemon/__tests__/install-tool-surface.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { blocksMatch, buildServerBlock, existingToolSurface } from "../src/cli/helpers.js";
import { codexServerMatches, parseCodexMcpServer } from "../src/cli/codex-cli.js";
import { INSTALL_TOOL_SURFACE, DEFAULT_TOOL_SURFACE, toolSurfaceFrom } from "../src/tool-defs.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function jsonBlock(surface?: string) {
  return {
    command: "node",
    args: ["/stable/mcp-forwarder.js"],
    env: {
      BASTRA_VAULT_PATH: "/vault",
      ...(surface === undefined ? {} : { BASTRA_TOOL_SURFACE: surface }),
    },
  };
}

test("a hand-set surface is read back off the existing registration", () => {
  assert.equal(existingToolSurface(jsonBlock("full")), "full");
  assert.equal(existingToolSurface(jsonBlock("search")), "search");
  assert.equal(existingToolSurface(jsonBlock("write")), "write");
  assert.equal(existingToolSurface(jsonBlock(" Full ")), "full", "hand-edited config, hand-edited spacing");
});

test("nothing explicitly set means nothing to preserve", () => {
  assert.equal(existingToolSurface(jsonBlock()), null, "a pre-#481 registration has no surface to keep");
  assert.equal(existingToolSurface(jsonBlock("nonsense")), null, "a typo is corrected, not frozen");
  assert.equal(existingToolSurface(undefined), null);
  assert.equal(existingToolSurface(null), null);
  assert.equal(existingToolSurface({ command: "node", args: [] }), null, "no env bag at all");
});

test("the reviewer's reproduction: a `full` config is no longer a mismatch", () => {
  const existing = jsonBlock("full");
  // Before: the target was always built with the install default.
  const beforeTarget = buildServerBlock("/vault", "/stable/mcp-forwarder.js", INSTALL_TOOL_SURFACE);
  assert.equal(beforeTarget.env.BASTRA_TOOL_SURFACE, "write");
  assert.equal(blocksMatch(existing, beforeTarget), false, "this is the defect: `full` looked like drift");

  // After: the installer carries the surface the config already states.
  const target = buildServerBlock("/vault", "/stable/mcp-forwarder.js", existingToolSurface(existing) ?? undefined);
  assert.equal(target.env.BASTRA_TOOL_SURFACE, "full");
  assert.equal(blocksMatch(existing, target), true, "a settled config stays settled — nothing is rewritten");
});

test("a fresh install still gets `write`", () => {
  const target = buildServerBlock("/vault", "/stable/mcp-forwarder.js", existingToolSurface(undefined) ?? undefined);
  assert.equal(target.env.BASTRA_TOOL_SURFACE, "write");
  assert.equal(target.env.BASTRA_VAULT_PATH, "/vault");
});

test("an absent BASTRA_TOOL_SURFACE still means `full` at runtime", () => {
  // The Mac app and the CLI register nothing, and must keep every tool.
  assert.equal(DEFAULT_TOOL_SURFACE, "full");
  assert.equal(toolSurfaceFrom(undefined), "full");
});

test("Codex: the surface is preserved through its own transport shape", () => {
  const raw = JSON.stringify({
    name: "bastra-recall",
    enabled: true,
    transport: {
      type: "stdio",
      command: "node",
      args: ["/stable/mcp-forwarder.js"],
      env: { BASTRA_VAULT_PATH: "/vault", BASTRA_TOOL_SURFACE: "full", FOREIGN: "preserved" },
    },
  });
  const parsed = parseCodexMcpServer(raw);
  assert.ok(parsed);
  assert.equal(existingToolSurface(parsed.transport), "full");

  const target = buildServerBlock("/vault", "/stable/mcp-forwarder.js", existingToolSurface(parsed.transport) ?? undefined);
  assert.equal(
    codexServerMatches(parsed, target),
    true,
    "no `codex mcp remove` + re-add, so the hand-set surface stays on disk",
  );
  assert.equal(
    codexServerMatches(parsed, buildServerBlock("/vault", "/stable/mcp-forwarder.js", INSTALL_TOOL_SURFACE)),
    false,
    "the defect, for the record",
  );
});

test("every installer adapter carries the existing surface into its target block", async () => {
  const adapters = ["claude-code.ts", "claude-desktop.ts", "codex.ts", "cursor.ts"];
  for (const file of adapters) {
    const src = await readFile(join(SRC, "cli", "adapters", file), "utf8");
    const calls = src.match(/buildServerBlock\((?:[^;]*?)\)/gs) ?? [];
    assert.ok(calls.length > 0, `${file} must register a server block`);
    for (const call of calls) {
      assert.match(
        call,
        /existingToolSurface\(/,
        `${file} builds a target block without preserving the configured surface`,
      );
    }
  }
});
