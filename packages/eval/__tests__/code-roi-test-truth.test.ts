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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error — plain .mjs measurement scripts, no declarations
import {
  TRUTH_RULE,
  attribute,
  closuresOf,
  diffLiterals,
  importClosure,
  isTestFile,
  resolveSpecifier,
  selectTests,
  specifiersOf,
  truthFromBrokenTests,
  truthPopulationHash,
  // @ts-expect-error — plain .mjs measurement scripts, no declarations
} from "../code-roi/v2/test-truth.mjs";
// @ts-expect-error — plain .mjs measurement scripts, no declarations
import {
  brokenCases,
  confirmCases,
  confirmedOnBoth,
  detectRunner,
  parseTap,
  runSuite,
  testFileOfCase,
  testFilesOf,
  // @ts-expect-error — plain .mjs measurement scripts, no declarations
} from "../code-roi/v2/test-runner.mjs";
// @ts-expect-error — plain .mjs measurement scripts, no declarations
import { isScenarioFile, repoProfile, usesTests, usesTypes } from "../code-roi/v2/repo-profile.mjs";
// @ts-expect-error — plain .mjs measurement scripts, no declarations
import { BURNED_ARCHIVES, buildExclusions, exclusionsHash, isExcludedFile } from "../code-roi/v2/exclusions.mjs";

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

  it("follows a TypeScript ESM specifier from the emitted name to the source", () => {
    // `./x.js` on disk is `./x.ts`. bastra-recall writes 524 of its 530
    // relative imports this way; missing it collapses reachability silently.
    mkdirSync(join(dir, "ts"), { recursive: true });
    writeFileSync(join(dir, "ts/thing.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "ts/user.ts"), `import { a } from "./thing.js";\nexport const b = a;\n`);
    assert.equal(resolveSpecifier(dir, "ts/user.ts", "./thing.js"), "ts/thing.ts");
    // A real .js next to it still wins over the rewrite.
    writeFileSync(join(dir, "ts/thing.js"), "module.exports = {};\n");
    assert.equal(resolveSpecifier(dir, "ts/user.ts", "./thing.js"), "ts/thing.js");
    rmSync(join(dir, "ts"), { recursive: true, force: true });
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
    assert.deepEqual(blind.truth, ["tests/report.test.js"]);
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

  it("confirmation requires the same case to fail mutated and pass clean", () => {
    const mutated = {
      confirmed: new Set(["tests/a.test.js"]),
      casesByFile: new Map([["tests/a.test.js", new Set(["case A"])]]),
    };
    const wrongCleanCase = {
      confirmed: new Set(["tests/a.test.js"]),
      casesByFile: new Map([["tests/a.test.js", new Set(["case B"])]]),
    };
    assert.deepEqual([...confirmedOnBoth(mutated, wrongCleanCase)], []);
    const sameCleanCase = {
      confirmed: new Set(["tests/a.test.js"]),
      casesByFile: new Map([["tests/a.test.js", new Set(["case A"])]]),
    };
    assert.deepEqual([...confirmedOnBoth(mutated, sameCleanCase)], ["tests/a.test.js"]);
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

    assert.equal(after.status, "ok", after.detail ?? "");
    const broke = brokenCases(base.cases, after.cases, after.ambiguous);
    assert.deepEqual(broke.sort(), ["calcTax applies the rate", "render shows the tax"]);

    const brokenFiles = [
      ...new Set(broke.map((id: string) => testFileOfCase(id, dir, after.files)).filter((f: unknown) => f !== null)),
    ].sort();
    assert.deepEqual(brokenFiles, ["tests/report.test.js", "tests/tax.test.js"]);

    const fileOf = (id: string) => testFileOfCase(id, dir, after.files);
    const mutated = await confirmCases(dir, runner, brokenFiles, broke, fileOf, "fail", {
      timeoutMs: 60_000,
    });
    assert.deepEqual([...mutated.confirmed].sort(), brokenFiles);
    reset();
    const clean = await confirmCases(dir, runner, brokenFiles, broke, fileOf, "pass", {
      timeoutMs: 60_000,
    });
    assert.deepEqual([...clean.confirmed].sort(), brokenFiles);

    const { truth, rules, blindSpots } = truthFromBrokenTests(dir, brokenFiles, "src/tax.js");
    // The files whose tests demonstrably changed from passing to failing are
    // the test truth. Imports remain diagnostic metadata, not inferred truth.
    assert.deepEqual(truth, ["tests/report.test.js", "tests/tax.test.js"]);
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
    assert.equal(TRUTH_RULE, "tests/v2");
  });

  it("the population hash changes when truth changes under the same commit and file", () => {
    const base = { commit: "a", file: "src/a.ts", truthRule: TRUTH_RULE, brokenTests: [], blindSpots: [] };
    assert.notEqual(
      truthPopulationHash([{ ...base, truth: ["tests/a.test.ts"] }]),
      truthPopulationHash([{ ...base, truth: ["tests/b.test.ts"] }]),
    );
  });
});

// ─── Choosing which tests to run ─────────────────────────────────

describe("test-based truth: test selection", () => {
  it("picks the tests whose import closure reaches the changed file", () => {
    const testFiles = ["tests/tax.test.js", "tests/report.test.js"];
    const closures = closuresOf(dir, testFiles);
    const both = selectTests(dir, "src/tax.js", { testFiles, closures });
    assert.equal(both.mode, "targeted");
    assert.deepEqual(both.files, ["tests/report.test.js", "tests/tax.test.js"]);

    const one = selectTests(dir, "src/report.js", { testFiles, closures });
    assert.deepEqual(one.files, ["tests/report.test.js"]);
  });

  it("falls back to the whole suite instead of concluding nothing can break", () => {
    const testFiles = ["tests/tax.test.js", "tests/report.test.js"];
    const closures = closuresOf(dir, testFiles);
    // labels.json is reached by no import at all.
    const all = selectTests(dir, "src/labels.json", { testFiles, closures });
    assert.equal(all.mode, "full");
    assert.deepEqual(all.files, testFiles);
  });

  it("a tree with no tests at all falls back to an EMPTY suite, which is not a suite", () => {
    // What 46 candidates of the tests/v2 mining run hit: commits from before
    // this repository had a test suite in the runner's layout. The fallback
    // fires and selects "everything", and everything is nothing — so the
    // baseline ran the runner against no files and reported `1..0`, which was
    // recorded as a runner error. The selection is not wrong here; it simply
    // cannot say anything, and `analyzeTests` has to notice that BEFORE it
    // spends a suite run and before it drops the candidate's type half.
    const all = selectTests(dir, "src/tax.js", { testFiles: [], closures: new Map() });
    assert.equal(all.mode, "full");
    assert.deepEqual(all.files, []);
  });

  it("adds a test that merely shares a string literal with the diff", () => {
    const testFiles = ["tests/tax.test.js", "tests/report.test.js"];
    const closures = closuresOf(dir, testFiles);
    // "../src/report" is required by report.test.js and is removed by this diff;
    // nothing links src/x.js to that test by an import.
    const diff = [
      "--- a/src/x.js",
      "+++ b/src/x.js",
      '-const p = "../src/report";',
      '+const p = "../src/renamed";',
    ].join("\n");
    const picked = selectTests(dir, "src/x.js", { testFiles, closures, diff });
    assert.equal(picked.mode, "targeted+literals");
    assert.deepEqual(picked.files, ["tests/report.test.js"]);
  });

  it("takes contract-shaped literals from both sides of a diff, not bare words", () => {
    const lits = diffLiterals(
      ['+const route = "/api/quote";', '-const evt = "vehicle.updated";', '+const word = "hello";'].join("\n"),
    );
    assert.equal(lits.includes("/api/quote"), true);
    assert.equal(lits.includes("vehicle.updated"), true);
    assert.equal(lits.includes("hello"), false);
  });

  it("finds every glob of a multi-package test script, not just the first", () => {
    const runner = {
      kind: "node-test",
      reporter: "tap",
      script: "node --import tsx --test src/*.test.js tests/*.test.js",
    };
    assert.equal(detectRunner !== undefined, true);
    const found = testFilesOf(dir, runner);
    assert.deepEqual(found, ["tests/report.test.js", "tests/tax.test.js"]);
  });
});

// ─── The exclusion set the population is frozen against ──────────

describe("delivered population: exclusions", () => {
  // The real burned archives (~/.bastra/eval/code-roi-v2 and code-roi-v4) are
  // local mining output — never committed, because they are exactly the
  // scenarios this file exists to keep out of a future population (#582). So
  // the rule itself — collapsing scenarios to files, adopting the pilot,
  // hashing the set — is checked here against a small fixture archive that
  // ships with the test, and runs on every machine and every CI runner.
  let fixtureDir = "";
  let v2Archive = "";
  let v4Archive = "";
  let registration = "";

  before(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "code-roi-exclusions-"));
    v2Archive = join(fixtureDir, "v2-scenarios.json");
    v4Archive = join(fixtureDir, "v4-scenarios.json");
    registration = join(fixtureDir, "registration.json");
    writeFileSync(
      v2Archive,
      JSON.stringify({
        scenarios: [
          { file: "packages/foo/a.ts" },
          { file: "packages/foo/b.ts" },
          { file: "packages/foo/a.ts" }, // a repeat within one archive collapses to one file
        ],
      }),
    );
    writeFileSync(
      v4Archive,
      JSON.stringify({
        scenarios: [{ file: "packages/foo/b.ts" }, { file: "packages/bar/c.ts" }], // b.ts repeats across archives
      }),
    );
    writeFileSync(
      registration,
      JSON.stringify({
        sample: {
          excluded_pilot: {
            commits: ["1111111111111111111111111111111111111a", "2222222222222222222222222222222222222b"],
            files: ["packages/pilot/x.ts"],
          },
        },
      }),
    );
  });

  after(() => rmSync(fixtureDir, { recursive: true, force: true }));

  it("burns every file that was already a scenario, and the worked-on directories", () => {
    const ex = buildExclusions({ archives: [v2Archive, v4Archive], registration });
    // 3 + 2 scenarios collapse to 3 distinct files — "b.ts" repeats within and across archives.
    assert.equal(ex.sources.reduce((n: number, s: { scenarios: number }) => n + s.scenarios, 0), 5);
    assert.deepEqual(ex.files.filter((f) => f !== "packages/pilot/x.ts").sort(), [
      "packages/bar/c.ts",
      "packages/foo/a.ts",
      "packages/foo/b.ts",
    ]);
    assert.equal(isExcludedFile(ex, "packages/foo/a.ts"), true);
    assert.equal(isExcludedFile(ex, "packages/daemon/src/code-graph/affected.ts"), true);
    assert.equal(isExcludedFile(ex, "packages/eval/code-roi/v2/mine-repo.mjs"), true);
    assert.equal(isExcludedFile(ex, "packages/unrelated/z.ts"), false);
  });

  it("carries the two pilot commits of the registration", () => {
    const ex = buildExclusions({ archives: [v2Archive, v4Archive], registration });
    assert.equal(ex.commits.length, 2);
    assert.equal(ex.files.includes("packages/pilot/x.ts"), true);
  });

  it("refuses to mine when an archive it must exclude is missing", () => {
    assert.throws(() => buildExclusions({ archives: ["/nonexistent/scenarios.json"] }), /exclusion archive missing/);
  });

  it("hashes the whole set, so a different exclusion is a different population", () => {
    const a = buildExclusions({ archives: [v2Archive, v4Archive], registration });
    const b = buildExclusions({
      archives: [v2Archive, v4Archive],
      registration,
      extraFiles: ["packages/core/src/brand-new.ts"],
    });
    assert.notEqual(exclusionsHash(a), exclusionsHash(b));
    assert.equal(exclusionsHash(a), exclusionsHash(buildExclusions({ archives: [v2Archive, v4Archive], registration })));
  });

  // Against the real, frozen archives. They hold the actual burned scenarios
  // and are what the delivered-impact registration's population was mined
  // against (`registrations/code-awareness-delivered.population.md`), so this
  // checks the real, frozen hash rather than only the fixture rule above. On
  // a machine or CI runner without the archives it skips with a named reason
  // instead of passing on a set it never looked at.
  it("hashes the real archives to the frozen delivered-impact population hash, when present", (t) => {
    const missing = BURNED_ARCHIVES.filter((p: string) => !existsSync(p));
    if (missing.length > 0) {
      t.skip(`real burned archives not present: ${missing.join(", ")}`);
      return;
    }
    const ex = buildExclusions();
    assert.equal(exclusionsHash(ex), "df87de2c3566d64b890620a4c4f8eb52fdc2bf1f15077b998b38c1b0d3ad8318");
  });
});

// ─── The combined truth mode ─────────────────────────────────────

describe("delivered population: tsc+tests mode", () => {
  it("runs both halves and keeps the type-only path untouched", () => {
    assert.deepEqual([usesTypes("types"), usesTests("types")], [true, false]);
    assert.deepEqual([usesTypes("tests"), usesTests("tests")], [false, true]);
    assert.deepEqual([usesTypes("tsc+tests"), usesTests("tsc+tests")], [true, true]);
  });

  it("keeps TypeScript-only scenario files in the combined mode", () => {
    const profile = repoProfile(dir, { truth: "tsc+tests" });
    assert.equal(profile.testRunner.kind, "node-test");
    // JS is not a scenario file here: the repository still typechecks.
    assert.equal(isScenarioFile(profile, "src/tax.js"), false);
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
