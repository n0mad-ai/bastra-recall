import { after, before, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseDiff, parseLcov, normalizeSource, select, headline, testFiles, testScript, INERT, codeLinesOf, gitDiff,
  build, loadMap, MapError, DIRTY,
} from "../test-map.mjs";

// Revert-checks added below, one per bug found in review (each names what to break to
// go red): INERT swallowing real code after a same-line block comment or a bare leading
// star → revert INERT to the old unanchored regex; normalizeSource aliasing a vendored
// node_modules copy onto this repo's own packages/<name>/src path → revert to matching
// the tail pattern before checking `rel`; parseDiff losing a space-tagged filename's
// trailing tab, a binary-file diff entirely, or a rename+edit's old-path coverage →
// revert parseDiff to the pre-fix version.

// Revert-checks: read hunks on the NEW side in parseDiff → "old side" red; drop the
// inert marking → "comment-only" red; select by file instead of by line → "one line
// of a file" red; drop the uncovered report → "nobody runs" red.

const map = {
  commit: "c0ffee",
  tests: [
    { file: "packages/daemon/__tests__/a.test.ts", tests: 3, wall_ms: 100, src_lines: 10 },
    { file: "packages/daemon/__tests__/b.test.ts", tests: 5, wall_ms: 200, src_lines: 10 },
    { file: "packages/daemon/__tests__/blind.test.ts", tests: 2, wall_ms: 900, src_lines: 0 },
  ],
  sources: {
    "packages/daemon/src/x.ts": { lines: [[1, 40]], by: { 0: [[1, 10]], 1: [[1, 3], [20, 30]] } },
  },
};

const diff = (file, hunk, body) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${hunk}\n${body}\n`;

describe("test-map: diff → the tests that executed the changed lines", () => {
  it("reads hunks on the old side, where the map's line numbers live", () => {
    const d = parseDiff(diff("packages/daemon/src/x.ts", "@@ -25,2 +90,3 @@", "-a()\n-b()\n+c()\n+d()\n+e()"));
    assert.deepEqual([...d["packages/daemon/src/x.ts"].hunks[0]], [25, 26]);
  });

  it("a pure insertion covers the line it follows and the next one", () => {
    const d = parseDiff(diff("packages/daemon/src/x.ts", "@@ -9,0 +10,1 @@", "+x()"));
    assert.deepEqual([...d["packages/daemon/src/x.ts"].hunks[0]], [9, 10]);
  });

  it("a change to one line of a file picks only the test files that ran that line", () => {
    const r = select(map, diff("packages/daemon/src/x.ts", "@@ -25 +25 @@", "-if (a) f()\n+if (!a) f()"));
    assert.deepEqual(r.files.map((f) => f.file), ["packages/daemon/__tests__/b.test.ts", "packages/daemon/__tests__/blind.test.ts"]);
    assert.equal(r.full_suite, false);
  });

  it("a comment-only change needs no test", () => {
    const r = select(map, diff("packages/daemon/src/x.ts", "@@ -2 +2 @@", "-// old wording\n+// new wording"));
    assert.equal(r.files.length, 0);
    assert.equal(r.inert.length, 1);
  });

  it("an executable line nobody runs is reported, not passed as safe", () => {
    const r = select(map, diff("packages/daemon/src/x.ts", "@@ -35 +35 @@", "-return 1\n+return 2"));
    assert.deepEqual(r.uncovered, ["packages/daemon/src/x.ts:35-35"]);
  });

  // Revert-check: restore INERT to /^\s*(?:$|\/\/|\/\*|\*\/|\*(?:\s|$))/ (the old,
  // unanchored-at-the-end regex) and each of these three goes true (wrongly inert).
  it("INERT does not swallow a multiplication continuation starting with *", () => {
    assert.equal(INERT.test("  * 2;"), false);
  });
  it("INERT does not swallow code that follows a same-line block comment close", () => {
    assert.equal(INERT.test("/* eslint-disable */ doSomething();"), false);
    assert.equal(INERT.test("*/ realCode();"), false);
  });
  it("INERT still recognizes a real line comment and a self-closed block comment", () => {
    assert.equal(INERT.test("  // just a comment"), true);
    assert.equal(INERT.test("  /* just a comment */"), true);
    assert.equal(INERT.test(""), true);
  });

  it("a global file means the full suite", () => {
    const r = select(map, diff("package.json", "@@ -3 +3 @@", '-"a": 1\n+"a": 2'));
    assert.equal(r.full_suite, true);
  });

  it("an edited test file selects itself", () => {
    const r = select(map, diff("packages/daemon/__tests__/a.test.ts", "@@ -1 +1 @@", "-x\n+y"));
    assert.ok(r.files.some((f) => f.file === "packages/daemon/__tests__/a.test.ts"));
  });
});

describe("test-map: coverage input", () => {
  it("a source reached through another checkout maps back to this repo's path", () => {
    assert.equal(normalizeSource("../../other/checkout/packages/core/src/scrub.ts", "/repo"), "packages/core/src/scrub.ts");
  });

  // Revert-check: drop the `if (!rel.startsWith("..")) return rel;` early return (go
  // back to trying the packages/.../src tail match first) and this collides: a vendored
  // copy under node_modules with the same packages/<name>/src shape gets aliased onto
  // this repo's own file of the same name, merging unrelated coverage into it.
  it("a vendored copy inside node_modules does not alias onto this repo's own file of the same name", () => {
    const got = normalizeSource("/repo/node_modules/some-vendor/packages/core/src/x.ts", "/repo");
    assert.equal(got, "node_modules/some-vendor/packages/core/src/x.ts");
    assert.notEqual(got, "packages/core/src/x.ts");
  });

  it("lcov keeps executed lines apart from merely executable ones", () => {
    const cov = parseLcov("SF:packages/daemon/src/x.ts\nDA:1,3\nDA:2,0\nend_of_record\n", "/repo");
    assert.deepEqual([...cov.get("packages/daemon/src/x.ts").hit], [1]);
    assert.deepEqual([...cov.get("packages/daemon/src/x.ts").all], [1, 2]);
  });

  it("the test list is the root npm test script's, not a second copy", () => {
    const files = testFiles();
    assert.ok(files.length > 100);
    assert.ok(files.includes("tools/__tests__/test-map.test.mjs"));
  });
});

// Real `git diff` output, not hand-typed hunks: a space in a path, a binary file, and a
// rename+edit each have a header shape parseDiff's early hand-written fixtures never hit.
describe("test-map: parseDiff against real git diff output", () => {
  const repo = mkdtempSync(join(tmpdir(), "test-map-diff-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  let diffText;
  { // one commit, then a rename+edit, a binary change, and an edit to a spaced filename
    git("init", "-q");
    git("config", "user.email", "a@a.com");
    git("config", "user.name", "a");
    writeFileSync(join(repo, "old.ts"), "export function a(){\n  return 1;\n}\n");
    writeFileSync(join(repo, "img.png"), "binarydata");
    writeFileSync(join(repo, "my file.ts"), "export function b(x){\n  return x;\n}\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("mv", "old.ts", "renamed.ts");
    writeFileSync(join(repo, "renamed.ts"), "export function a(){\n  return 2;\n}\n");
    writeFileSync(join(repo, "img.png"), "\x00binarydata2");
    writeFileSync(join(repo, "my file.ts"), "export function b(x){\n  return x+1;\n}\n");
    git("add", "-A");
    diffText = git("diff", "-U0", "--cached", "HEAD");
  }

  it("a space in the filename does not leave a trailing tab corrupting the key", () => {
    const d = parseDiff(diffText);
    assert.ok(Object.hasOwn(d, "my file.ts"), Object.keys(d).join(", "));
    assert.ok(!Object.hasOwn(d, "my file.ts\t"));
  });

  it("a binary file is not invisible: it shows up as a diff entry", () => {
    const d = parseDiff(diffText);
    assert.ok(d["img.png"]?.binary);
  });

  it("a rename+edit carries the old path so select can still find its coverage", () => {
    const d = parseDiff(diffText);
    assert.equal(d["renamed.ts"].renameFrom, "old.ts");
  });

  it("select finds a rename+edit's tests under the OLD path, not just 'unmapped'", () => {
    const m = {
      commit: "c0ffee",
      tests: [{ file: "__tests__/a.test.ts", tests: 1, wall_ms: 10, src_lines: 2 }],
      sources: { "old.ts": { lines: [[1, 3]], by: { 0: [[1, 3]] } } },
    };
    const r = select(m, diffText);
    assert.ok(r.files.some((f) => f.file === "__tests__/a.test.ts"), JSON.stringify(r));
    assert.ok(!r.unmapped.includes("renamed.ts"));
  });

  it("a binary file is reported (unseen, not vouched), not silently dropped from every bucket", () => {
    const m = { commit: "c0ffee", tests: [], sources: {} };
    const r = select(m, diffText);
    assert.ok(r.unseen.includes("img.png"), JSON.stringify(r));
    assert.equal(r.vouched, false);
  });

  rmSync(repo, { recursive: true, force: true });
});

// Revert-check: in select, drop the whole-text pass (leave only parseDiff's line-local
// INERT) → the JSDoc case is red again (a doc-comment edit selects tests); make
// codeLinesOf treat every line starting with `*` as a comment → the continuation case
// is red. This is the pair the line-local regex cannot hold at the same time.
describe("test-map: comment or code is decided on the whole file", () => {
  it("codeLinesOf: JSDoc body is not code, a `* 2` continuation is, a regex cannot open a comment", () => {
    const t = ["/**", " * Explains the thing.", " * @param x", " */", "const a = b", "  * 2;", "const r = /[/*]/;", "after();", "const s = `x", "  // inside a template", "`;", "// c"].join("\n");
    assert.deepEqual([...codeLinesOf(t)], [5, 6, 7, 8, 9, 10, 11]);
  });

  const file = "packages/daemon/src/x.ts";
  const oldText = ["/**", " * Old wording.", " */", "export const k = a", "  * 2;"].join("\n");
  const m = { commit: "c0ffee", tests: [{ file: "packages/daemon/__tests__/a.test.ts", tests: 1, wall_ms: 1, src_lines: 2 }], sources: { [file]: { lines: [[4, 5]], by: { 0: [[1, 5]] } } } };

  it("a JSDoc-only edit selects nothing", () => {
    const newText = oldText.replace("Old wording.", "New wording.");
    const r = select(m, diff(file, "@@ -2 +2 @@", "- * Old wording.\n+ * New wording."), { readOld: () => oldText, readNew: () => newText });
    assert.equal(r.files.length, 0, JSON.stringify(r));
    assert.equal(r.inert.length, 1);
  });

  it("an edit to a `* 2` continuation line is code and selects its tests", () => {
    const newText = oldText.replace("* 2;", "* 3;");
    const r = select(m, diff(file, "@@ -5 +5 @@", "-  * 2;\n+  * 3;"), { readOld: () => oldText, readNew: () => newText });
    assert.deepEqual(r.files.map((f) => f.file), ["packages/daemon/__tests__/a.test.ts"]);
  });
});

// Revert-check: in testFiles go back to escaping only `.` (CodeQL js/incomplete-sanitization)
// → `+` stays a regex quantifier: "a+b*" matches aab1 and misses the literal a+b1 — red.
describe("test-map: the npm test glob is matched literally, not as a regex", () => {
  it("a regex metacharacter in the glob is a literal character of the filename", () => {
    const root = mkdtempSync(join(tmpdir(), "test-map-glob-"));
    try {
      execFileSync("mkdir", ["-p", join(root, "t")]);
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test t/a+b*.test.mjs" } }));
      for (const f of ["a+b1.test.mjs", "aab1.test.mjs", "ab1.test.mjs"]) writeFileSync(join(root, "t", f), "");
      assert.deepEqual(testFiles(root), ["t/a+b1.test.mjs"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Revert-check: in gitDiff drop --src-prefix/--dst-prefix → under diff.mnemonicPrefix the
// headers read `--- c/x.ts` / `+++ w/x.ts`, under diff.noprefix `--- x.ts`; parseDiff
// matches neither and returns {} → both cases red.
describe("test-map: the diff select reads does not depend on the user's git config", () => {
  for (const [key, value] of [["diff.mnemonicPrefix", "true"], ["diff.noprefix", "true"]]) {
    it(`${key}=${value} still yields the changed file`, () => {
      const repo = mkdtempSync(join(tmpdir(), "test-map-cfg-"));
      const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
      try {
        git("init", "-q");
        git("config", "user.email", "a@a.com");
        git("config", "user.name", "a");
        writeFileSync(join(repo, "x.ts"), "export const a = 1;\n");
        git("add", "-A");
        git("commit", "-q", "-m", "base");
        git("config", key, value);
        writeFileSync(join(repo, "x.ts"), "export const a = 2;\n");
        const d = parseDiff(gitDiff("HEAD", repo));
        assert.deepEqual(Object.keys(d), ["x.ts"]);
        assert.deepEqual([...d["x.ts"].hunks[0]], [1, 1]);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }
});

// Real `git diff` output again, for paths git C-quotes: non-ASCII (core.quotePath default),
// a `"` in the name, a binary with such a name, a rename into one.
// Revert-check: in parseDiff go back to matching `--- a/`, `+++ b/`, `Binary files a/` and the
// raw rename lines (no unquote) → every file here is missing from the result → all red.
describe("test-map: parseDiff reads git's quoted paths", () => {
  const repo = mkdtempSync(join(tmpdir(), "test-map-quoted-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  let diffText;
  {
    git("init", "-q");
    git("config", "user.email", "a@a.com");
    git("config", "user.name", "a");
    writeFileSync(join(repo, "café.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, 'q"x.ts'), "export const b = 1;\n");
    writeFileSync(join(repo, "ünï.png"), "\x00a");
    writeFileSync(join(repo, "old.ts"), "export function a(){\n  return 1;\n}\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(repo, "café.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, 'q"x.ts'), "export const b = 2;\n");
    writeFileSync(join(repo, "ünï.png"), "\x00b");
    git("mv", "old.ts", "rén.ts");
    writeFileSync(join(repo, "rén.ts"), "export function a(){\n  return 2;\n}\n");
    git("add", "-A");
    diffText = gitDiff("HEAD", repo);
  }
  rmSync(repo, { recursive: true, force: true });

  it("the diff really is quoted (else this block tests nothing)", () => {
    assert.match(diffText, /^--- "a\/caf\\303\\251\.ts"$/m);
  });

  it("a non-ASCII and a quote-carrying path come out as the real names, with their hunks", () => {
    const d = parseDiff(diffText);
    assert.deepEqual([...d["café.ts"].hunks[0]], [1, 1]);
    assert.deepEqual([...d['q"x.ts'].hunks[0]], [1, 1]);
  });

  it("a binary with a quoted name is still reported as binary", () => {
    assert.ok(parseDiff(diffText)["ünï.png"]?.binary);
  });

  it("a rename into a quoted name keeps its old path, so select finds its tests", () => {
    assert.equal(parseDiff(diffText)["rén.ts"]?.renameFrom, "old.ts");
    const m = { commit: "c0ffee", tests: [{ file: "__tests__/a.test.ts", tests: 1, wall_ms: 1, src_lines: 3 }], sources: { "old.ts": { lines: [[1, 3]], by: { 0: [[1, 3]] } } } };
    const r = select(m, diffText, { readOld: () => null, readNew: () => null });
    assert.deepEqual(r.files.map((f) => f.file), ["__tests__/a.test.ts"]);
  });
});

// Revert-check: restore `if (!hit && overlaps(src.lines, h))` in select → both cases land in
// no bucket at all (no files, not uncovered, not inert) → red.
describe("test-map: a code change on lines the map dropped as comments is reported", () => {
  const file = "packages/daemon/src/x.ts";
  const m = { commit: "c0ffee", tests: [{ file: "packages/daemon/__tests__/a.test.ts", tests: 1, wall_ms: 1, src_lines: 2 }], sources: { [file]: { lines: [[1, 1], [4, 4]], by: { 0: [[1, 1], [4, 4]] } } } };
  const oldText = ["a();", "// b();", "// c();", "d();"].join("\n");

  it("uncommenting a call is a code change no test ran", () => {
    const newText = oldText.replace("// b();", "b();");
    const r = select(m, diff(file, "@@ -2 +2 @@", "-// b();\n+b();"), { readOld: () => oldText, readNew: () => newText });
    assert.deepEqual(r.uncovered, [`${file}:2-2`], JSON.stringify(r));
  });

  it("code inserted between two comment lines is a code change no test ran", () => {
    const newText = ["a();", "// b();", "e();", "// c();", "d();"].join("\n");
    const r = select(m, diff(file, "@@ -2,0 +3 @@", "+e();"), { readOld: () => oldText, readNew: () => newText });
    assert.deepEqual(r.uncovered, [`${file}:2-3`], JSON.stringify(r));
  });
});

// Revert-checks: drop the `fresh` branch in select → the new test is only "unmapped" → red;
// drop the `!d.deleted` guard → the deleted test is selected (and --run would `node --test`
// a missing file) → red; drop the untracked loop in gitDiff → the untracked files are
// absent → red.
describe("test-map: test files written or deleted since the map", () => {
  const add = (f) => `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1 @@\n+it("x", () => {});\n`;
  const del = (f) => `diff --git a/${f} b/${f}\ndeleted file mode 100644\n--- a/${f}\n+++ /dev/null\n@@ -1 +0,0 @@\n-it("x", () => {});\n`;

  it("a new test file the npm test globs pick up is selected, not just 'not in map'", () => {
    const f = "packages/daemon/__tests__/new.test.ts";
    const r = select(map, add(f), { script: { setup: [], files: [f] }, readOld: () => "", readNew: () => 'it("x", () => {});' });
    assert.ok(r.files.some((x) => x.file === f && x.new), JSON.stringify(r));
    assert.ok(!r.unmapped.includes(f));
  });

  it("a deleted test file is not selected", () => {
    const f = "packages/daemon/__tests__/a.test.ts";
    const r = select(map, del(f), { script: { setup: [], files: [] }, readOld: () => 'it("x", () => {});', readNew: () => "" });
    assert.ok(!r.files.some((x) => x.file === f), JSON.stringify(r.files));
  });

  it("gitDiff includes untracked files, as added", () => {
    const repo = mkdtempSync(join(tmpdir(), "test-map-untracked-"));
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "a@a.com");
      git("config", "user.name", "a");
      writeFileSync(join(repo, ".gitignore"), "skip.ts\n");
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      execFileSync("mkdir", ["-p", join(repo, "__tests__")]);
      writeFileSync(join(repo, "__tests__", "n.test.ts"), 'it("x", () => {});\n');
      writeFileSync(join(repo, "my new.ts"), "export const a = 1;\n");
      writeFileSync(join(repo, "skip.ts"), "export const s = 1;\n");
      const d = parseDiff(gitDiff("HEAD", repo));
      assert.deepEqual(Object.keys(d).sort(), ["__tests__/n.test.ts", "my new.ts"]);
      assert.ok(d["my new.ts"].added);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// Revert-checks: drop `|| current().setup.includes(file)` in select → the setup file is
// only "unseen" → red; slice the flags from 0 instead of after "node" → red.
describe("test-map: the test setup is read from the npm test script, once", () => {
  it("this repo's script: tsx and scripts/test-env.mjs are the flags, the latter the setup", () => {
    const { flags, setup } = testScript();
    assert.deepEqual(flags, ["--import", "tsx", "--import", "./scripts/test-env.mjs"]);
    assert.deepEqual(setup, ["scripts/test-env.mjs"]);
  });

  it("a change to a setup file the script preloads runs the full suite", () => {
    const r = select(map, diff("t/setup.mjs", "@@ -1 +1 @@", "-a()\n+b()"), { script: { setup: ["t/setup.mjs"], files: [] } });
    assert.equal(r.full_suite, true);
    assert.deepEqual(r.full_why, ["t/setup.mjs: a global file"]);
  });
});

// Revert-checks: in select push every non-code file to `unseen` (drop the FIXTURE branch)
// → the fixture case is red; drop the unseen line from `doubts` → the README case is red
// (vouched, "0 test files — no code changed"); drop the `!r.vouched` branch of headline →
// the headline case is red.
describe("test-map: a file coverage cannot see is never passed as safe", () => {
  it("test data under fixtures/ or __tests__/ runs the full suite, and says why", () => {
    for (const f of ["packages/eval/fixtures/eval-vault/memories/a.md", "fixtures/sample-vault/x.json", "packages/daemon/__tests__/snap.txt"]) {
      const r = select(map, diff(f, "@@ -1 +1 @@", "-a\n+b"));
      assert.equal(r.full_suite, true, f);
      assert.match(headline(r), /^FULL SUITE — .*test data/);
    }
  });

  it("any other non-code file selects nothing and is NOT VOUCHED, not \"0 tests, fine\"", () => {
    const r = select(map, diff("README.md", "@@ -1 +1 @@", "-a\n+b"));
    assert.equal(r.files.length, 0);
    assert.equal(r.vouched, false);
    assert.match(headline(r), /^0 test files, .* — NOT VOUCHED for 1 change:$/);
    assert.match(r.doubts[0], /^README\.md: not code/);
  });

  it("a comment-only change is vouched with zero files, and says why it is zero", () => {
    const r = select(map, diff("packages/daemon/src/x.ts", "@@ -2 +2 @@", "-// old\n+// new"));
    assert.equal(r.vouched, true);
    assert.equal(headline(r), "0 test files — only comments or blank lines changed");
  });
});

// A real repository with real coverage: build runs its tests, select reads real `git diff`
// output. Everything here is measured, not hand-typed.
describe("test-map: select over a real repo and a real map", () => {
  const TOOL = fileURLToPath(new URL("../test-map.mjs", import.meta.url));
  const SRC = [
    "/**", " * add and twice are run by every test; pick(1) by b only.", " */",
    "export function add(a, b) {", "  return a + b;", "}", "",
    "// a line comment", "export function pick(x) {", "  if (x > 0) {", '    return "pos";', "  }",
    '  return "neg"; // no test takes this branch', "}", "",
    "export function twice(x) {", "  const y = x", "    * 2;", "  return y;", "}", "",
    "export function unused() {", "  return 42;", "}", "",
  ].join("\n");
  const repo = mkdtempSync(join(tmpdir(), "test-map-real-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const put = (f, text) => { mkdirSync(join(repo, f, ".."), { recursive: true }); writeFileSync(join(repo, f), text); };
  const cli = (...args) => spawnSync(process.execPath, [join(repo, "tools", "test-map.mjs"), ...args], { cwd: repo, encoding: "utf8" });
  let m;

  before(async () => {
    put("package.json", JSON.stringify({ type: "module", scripts: { test: "node --test t/*.test.mjs" } }));
    put(".gitignore", ".test-map/\n");
    put("src/m.mjs", SRC);
    const imp = 'import { it } from "node:test";\nimport { strict as assert } from "node:assert";\nimport { add, pick, twice } from "../src/m.mjs";\n';
    put("t/a.test.mjs", `${imp}it("a", () => { assert.equal(add(1, 2), 3); assert.equal(twice(2), 4); });\n`);
    put("t/b.test.mjs", `${imp}it("b", () => { assert.equal(pick(1), "pos"); assert.equal(add(0, 0), 0); });\n`);
    put("t/c.test.mjs", `${imp}import { readFileSync } from "node:fs";\n` +
      'it("c", () => { assert.equal(add(JSON.parse(readFileSync(new URL("fixtures/data.json", import.meta.url), "utf8")).n, 1), 2); });\n');
    put("t/fixtures/data.json", '{ "n": 1 }\n');
    put("tools/test-map.mjs", readFileSync(TOOL, "utf8"));
    git("init", "-q");
    git("config", "user.email", "a@a.com");
    git("config", "user.name", "a");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    m = await build({ root: repo, jobs: 3 });
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  const selectNow = () => select(m, gitDiff(m.commit, repo), { root: repo });
  const ran = (t, line) => Object.entries(m.sources["src/m.mjs"].by).some(([i, rs]) => m.tests[i].file === t && rs.some(([x, y]) => x <= line && line <= y));
  const at = (text) => SRC.split("\n").indexOf(text) + 1;

  it("the map is real: each test ran what it calls, none ran the untaken branch, no one sees the fixture", () => {
    assert.deepEqual(m.tests.map((t) => [t.file, t.exit]), [["t/a.test.mjs", 0], ["t/b.test.mjs", 0], ["t/c.test.mjs", 0]]);
    assert.ok(ran("t/a.test.mjs", at("    * 2;")) && !ran("t/c.test.mjs", at("    * 2;")));
    assert.ok(ran("t/b.test.mjs", at('    return "pos";')) && !ran("t/a.test.mjs", at('    return "pos";')));
    for (const t of ["t/a.test.mjs", "t/b.test.mjs", "t/c.test.mjs"]) assert.ok(!ran(t, at('  return "neg"; // no test takes this branch')));
    assert.deepEqual(Object.keys(m.sources), ["src/m.mjs"]);
  });

  // The invariant, over seeded random edits of real lines: every test the map says
  // executed a changed line is selected (sound), and a code change never comes back as
  // an empty pass. The oracle is the edit itself (which old lines it hit), not the diff.
  // Revert-checks: read hunks on the new side, or cover only line `start` for a pure
  // insertion → the sound assertion is red; drop `report.uncovered.push` → the empty-
  // pass assertion is red.
  it("sound and never empty-as-pass, over 100 generated edits (the ones that still parse)", () => {
    const old = SRC.split("\n").slice(0, -1); // the trailing "" is the final newline
    const oldCode = codeLinesOf(SRC);
    let rnd = 0x9e3779b9;
    const next = (n) => { rnd = (Math.imul(rnd ^ (rnd >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return rnd % n; };
    const seen = { edits: 0, required: 0, emptyUnvouched: 0, inertOnly: 0 };
    for (let trial = 0; trial < 100; trial++) {
      // Edits at least 3 lines apart, one hunk each. Two adjacent edits merge into one
      // hunk that reads as "these old lines replaced" — seen by the tests of those lines,
      // not of the neighbours an insertion alone would count (trial 6 of this seed, when
      // edits could touch: insert after 6 + modify 7 = one hunk on line 7).
      const lines = [];
      for (let n = 1 + next(3), tries = 0; lines.length < n && tries < 20; tries++) {
        const k = 1 + next(old.length);
        if (lines.every((l) => Math.abs(l - k) >= 3)) lines.push(k);
      }
      lines.sort((a, b) => b - a);
      const text = [...old];
      const required = new Set();
      const ops = [];
      let codeTouched = false;
      for (const k of lines) { // bottom-up, so each k is still an old line number
        const op = ["modify", "delete", "insert"][next(3)];
        ops.push(`${op}@${k}`);
        const around = op === "insert" ? [k, k + 1] : [k];
        for (const t of m.tests) if (around.some((l) => ran(t.file, l))) required.add(t.file);
        if (op === "modify") { text[k - 1] += " 0"; codeTouched ||= oldCode.has(k); }
        if (op === "delete") { text.splice(k - 1, 1); codeTouched ||= oldCode.has(k); }
        if (op === "insert") text.splice(k, 0, "globalThis.__e = 1; // INS");
      }
      const now = text.join("\n") + "\n";
      try { new Function(now.replace(/^export /gm, "")); } catch { continue; } // a syntax error is not an edit
      codeTouched ||= now.split("\n").some((l, i) => l.includes("// INS") && codeLinesOf(now).has(i + 1));
      put("src/m.mjs", now);
      seen.edits++;
      const r = selectNow();
      const picked = new Set(r.files.map((f) => f.file));
      const why = `trial ${trial}, ${ops}: ${JSON.stringify({ picked: [...picked], doubts: r.doubts, inert: r.inert })}`;
      for (const t of required) assert.ok(picked.has(t), `${t} ran a changed line but was not selected — ${why}`);
      if (codeTouched) assert.ok(picked.size > 0 || !r.vouched, `code changed, nothing selected, and vouched — ${why}`);
      if (codeTouched && !picked.size) assert.match(headline(r), /NOT VOUCHED/, why);
      if (required.size) seen.required++;
      if (codeTouched && !picked.size) seen.emptyUnvouched++;
      if (!codeTouched) seen.inertOnly++;
    }
    put("src/m.mjs", SRC);
    // Guard against a property that held by testing nothing: each branch was exercised.
    assert.ok(seen.edits >= 50 && seen.required >= 20 && seen.emptyUnvouched >= 1 && seen.inertOnly >= 1, JSON.stringify(seen));
  });

  it("the untaken branch alone: zero files, NOT VOUCHED, and --run exits 3 after running nothing", () => {
    put("src/m.mjs", SRC.replace('return "neg";', 'return "NEG";'));
    try {
      const r = selectNow();
      assert.deepEqual(r.files, []);
      assert.deepEqual(r.uncovered, [`src/m.mjs:${at('  return "neg"; // no test takes this branch')}-${at('  return "neg"; // no test takes this branch')}`]);
      const out = cli("select", "--run");
      assert.equal(out.status, 3, out.stdout + out.stderr);
      assert.match(out.stdout, /^0 test files, .* — NOT VOUCHED for 1 change:\n {2}src\/m\.mjs:\d+-\d+: code no test executes$/m);
    } finally {
      put("src/m.mjs", SRC);
    }
  });

  it("a covered change: --run runs the tests that ran it and exits 0", () => {
    put("src/m.mjs", SRC.replace('return "pos";', 'return "pos" ;'));
    try {
      const out = cli("select", "--run");
      assert.equal(out.status, 0, out.stdout + out.stderr);
      assert.match(out.stdout, /^1 test files, 1 of 3 tests/m);
      assert.match(out.stdout, /t\/b\.test\.mjs/);
    } finally {
      put("src/m.mjs", SRC);
    }
  });

  // Revert-check: drop the FIXTURE branch → the fixture is only "unseen" → red.
  it("the fixture test c reads, invisible to coverage, runs the full suite", () => {
    put("t/fixtures/data.json", '{ "n": 2 }\n');
    try {
      const r = selectNow();
      assert.equal(r.full_suite, true);
      assert.deepEqual(r.fixtures, ["t/fixtures/data.json"]);
    } finally {
      put("t/fixtures/data.json", '{ "n": 1 }\n');
    }
  });

  // Revert-check: drop the map.dirty line from `doubts` → the select case is red; drop
  // the `if (map.dirty) warn(DIRTY)` in main → the stderr case is red.
  it("a map built on a dirty tree: select warns on stderr and does not vouch", () => {
    const dirty = { ...m, dirty: true };
    put("src/m.mjs", SRC.replace('return "pos";', 'return "pos" ;'));
    try {
      const r = select(dirty, gitDiff(m.commit, repo), { root: repo });
      assert.equal(r.vouched, false);
      assert.deepEqual(r.doubts, [DIRTY]);
      writeFileSync(join(repo, ".test-map", "map.json"), JSON.stringify(dirty));
      assert.ok(cli("select").stderr.includes(`test-map: ${DIRTY}\n`));
    } finally {
      writeFileSync(join(repo, ".test-map", "map.json"), JSON.stringify(m));
      put("src/m.mjs", SRC);
    }
  });

  // Revert-check: drop the `git cat-file -e` check in loadMap → select dies later inside
  // `git diff` with a stack trace → both assertions red.
  it("a map commit gone from the repo is one line saying to rebuild, not a stack trace", () => {
    const gone = { ...m, commit: "0123456789abcdef0123456789abcdef01234567" };
    writeFileSync(join(repo, ".test-map", "map.json"), JSON.stringify(gone));
    try {
      assert.throws(() => loadMap(repo), (e) => e instanceof MapError && /rebuild the map/.test(e.message));
      const out = cli("select");
      assert.equal(out.status, 2);
      assert.equal(out.stderr, "test-map: the map's commit 01234567 is not in this repository any more (rebased or garbage-collected) — rebuild the map: run `node tools/test-map.mjs build`\n");
    } finally {
      writeFileSync(join(repo, ".test-map", "map.json"), JSON.stringify(m));
    }
  });
});

describe("test-map: what the map cannot see and select cannot say", () => {
  it.todo("a source line run only inside a child process a test spawns: whether Node's coverage follows the child is not measured here; if it does not, a change there is `uncovered` (said), but a test spawning it is not selected");
});
