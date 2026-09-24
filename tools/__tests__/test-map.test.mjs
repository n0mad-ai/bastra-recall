import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff, parseLcov, normalizeSource, select, testFiles, INERT, codeLinesOf, gitDiff } from "../test-map.mjs";

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

  it("a binary file is reported (ignored), not silently dropped from every bucket", () => {
    const m = { commit: "c0ffee", tests: [], sources: {} };
    const r = select(m, diffText);
    assert.ok(r.ignored.includes("img.png"), JSON.stringify(r));
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
    const r = select(map, add(f), { testFiles: [f], readOld: () => "", readNew: () => 'it("x", () => {});' });
    assert.ok(r.files.some((x) => x.file === f && x.new), JSON.stringify(r));
    assert.ok(!r.unmapped.includes(f));
  });

  it("a deleted test file is not selected", () => {
    const f = "packages/daemon/__tests__/a.test.ts";
    const r = select(map, del(f), { testFiles: [], readOld: () => 'it("x", () => {});', readNew: () => "" });
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
