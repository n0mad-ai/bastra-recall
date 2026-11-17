/**
 * docs/invariants.md and the invariant tests cannot drift apart (#1570).
 *
 * The catalog names each invariant's ID and the file holding its tests; a test
 * holds an invariant when its title starts with the ID. Red here means a catalog
 * entry lost its test, a test claims an ID the catalog does not list, or a test
 * written for an invariant does not say which one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ID = /INV-[A-Z0-9]+-\d{2}/;

/** ID → files, from the catalog's table rows. */
function readCatalog() {
  const text = readFileSync(join(root, "docs", "invariants.md"), "utf8");
  const entries = new Map();
  const duplicates = [];
  for (const row of text.matchAll(/^\|\s*(INV-[A-Z0-9]+-\d{2})\s*\|.*$/gm)) {
    const files = [...row[0].matchAll(/`((?:packages|tools)\/[^`]+\.test\.(?:ts|mjs))`/g)].map((m) => m[1]);
    if (entries.has(row[1])) duplicates.push(row[1]);
    entries.set(row[1], files);
  }
  return { entries, duplicates };
}

/** Every test file the suites run: packages/<pkg>/__tests__/*.test.ts and tools/__tests__/*.test.mjs. */
function testFiles() {
  const files = [];
  for (const pkg of readdirSync(join(root, "packages"))) {
    const dir = join("packages", pkg, "__tests__");
    if (!existsSync(join(root, dir))) continue;
    for (const f of readdirSync(join(root, dir))) if (f.endsWith(".test.ts")) files.push(`${dir}/${f}`);
  }
  for (const f of readdirSync(join(root, "tools", "__tests__"))) {
    if (f.endsWith(".test.mjs")) files.push(`tools/__tests__/${f}`);
  }
  return files;
}

/** Titles of `test(…)` / `it(…)` calls written as a literal string. */
function titles(file) {
  const text = readFileSync(join(root, file), "utf8");
  return [...text.matchAll(/^\s*(?:test|it)\(\s*(["'`])((?:\\.|(?!\1).)*)\1/gm)].map((m) => m[2]);
}

test("INV-CATALOG: every invariant names a test file, and that file holds a test with its ID", () => {
  const { entries, duplicates } = readCatalog();
  assert.ok(entries.size >= 10, `the catalog lists only ${entries.size} invariants, the parser is broken`);
  assert.deepEqual(duplicates, [], "an ID is listed twice");
  const problems = [];
  for (const [id, files] of entries) {
    if (files.length === 0) problems.push(`${id}: no test file named`);
    for (const file of files) {
      if (!existsSync(join(root, file))) problems.push(`${id}: ${file} does not exist`);
      else if (!titles(file).some((t) => t.startsWith(`${id}:`)))
        problems.push(`${id}: no test in ${file} whose title starts with "${id}:"`);
    }
  }
  assert.deepEqual(problems, []);
});

test("INV-CATALOG: every ID a test carries is in the catalog, in the file the catalog names", () => {
  const { entries } = readCatalog();
  const problems = [];
  for (const file of testFiles()) {
    if (file === "tools/__tests__/invariants-catalog.test.mjs") continue;
    for (const title of titles(file)) {
      const id = title.match(ID)?.[0];
      if (!id) continue;
      if (!title.startsWith(`${id}:`)) problems.push(`${file}: "${title}" — the ID must open the title`);
      else if (!entries.has(id)) problems.push(`${file}: ${id} is not in docs/invariants.md`);
      else if (!entries.get(id).includes(file)) problems.push(`${file}: ${id} is not listed for this file`);
    }
  }
  assert.deepEqual(problems, []);
});

test("INV-CATALOG: every test in an *.invariant.test file carries an invariant ID", () => {
  const problems = [];
  const files = testFiles().filter((f) => /\.invariant\.test\.(?:ts|mjs)$/.test(f));
  assert.ok(files.length > 0, "no *.invariant.test files found");
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    const calls = [...text.matchAll(/^\s*(?:test|it)\(/gm)].length;
    const tagged = titles(file).filter((t) => ID.test(t) && t.startsWith(t.match(ID)[0])).length;
    if (calls !== tagged) problems.push(`${file}: ${calls - tagged} test(s) without an INV- ID opening the title`);
  }
  assert.deepEqual(problems, []);
});
