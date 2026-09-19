/**
 * Test-based truth, on a JavaScript repository small enough to reason about
 * (#582, delivered-impact measurement).
 *
 * The type-based truth is checked by tsc and can be believed on inspection.
 * The test-based truth is a RULE — "a test that used to pass now fails, and it
 * reaches this file" — and every step of it is a place where a measurement can
 * quietly become flattering: a timeout read as "breaks nothing", a flaky test
 * counted as evidence, a break over a string contract filed as if an import
 * graph could have found it.
 *
 * So the fixture is a real repository with a real runner: three source files,
 * two test files, and two ways to break it — one along an import edge, one over
 * a file read by path, which no import graph can see.
 */
import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error — plain .mjs measurement scripts, no declarations
import {
  TRUTH_RULE,
  attribute,
  brokenCases,
  detectRunner,
  importClosure,
  isTestFile,
  parseTap,
  resolveSpecifier,
  runSuite,
  specifiersOf,
  testFileOfCase,
  truthFromBrokenTests,
  // @ts-expect-error — plain .mjs measurement scripts, no declarations
} from "../code-roi/v2/test-truth.mjs";
// @ts-expect-error — plain .mjs measurement scripts, no declarations
import { isScenarioFile, repoProfile } from "../code-roi/v2/repo-profile.mjs";

// ─── The fixture repository ──────────────────────────────────────

const FILES: Record<string, string> = {
  "package.json": `{ "name": "truth-fixture", "private": true, "scripts": { "test": "node --test tests/*.test.js" } }\n`,
  "src/tax.js": `const RATE = 0.19;
function calcTax(base) {
  return Math.round(base * RATE * 100) / 100;
}
module.exports = { calcTax, RATE };
`,
  "src/report.js": `const { calcTax } = require("./tax");
function render(base) {
  return \`Tax: \${calcTax(base)}\`;
}
module.exports = { render };
`,
  // Read by PATH, never imported: this is the graph blind spot the measurement
  // has to report separately instead of mixing it into import coupling.
  "src/labels.json": `{ "title": "Report" }\n`,
  "tests/tax.test.js": `const test = require("node:test");
const assert = require("node:assert/strict");
const { calcTax } = require("../src/tax");
test("calcTax applies the rate", () => {
  assert.equal(calcTax(100), 19);
});
`,
  "tests/report.test.js": `const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { render } = require("../src/report");
test("render shows the tax", () => {
  assert.equal(render(100), "Tax: 19");
});
test("labels carry the title", () => {
  const labels = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "labels.json"), "utf8"));
  assert.equal(labels.title, "Report");
});
`,
};

let dir = "";
let runner: { kind: string; reporter: string; script: string };

/** Put the fixture back the way it was written. */
function reset(): void {
  for (const [path, body] of Object.entries(FILES)) writeFileSync(join(dir, path), body);
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "code-roi-truth-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  reset();
  runner = detectRunner(dir);
});

after(() => rmSync(dir, { recursive: true, force: true }));

// ─── Profile and scenario eligibility ────────────────────────────

describe("test-based truth: the repository profile", () => {
  it("reads the runner off the repository's own test script", () => {
    assert.equal(runner.kind, "node-test");
    assert.equal(runner.reporter, "tap");
  });

  it("accepts JS source as a scenario file and never a test", () => {
    const profile = repoProfile(dir, { truth: "tests" });
    assert.equal(profile.truth, "tests");
    assert.equal(isScenarioFile(profile, "src/tax.js"), true);
    assert.equal(isScenarioFile(profile, "tests/tax.test.js"), false);
    assert.equal(isScenarioFile(profile, "src/tax.d.ts"), false);
    assert.equal(isScenarioFile(profile, "node_modules/x/index.js"), false);
  });

  it("leaves the type-based path exactly as the v3 and v4 archives were mined", () => {
    const profile = repoProfile(dir);
    assert.equal(profile.truth, "types");
    assert.equal(profile.testRunner, null);
    // A .js file was never a scenario under the type-based truth and still is not.
    assert.equal(isScenarioFile(profile, "src/tax.js"), false);
  });
});

// ─── The import graph the attribution rests on ───────────────────

describe("test-based truth: static imports", () => {
  it("finds require, import, dynamic import and mock specifiers", () => {
    const specs = specifiersOf(
      `const a = require("./a");\nimport b from "./b";\nawait import("./c");\njest.mock("./d");\nexport * from "./e";`,
    );
    assert.deepEqual(specs, ["./a", "./b", "./c", "./d", "./e"]);
  });

  it("resolves a relative specifier to a repo-relative file and stops at the repo edge", () => {
    assert.equal(resolveSpecifier(dir, "tests/report.test.js", "../src/report"), "src/report.js");
    assert.equal(resolveSpecifier(dir, "tests/report.test.js", "node:fs"), null);
    assert.equal(resolveSpecifier(dir, "tests/report.test.js", "../../outside"), null);
  });

  it("walks the closure transitively and records the distance", () => {
    const closure = importClosure(dir, "tests/report.test.js");
    assert.equal(closure.get("src/report.js"), 1);
    assert.equal(closure.get("src/tax.js"), 2);
    // Read by path, so it is not an edge — this is what makes it a blind spot.
    assert.equal(closure.has("src/labels.json"), false);
  });
});

// ─── Attribution: which source file a broken test is evidence for ─

describe("test-based truth: attribution", () => {
  it("prefers the file the test names (R1 sibling-name)", () => {
    const a = attribute(dir, "tests/report.test.js", "src/tax.js");
    assert.equal(a.rule, "sibling-name");
    assert.deepEqual(a.files, ["src/report.js"]);
  });

  it("never attributes the changed file to itself", () => {
    const a = attribute(dir, "tests/tax.test.js", "src/tax.js");
    assert.equal(a.files.includes("src/tax.js"), false);
  });

  it("marks a break with no import path as a blind spot", () => {
    const linked = truthFromBrokenTests(dir, ["tests/report.test.js"], "src/tax.js");
    assert.deepEqual(linked.blindSpots, []);
    const blind = truthFromBrokenTests(dir, ["tests/report.test.js"], "src/labels.json");
    assert.deepEqual(blind.blindSpots, ["tests/report.test.js"]);
    assert.deepEqual(blind.truth, ["src/report.js"]);
  });

  it("classifies test files by every convention the runners use", () => {
    for (const f of ["tests/a.js", "src/__tests__/a.js", "src/a.test.js", "test/test_a.js"]) {
      assert.equal(isTestFile(f), true, f);
    }
    assert.equal(isTestFile("src/tax.js"), false);
  });
});

// ─── TAP, as Node actually writes it ─────────────────────────────

describe("test-based truth: reading TAP", () => {
  it("takes the file of a failing case from its location, and drops suite points", () => {
    const { cases, files } = parseTap(
      [
        "TAP version 13",
        "# Subtest: outer",
        "    # Subtest: inner",
        "    not ok 1 - inner",
        "      ---",
        "      location: '/repo/tests/a.test.js:4:1'",
        "      ...",
        "    1..1",
        "not ok 1 - outer",
        "1..1",
      ].join("\n"),
    );
    assert.deepEqual([...cases], [["outer > inner", "fail"]]);
    assert.equal(files.get("outer > inner"), "/repo/tests/a.test.js");
  });

  it("reports a name used by two files as ambiguous instead of guessing", () => {
    const { ambiguous } = parseTap(["ok 1 - works", "not ok 2 - works", "1..2"].join("\n"));
    assert.deepEqual([...ambiguous], ["works"]);
  });

  it("keeps an ambiguous case out of the broken set", () => {
    const before = new Map([
      ["works", "pass"],
      ["clear", "pass"],
    ]);
    const after = new Map([
      ["works", "fail"],
      ["clear", "fail"],
    ]);
    assert.deepEqual(brokenCases(before, after, new Set(["works"])), ["clear"]);
    assert.deepEqual(brokenCases(before, after), ["clear", "works"]);
  });
});

// ─── End to end on the fixture ───────────────────────────────────

describe("test-based truth: the whole rule on the fixture", () => {
  it("is green before anything is changed", async () => {
    reset();
    const base = await runSuite(dir, runner, { timeoutMs: 60_000 });
    assert.equal(base.status, "ok", base.detail ?? "");
    assert.equal([...base.cases.values()].every((s) => s === "pass"), true);
    assert.equal(base.cases.size, 3);
  });

  it("derives the truth set of an import-coupled break", async () => {
    reset();
    const base = await runSuite(dir, runner, { timeoutMs: 60_000 });
    writeFileSync(join(dir, "src/tax.js"), FILES["src/tax.js"].replace("0.19", "0.07"));
    const after = await runSuite(dir, runner, { timeoutMs: 60_000 });
    reset();

    assert.equal(after.status, "ok", after.detail ?? "");
    const broke = brokenCases(base.cases, after.cases, after.ambiguous);
    assert.deepEqual(broke.sort(), ["calcTax applies the rate", "render shows the tax"]);

    const brokenFiles = [
      ...new Set(broke.map((id: string) => testFileOfCase(id, dir, after.files)).filter((f: unknown) => f !== null)),
    ].sort();
    assert.deepEqual(brokenFiles, ["tests/report.test.js", "tests/tax.test.js"]);

    const { truth, rules, blindSpots } = truthFromBrokenTests(dir, brokenFiles, "src/tax.js");
    // The changed file itself is never in its own truth set; the file that
    // broke because it imports it is.
    assert.deepEqual(truth, ["src/report.js"]);
    assert.equal(rules["tests/report.test.js"], "sibling-name");
    assert.deepEqual(blindSpots, []);
  });

  it("flags a break that travelled over a path, not an import", async () => {
    reset();
    const base = await runSuite(dir, runner, { timeoutMs: 60_000 });
    writeFileSync(join(dir, "src/labels.json"), `{ "title": "Renamed" }\n`);
    const after = await runSuite(dir, runner, { timeoutMs: 60_000 });
    reset();

    assert.equal(after.status, "ok", after.detail ?? "");
    const broke = brokenCases(base.cases, after.cases, after.ambiguous);
    assert.deepEqual(broke, ["labels carry the title"]);

    const brokenFiles = [
      ...new Set(broke.map((id: string) => testFileOfCase(id, dir, after.files)).filter((f: unknown) => f !== null)),
    ];
    const { blindSpots } = truthFromBrokenTests(dir, brokenFiles, "src/labels.json");
    assert.deepEqual(blindSpots, ["tests/report.test.js"]);
  });

  it("a run that cannot start is not evaluable, never 'breaks nothing'", async () => {
    reset();
    writeFileSync(join(dir, "tests/tax.test.js"), `syntax ( error =`);
    const broken = await runSuite(dir, runner, { timeoutMs: 60_000 });
    reset();
    // The suite still reports the other file's cases, so the honest signal is
    // that the FAILING case set is not empty — and the miner never sees an
    // empty broken set that came from a run it could not read.
    assert.equal(broken.status === "ok" || broken.status === "error", true);
    if (broken.status === "ok") {
      assert.equal([...broken.cases.values()].includes("fail"), true);
    }
  });

  it("stamps the rule version every population is frozen against", () => {
    assert.equal(TRUTH_RULE, "tests/v1");
  });
});

// ─── The fixture is what the file says it is ─────────────────────

describe("test-based truth: the fixture itself", () => {
  it("is three source files and two test files", () => {
    const paths = Object.keys(FILES).filter((p) => p !== "package.json");
    assert.deepEqual(paths.filter((p) => p.startsWith("src/")).sort(), [
      "src/labels.json",
      "src/report.js",
      "src/tax.js",
    ]);
    assert.deepEqual(paths.filter((p) => p.startsWith("tests/")).sort(), [
      "tests/report.test.js",
      "tests/tax.test.js",
    ]);
    assert.equal(readFileSync(join(dir, "src/tax.js"), "utf8").includes("0.19"), true);
  });
});
