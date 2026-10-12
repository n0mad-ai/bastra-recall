import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkReleaseDocs } from "../../scripts/release-docs.mjs";

const root = new URL("../../", import.meta.url);
const version = JSON.parse(readFileSync(new URL("package.json", root))).version;
const prose = v => `**Version ${v} is available.**\n**Version ${v} ist verfügbar.**\n`;
test("release README languages and changelog match package.json", () => {
  checkReleaseDocs(fileURLToPath(root), version);
});

test("reject stale/missing/duplicate language lines and missing changelog version", t => {
  const dir = mkdtempSync(join(tmpdir(), "bastra-release-docs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "CHANGELOG.md"), "## [2.3.4] — today\n");
  for (const text of [prose("2.3.3"), prose("2.3.4").split("\n")[0], prose("2.3.4") + prose("2.3.4"), prose("2.3.4").replace("2.3.4 ist", "2.3.3 ist")]) {
    writeFileSync(join(dir, "README.md"), text);
    assert.throws(() => checkReleaseDocs(dir, "2.3.4"), /README/);
  }
  writeFileSync(join(dir, "README.md"), prose("2.3.4"));
  checkReleaseDocs(dir, "2.3.4");
  writeFileSync(join(dir, "CHANGELOG.md"), "## [Unreleased]\n## [2.3.40]\n");
  assert.throws(() => checkReleaseDocs(dir, "2.3.4"), /CHANGELOG/);
});

test("version bump updates both README lines; dry run leaves bytes unchanged", t => {
  const dir = mkdtempSync(join(tmpdir(), "bastra-bump-docs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(new URL("scripts/bump.mjs", root), join(dir, "scripts/bump.mjs"));
  mkdirSync(join(dir, "packages/daemon/src/cli"), { recursive: true });
  for (const file of ["index.ts", "mcp-forwarder.ts", "version.ts", "cli/helpers.ts"]) {
    writeFileSync(join(dir, "packages/daemon/src", file), "// no literal\n");
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", workspaces: [] }));
  writeFileSync(join(dir, "README.md"), prose("1.0.0"));
  const run = args => spawnSync(process.execPath, [join(dir, "scripts/bump.mjs"), ...args], { encoding: "utf8" });
  const dry = run(["2.3.4-beta.1", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /README.md/);
  assert.equal(readFileSync(join(dir, "README.md"), "utf8"), prose("1.0.0"));
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"))).version, "1.0.0");
  const applied = run(["2.3.4-beta.1"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(readFileSync(join(dir, "README.md"), "utf8"), prose("2.3.4-beta.1"));
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"))).version, "2.3.4-beta.1");
});
