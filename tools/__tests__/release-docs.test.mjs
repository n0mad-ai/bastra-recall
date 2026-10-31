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
  for (const name of ["bump.mjs", "release-docs.mjs"]) {
    copyFileSync(new URL(`scripts/${name}`, root), join(dir, "scripts", name));
  }
  mkdirSync(join(dir, "packages/daemon/src/cli"), { recursive: true });
  for (const file of ["index.ts", "mcp-forwarder.ts", "version.ts", "cli/helpers.ts"]) {
    writeFileSync(join(dir, "packages/daemon/src", file), "// no literal\n");
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", workspaces: [] }));
  writeFileSync(join(dir, "README.md"), prose("1.0.0"));
  const run = args => spawnSync(process.execPath, [join(dir, "scripts/bump.mjs"), ...args], { encoding: "utf8" });
  const dry = run(["2.3.4", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /README.md/);
  assert.match(dry.stdout, /npm test will fail until CHANGELOG.md has a section for 2.3.4/);
  assert.equal(readFileSync(join(dir, "README.md"), "utf8"), prose("1.0.0"));
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"))).version, "1.0.0");
  const applied = run(["2.3.4"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(readFileSync(join(dir, "README.md"), "utf8"), prose("2.3.4"));
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"))).version, "2.3.4");
});

for (const prerelease of ["2.3.4-beta.1", "2.3.4-rc.2+build-1"]) {
  test(`prerelease ${prerelease} keeps stable README and needs no changelog section`, t => {
    const dir = mkdtempSync(join(tmpdir(), "bastra-prerelease-docs-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "scripts"));
    for (const name of ["bump.mjs", "release-docs.mjs"]) {
      copyFileSync(new URL(`scripts/${name}`, root), join(dir, "scripts", name));
    }
    mkdirSync(join(dir, "packages/daemon/src/cli"), { recursive: true });
    for (const file of ["index.ts", "mcp-forwarder.ts", "version.ts", "cli/helpers.ts"]) {
      writeFileSync(join(dir, "packages/daemon/src", file), "// no literal\n");
    }
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", workspaces: [] }));
    writeFileSync(join(dir, "README.md"), prose("1.0.0"));
    // Deliberately no CHANGELOG file: neither the normal guard nor the publishing
    // guard should require a section for a prerelease.
    const result = spawnSync(process.execPath, [join(dir, "scripts/bump.mjs"), prerelease], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), prose("1.0.0"));
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"))).version, prerelease);
    assert.match(result.stdout, /--prerelease/);
    checkReleaseDocs(dir, prerelease);
    assert.throws(() => checkReleaseDocs(dir, "1.0.0"), /ENOENT/);
  });
}

test("a hyphen in build metadata does not bypass stable documentation checks", t => {
  const dir = mkdtempSync(join(tmpdir(), "bastra-build-docs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "README.md"), prose("2.3.4+build-1"));
  writeFileSync(join(dir, "CHANGELOG.md"), "## [Unreleased]\n");
  assert.throws(() => checkReleaseDocs(dir, "2.3.4+build-1"), /CHANGELOG/);
  writeFileSync(join(dir, "CHANGELOG.md"), "## [2.3.4+build-1]\n");
  checkReleaseDocs(dir, "2.3.4+build-1");
});


test("release targets are version-checked without claiming publication", t => {
  const dir = mkdtempSync(join(tmpdir(), "bastra-release-target-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = v => `**Release target: ${v}.**\n**Release-Ziel: ${v}.**\n`;
  writeFileSync(join(dir, "README.md"), target("2.3.4"));
  writeFileSync(join(dir, "CHANGELOG.md"), "## [2.3.4] — today\n");
  checkReleaseDocs(dir, "2.3.4");
  for (const bad of [target("2.3.3"), target("2.3.4") + prose("2.3.4")]) {
    writeFileSync(join(dir, "README.md"), bad);
    assert.throws(() => checkReleaseDocs(dir, "2.3.4"), /README/);
  }
  mkdirSync(join(dir, "scripts"));
  for (const name of ["bump.mjs", "release-docs.mjs"]) copyFileSync(new URL(`scripts/${name}`, root), join(dir, "scripts", name));
  mkdirSync(join(dir, "packages/daemon/src/cli"), { recursive: true });
  for (const file of ["index.ts", "mcp-forwarder.ts", "version.ts", "cli/helpers.ts"]) writeFileSync(join(dir, "packages/daemon/src", file), "// no literal\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", workspaces: [] }));
  writeFileSync(join(dir, "README.md"), target("1.0.0"));
  const run = spawnSync(process.execPath, [join(dir, "scripts/bump.mjs"), "2.3.4"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(join(dir, "README.md"), "utf8"), target("2.3.4"));
  checkReleaseDocs(dir, "2.3.4");
});
