import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDiff, parseLcov, normalizeSource, select, testFiles, INERT, codeLinesOf } from "../test-map.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

// Revert-checks added below, one per bug found in review (each names what to break to
// go red): INERT swallowing real code after a same-line block comment or a bare leading
// star → revert INERT to the old unanchored regex; normalizeSource aliasing a vendored
// node_modules copy onto this repo's own packages/<name>/src path → revert to matching
// the tail pattern before checking `rel`; parseDiff losing a space-tagged filename's
// trailing tab, a binary-file diff entirely, or a rename+edit's old-path coverage →
// revert parseDiff to the pre-fix version; heatmap --html innerHTML-ing a raw filename →
// drop the esc() calls in tools/test-map-heatmap.html.

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

// Revert-check: drop the esc() wrapping around f.f / g / s.f / h.at / b in the innerHTML
// template literals of tools/test-map-heatmap.html and the injected marker below reaches
// the DOM unescaped (assertion fails on the literal "<img" substring).
describe("test-map: heatmap --html escapes a crafted filename before innerHTML", () => {
  it("a filename shaped like an HTML injection is escaped in the rendered page", () => {
    const work = mkdtempSync(join(tmpdir(), "test-map-html-"));
    const mapPath = join(ROOT, ".test-map", "map.json");
    const backup = existsSync(mapPath) ? join(work, "map.json.bak") : null;
    if (backup) copyFileSync(mapPath, backup);
    try {
      const evil = 'packages/x/src/"><img src=x onerror=alert(1)>.ts';
      const map = {
        version: 1, commit: "c0ffee", dirty: false, built_at: new Date().toISOString(), node: process.version, jobs: 1,
        tests: [{ file: "tools/__tests__/fake.test.mjs", tests: 1, pass: 1, fail: 0, skipped: 0, wall_ms: 10, exit: 0, src_lines: 1 }],
        sources: { [evil]: { lines: [[1, 1]], by: { 0: [[1, 1]] } } },
      };
      execFileSync("mkdir", ["-p", dirname(mapPath)]);
      writeFileSync(mapPath, JSON.stringify(map));
      const outHtml = join(work, "out.html");
      execFileSync(process.execPath, [join(ROOT, "tools", "test-map.mjs"), "heatmap", "--html", outHtml], { cwd: ROOT, encoding: "utf8" });
      const page = readFileSync(outHtml, "utf8");
      const scriptBody = page.match(/<script>([\s\S]*)<\/script>/)[1];

      const el = () => ({ innerHTML: "", textContent: "", value: "", style: {}, attrs: { "aria-pressed": "false" },
        classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, appendChild() {},
        setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } });
      const byId = Object.fromEntries(["commit", "nums", "verify", "groups", "detail", "suites", "hot", "blind", "q", "cold"].map((id) => [id, el()]));
      const doc = {
        getElementById: (id) => byId[id],
        createElement: () => el(),
        documentElement: el(),
      };
      const getComputedStyle = () => ({ getPropertyValue: () => "#334455" });
      const fn = new Function("document", "getComputedStyle", scriptBody);
      fn(doc, getComputedStyle);

      for (const id of ["detail", "groups", "suites", "hot", "blind"]) {
        assert.ok(!byId[id].innerHTML.includes("<img"), `${id}.innerHTML leaked a raw tag: ${byId[id].innerHTML}`);
      }
      assert.ok(byId.detail.innerHTML.includes("&lt;img"), "expected the filename to appear HTML-escaped somewhere");
    } finally {
      if (backup) copyFileSync(backup, mapPath);
      rmSync(work, { recursive: true, force: true });
    }
  });
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
