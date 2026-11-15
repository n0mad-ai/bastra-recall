/**
 * Tests für `bastra install claude-desktop --extension` (#218):
 *   - localMcpbPath / releaseDownloadUrl — deterministische Artefakt-Pfade
 *   - Flag-Parsing + Surface-Gate
 *
 * Runner: `tsx --test __tests__/extension-install.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { localMcpbPath, releaseDownloadUrl, pkgVersion, parseSha256 } from "../src/cli/extension-install.js";
import { parseArgs } from "../src/cli/commands.js";

test("release asset URL and local path are version-locked and consistent", async () => {
  const version = await pkgVersion();
  assert.match(version, /^\d+\.\d+\.\d+/);
  assert.equal(
    releaseDownloadUrl(version),
    `https://github.com/n0mad-ai/bastra-recall/releases/download/v${version}/bastra-recall-${version}.mcpb`
  );
  assert.match(localMcpbPath(version, "/tmp/pkg"), /^\/tmp\/pkg\/mcpb\/bastra-recall-.+\.mcpb$/);
});

test("parseSha256 accepts sha256sum output and bare digests, rejects everything else (#281)", () => {
  const hex = "a".repeat(64);
  assert.equal(parseSha256(`${hex}  bastra-recall-0.9.1.mcpb\n`), hex);
  assert.equal(parseSha256(hex), hex);
  assert.equal(parseSha256(`${"A".repeat(64)}  file`), hex, "uppercase digests normalize to lowercase");
  assert.equal(parseSha256(""), null);
  assert.equal(parseSha256("not a digest"), null);
  assert.equal(parseSha256(`${"a".repeat(63)}  short`), null, "63 hex chars is not a SHA-256");
  assert.equal(parseSha256(`<html>404 Not Found</html>`), null, "an error page never verifies");
});

test("--extension flag parses and stays scoped to the install command", () => {
  const args = parseArgs(["install", "claude-desktop", "--extension"]);
  assert.equal(args.command, "install");
  assert.equal(args.surface, "claude-desktop");
  assert.equal(args.extension, true);
  assert.equal(parseArgs(["install", "claude-desktop"]).extension, false);
});
