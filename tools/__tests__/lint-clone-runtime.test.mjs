import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));

async function put(root, name, body) {
  await mkdir(dirname(join(root, name)), { recursive: true });
  await writeFile(join(root, name), body);
}

function execute(root, program, args) {
  const result = spawnSync(program, args, { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.ifError(result.error);
  return { ...result, output: result.stdout + result.stderr };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "bastra-clone-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10 }));
  await mkdir(join(root, "scripts"));
  for (const name of ["check-clones.mjs", "lint-scope.mjs"]) {
    await copyFile(join(repository, "scripts", name), join(root, "scripts", name));
  }
  await copyFile(join(repository, ".jscpd.json"), join(root, ".jscpd.json"));
  await symlink(
    join(repository, "node_modules"),
    join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await put(root, "package.json", '{"type":"module"}\n');
  await put(root, ".gitignore", "node_modules/\nbuild/\n");
  const baseline = JSON.stringify({
    version: 1,
    production: { version: 1, fingerprints: {} },
    tests: { version: 1, fingerprints: {} },
  });
  await put(root, "clone-baseline.json", baseline);
  assert.equal(execute(root, "git", ["init", "-q"]).status, 0);
  return { root, baseline };
}

function repeated(lines) {
  const body = Array.from({ length: lines }, (_, index) => `value += ${index} * (value + ${index + 1});`).join("\n");
  return `export function copied(value) {\n${body}\nreturn value;\n}\n`;
}

test("clone groups preserve the production exclusion and their distinct thresholds", async (t) => {
  const { root, baseline } = await fixture(t);
  const short = repeated(25);
  await put(root, "src/__tests__/first.test.ts", short);
  await put(root, "src/__tests__/second.test.ts", short);
  const underTestThreshold = execute(root, process.execPath, ["scripts/check-clones.mjs"]);
  assert.equal(underTestThreshold.status, 0, underTestThreshold.output);
  assert.match(underTestThreshold.output, /Clones \(production\): 0/);
  assert.match(underTestThreshold.output, /Clones \(tests\): 0/);
  await put(root, "src/first.ts", short);
  await put(root, "src/second.ts", short);
  const production = execute(root, process.execPath, ["scripts/check-clones.mjs", "--prune"]);
  assert.equal(production.status, 1, production.output);
  assert.match(production.output, /New copied code \(production\)/);
  assert.match(production.output, /Clones \(tests\): 0/);
  await put(root, "src/__tests__/first.test.ts", repeated(60));
  await put(root, "src/__tests__/second.test.ts", repeated(60));
  const testCopies = execute(root, process.execPath, ["scripts/check-clones.mjs"]);
  assert.equal(testCopies.status, 1, testCopies.output);
  assert.match(testCopies.output, /New copied code \(tests\)/);
  assert.match(testCopies.output, /first\.test\.ts/);
  assert.equal(await readFile(join(root, "clone-baseline.json"), "utf8"), baseline);
});

test("a new force-tracked copy inside a gitignored directory remains a clone failure", async (t) => {
  const { root, baseline } = await fixture(t);
  await put(root, "src/original.ts", repeated(60));
  const initial = execute(root, process.execPath, ["scripts/check-clones.mjs"]);
  assert.equal(initial.status, 0, initial.output);
  await put(root, "build/forced-copy.ts", repeated(60));
  assert.equal(execute(root, "git", ["add", "--force", "build/forced-copy.ts"]).status, 0);
  const copied = execute(root, process.execPath, ["scripts/check-clones.mjs", "--prune"]);
  assert.equal(copied.status, 1, copied.output);
  assert.match(copied.output, /New copied code \(production\)/);
  assert.match(copied.output, /New copied code \(tests\)/);
  assert.match(copied.output, /build\/forced-copy\.ts/);
  assert.equal(await readFile(join(root, "clone-baseline.json"), "utf8"), baseline);
});
