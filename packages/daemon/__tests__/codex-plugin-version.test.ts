/**
 * #1455: the Codex plugin manifest carries its own version. It shipped as
 * 1.0.0 while the packages were at 1.1.8, so plugin directories showed users
 * an old release. `scripts/bump.mjs` now moves it with the packages, and this
 * test turns red the moment the two disagree.
 *
 * Runner: tsx --test __tests__/codex-plugin-version.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MANIFEST = "plugins/bastra-recall/.codex-plugin/plugin.json";

function versionOf(root: string, rel: string): string {
  return (JSON.parse(readFileSync(join(root, rel), "utf8")) as { version: string }).version;
}

test("#1455: the Codex plugin manifest has the package version", () => {
  assert.equal(versionOf(repoRoot, MANIFEST), versionOf(repoRoot, "package.json"));
});

test("#1455: bump.mjs moves the Codex plugin manifest with the packages; a dry run leaves it alone", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bastra-bump-plugin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "scripts"));
  for (const name of ["bump.mjs", "release-docs.mjs"]) {
    copyFileSync(join(repoRoot, "scripts", name), join(dir, "scripts", name));
  }
  mkdirSync(join(dir, "packages/daemon/src/cli"), { recursive: true });
  for (const file of ["index.ts", "mcp-forwarder.ts", "version.ts", "cli/helpers.ts"]) {
    writeFileSync(join(dir, "packages/daemon/src", file), "// no literal\n");
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", workspaces: [] }));
  writeFileSync(join(dir, "README.md"), "**Version 1.0.0 is available.**\n**Version 1.0.0 ist verfügbar.**\n");
  mkdirSync(dirname(join(dir, MANIFEST)), { recursive: true });
  writeFileSync(join(dir, MANIFEST), JSON.stringify({ name: "bastra-recall", version: "0.9.0" }, null, 2) + "\n");

  const run = (args: string[]) =>
    spawnSync(process.execPath, [join(dir, "scripts/bump.mjs"), ...args], { encoding: "utf8" });

  const dry = run(["2.3.4", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /\.codex-plugin\/plugin\.json: version 0\.9\.0 → 2\.3\.4/);
  assert.equal(versionOf(dir, MANIFEST), "0.9.0");

  const applied = run(["2.3.4"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(versionOf(dir, MANIFEST), "2.3.4");
  assert.equal(versionOf(dir, "package.json"), "2.3.4");
});
