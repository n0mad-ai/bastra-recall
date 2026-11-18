import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- plain .mjs script without type declarations
import { compareFile, run, serializeTree } from "../scripts/ast-equivalence.mjs";

interface Row {
  file: string;
  before_sha256: string;
  after_sha256: string;
  equal: boolean;
}
interface Result {
  formatter_commit: string;
  script_sha256: string;
  summary: { files: number; equal: number; differing: string[] };
  files: Row[];
}

const tree = (src: string, file = "x.ts"): string =>
  (serializeTree as (s: string, f: string) => { text: string })(src, file).text;
const same = (a: string, b: string, file = "x.ts"): boolean => tree(a, file) === tree(b, file);

test("layout-only rewrites leave the tree equal (#1536)", () => {
  assert.ok(same(`const a = 'x' // note\n`, `const a = "x";\n`), "quotes, semicolon, comment");
  assert.ok(same(`f(a, b,)`, `f(\n  a,\n  b\n)`), "trailing comma and line breaks");
  assert.ok(same(`const n = 1.50`, `const n = 1.5`), "number spelling");
  assert.ok(same(`x = a || (b || c)`, `x = a || b || c`), "re-nested || chain");
  assert.ok(same(`x = (a && b) && c`, `x = a && b && c`), "re-nested && chain");
  assert.ok(same(`r = /a/gmi`, `r = /a/gim`), "regex flag order");
  assert.ok(same(`y = (a + b)`, `y = a + b`), "redundant parentheses");
});

test("a real change is a different tree (#1536)", () => {
  assert.ok(!same(`let a = 1`, `const a = 1`), "let/const");
  assert.ok(!same(`y = (a + b) * c`, `y = a + b * c`), "grouping");
  assert.ok(!same(`y = (a?.b).c`, `y = a?.b.c`), "optional chain extent");
  assert.ok(!same(`y = "a"`, `y = "b"`), "string value");
  assert.ok(!same(`y = 1`, `y = 2`), "number value");
  assert.ok(!same(`y = a || b && c`, `y = (a || b) && c`), "mixed operators keep their grouping");
  assert.ok(!same(`r = /a/g`, `r = /a/gi`), "regex flags");
  assert.ok(!same("t = String.raw`a\\n`", "t = String.raw`a\\\\n`"), "template raw text");
});

test("a directive prologue keeps its meaning: strict mode is not a layout detail (#1536 review)", () => {
  const strict = 'function f(){"use strict"; return this;}';
  // Parenthesised, it is an ordinary expression statement: the function is not strict.
  assert.ok(!same(strict, 'function f(){("use strict"); return this;}', "x.js"), "parenthesised directive");
  // An escape in the raw text is no "use strict" directive either, although the value is equal.
  assert.ok(!same(strict, 'function f(){"use\\x20strict"; return this;}', "x.js"), "escaped directive");
  assert.ok(!same('"use strict"; x = 1;', '("use strict"); x = 1;', "x.js"), "file prologue");
  // Quote style of a directive is layout: both are the same directive.
  assert.ok(same(strict, "function f(){'use strict'; return this;}", "x.js"), "directive quote style");
  // Only the leading strings are a prologue; a later string statement stays a value.
  assert.ok(same('f(); "use strict";', "f(); ('use strict');", "x.js"), "string statement after the prologue");
});

test("compareFile reports a changed tree as unequal (#1536)", () => {
  const repo = mkdtempSync(join(tmpdir(), "bastra-ast-eq-"));
  const g = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" }).trim();
  g("init", "-q");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  g("add", "a.ts");
  g("commit", "-qm", "one");
  const first = g("rev-parse", "HEAD");
  writeFileSync(join(repo, "a.ts"), "export let a = 1;\n");
  g("commit", "-qam", "two");
  const second = g("rev-parse", "HEAD");
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    const row = (compareFile as (f: string, p: string, c: string) => Row & { first_difference?: unknown })(
      "a.ts",
      first,
      second
    );
    assert.equal(row.equal, false);
    assert.ok(row.first_difference);
  } finally {
    process.chdir(cwd);
  }
});

const registered = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "registrations", "ast-equivalence-0f9f0604.json"), "utf8")
) as Result;

const hasHistory = (() => {
  try {
    execFileSync("git", ["cat-file", "-e", `${registered.formatter_commit}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test(
  "the registered AST-equivalence artefact is reproduced from git (#1536)",
  { skip: !hasHistory && "shallow clone" },
  () => {
    const now = (run as () => Result)();
    assert.deepEqual(registered.summary.differing, []);
    // The artefact names the script that produced it; an edited script needs a regenerated artefact.
    const script = readFileSync(join(import.meta.dirname, "..", "scripts", "ast-equivalence.mjs"));
    assert.equal(registered.script_sha256, createHash("sha256").update(script).digest("hex"));
    assert.equal(registered.summary.equal, registered.summary.files);
    assert.deepEqual(
      now.files.map((r) => [r.file, r.before_sha256, r.after_sha256, r.equal]),
      registered.files.map((r) => [r.file, r.before_sha256, r.after_sha256, r.equal])
    );
  }
);
