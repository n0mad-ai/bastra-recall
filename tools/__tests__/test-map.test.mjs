import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { parseDiff, parseLcov, normalizeSource, select, testFiles } from "../test-map.mjs";

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
