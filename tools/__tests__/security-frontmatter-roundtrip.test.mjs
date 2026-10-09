import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "package.json"));

test("frontmatter reads and roundtrips stay byte-identical without loading the YAML CLI dependencies", () => {
  // Golden serialization from main 021d7bee, BEFORE the argparse override:
  // gray-matter 4.0.3 / js-yaml 3.15.2 / argparse 1.0.10. These are invented
  // vault fixtures, never the operator's vault. A fixture edit needs a fresh
  // comparison with the unchanged parser, not an unexplained golden update.
  const fixtures = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".md")) fixtures.push(path);
    }
  };
  for (const dir of ["fixtures/sample-vault", "packages/eval/fixtures/eval-vault", "packages/eval/fixtures/eval-vault-de"]) walk(join(root, dir));
  const load = Module._load;
  Module._load = function (request, ...args) {
    if (request === "argparse" || request === "sprintf-js") throw new Error(`Frontmatter reached CLI dependency ${request}`);
    return load.call(this, request, ...args);
  };
  try {
    const matter = require("gray-matter");
    const digest = createHash("sha256");
    for (const path of fixtures.sort()) {
      const parsed = matter(readFileSync(path, "utf8"));
      const serialized = matter.stringify(parsed.content, parsed.data);
      const reread = matter(serialized);
      assert.deepEqual(reread.data, parsed.data, relative(root, path));
      assert.equal(matter.stringify(reread.content, reread.data), serialized, relative(root, path));
      digest.update(relative(root, path).replaceAll("\\", "/") + "\0" + serialized + "\0");
    }
    assert.equal(fixtures.length, 23);
    assert.equal(digest.digest("hex"), "d53d06bf28afe905cd481f20ed1bfa7439c02607c30b9da5a8d7b6fde34978ca");
  } finally {
    Module._load = load;
  }
});
