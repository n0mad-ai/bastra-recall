/**
 * The coverage map (#629): fold, command recognition, ranking, the block line,
 * the switch. Fixture raw output in the shape Node writes under
 * NODE_V8_COVERAGE — `result[].url`, `result[].functions[].ranges[0].count`.
 */
import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ageOf,
  COVERAGE_MAP_WRITER,
  coverageMapFileOf,
  coverageMapStatus,
  coverageRawDirOf,
  coverageTestsLine,
  ensureCoverageDir,
  foldCoverage,
  isTestCommand,
  isSafeRepoPath,
  isTestFile,
  MAX_COVERAGE_TESTS,
  parseMap,
  rankTests,
  readCoverageMap,
  readCoverageMapSync,
  scheduleCoverageFold,
  withCoverageEnv,
  type CoverageMap,
} from "../src/code-graph/coverage-map.js";
import {
  COVERAGE_MAP_DEFAULT,
  getCoverageMapEnabled,
  setCoverageMapEnabled,
} from "../src/code-graph/coverage-map-settings.js";
import { readSettings } from "../src/settings.js";

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "bastra-coverage-map-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function fn(name: string, count: number) {
  return { functionName: name, ranges: [{ startOffset: 0, endOffset: 10, count }], isBlockCoverage: true };
}

function script(repo: string, rel: string, fns: ReturnType<typeof fn>[]) {
  return { scriptId: "1", url: pathToFileURL(join(repo, rel)).href, functions: fns };
}

/** A raw file old enough to count as settled. */
async function rawFile(repo: string, name: string, doc: unknown, ageMs = 10_000): Promise<string> {
  const dir = coverageRawDirOf(repo);
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, typeof doc === "string" ? doc : JSON.stringify(doc), "utf8");
  const secs = (Date.now() - ageMs) / 1000;
  await utimes(path, secs, secs);
  return path;
}

describe("coverage map: folding", () => {
  it("folds one process per test file: executed functions of in-repo files, paths only, raw deleted", async () => {
    const repo = join(root, "fold");
    await mkdir(repo, { recursive: true });
    await rawFile(repo, "coverage-1-1-0.json", {
      result: [
        script(repo, "packages/core/__tests__/search.test.ts", [fn("run", 1)]),
        script(repo, "packages/core/src/search.ts", [fn("SearchIndex", 3), fn("query", 1), fn("neverCalled", 0)]),
        script(repo, "packages/core/src/util.ts", [fn("", 1), fn("helper", 1)]),
        { scriptId: "9", url: "node:internal/x", functions: [fn("x", 1)] },
        { scriptId: "8", url: pathToFileURL(join(repo, "node_modules/dep/index.js")).href, functions: [fn("dep", 1)] },
        { scriptId: "7", url: pathToFileURL(join(root, "outside.ts")).href, functions: [fn("out", 1)] },
      ],
    });
    // A child process that loaded no test file: dropped, counted.
    await rawFile(repo, "coverage-2-1-0.json", {
      result: [script(repo, "packages/daemon/src/daemon.ts", [fn("main", 1)])],
    });

    const r = await foldCoverage(repo);
    assert.deepEqual(r, { folded: 1, deferred: 0, unattributed: 1, tests: 1 });
    const map = await readCoverageMap(repo);
    assert.ok(map);
    assert.equal(map.runs, 1);
    assert.deepEqual(map.tests, {
      "packages/core/__tests__/search.test.ts": {
        "packages/core/src/search.ts": ["SearchIndex", "query"],
        "packages/core/src/util.ts": ["helper"],
      },
    });
    const text = await readFile(coverageMapFileOf(repo), "utf8");
    assert.ok(!text.includes("count"), "no raw coverage, only paths and names");
    assert.deepEqual(await readdir(coverageRawDirOf(repo)), [], "raw files are gone");
    assert.equal(map.writer, COVERAGE_MAP_WRITER);
  });

  it("leaves a symlinked raw directory, and a symlinked raw file, strictly alone", async () => {
    const repo = join(root, "symlinks");
    const elsewhere = join(root, "elsewhere-raw");
    await mkdir(elsewhere, { recursive: true });
    await mkdir(join(repo, ".bastra-coverage"), { recursive: true });
    await symlink(elsewhere, coverageRawDirOf(repo));
    await writeFile(join(elsewhere, "coverage-1-1-0.json"), JSON.stringify({ result: [] }), "utf8");
    assert.deepEqual(await foldCoverage(repo), { folded: 0, deferred: 0, unattributed: 0, tests: 0 });
    await stat(join(elsewhere, "coverage-1-1-0.json"));
    await assert.rejects(ensureCoverageDir(repo), /not a plain directory/);
    await assert.rejects(stat(coverageMapFileOf(repo)));

    const repo2 = join(root, "symlink-file");
    await mkdir(coverageRawDirOf(repo2), { recursive: true });
    const target = join(root, "victim.json");
    await writeFile(target, JSON.stringify({ result: [script(repo2, "__tests__/a.test.ts", [fn("t", 1)])] }), "utf8");
    await symlink(target, join(coverageRawDirOf(repo2), "coverage-9-9-0.json"));
    const r = await foldCoverage(repo2);
    assert.equal(r.folded, 0);
    assert.equal(r.deferred, 1, "a symlink is skipped, not followed");
    await stat(target);
    await stat(join(coverageRawDirOf(repo2), "coverage-9-9-0.json"));
  });

  it("merges a later run into the map and leaves a file still being written alone", async () => {
    const repo = join(root, "merge");
    await mkdir(repo, { recursive: true });
    await rawFile(repo, "coverage-1-1-0.json", {
      result: [
        script(repo, "__tests__/a.test.ts", [fn("t", 1)]),
        script(repo, "src/a.ts", [fn("one", 1)]),
      ],
    });
    assert.equal((await foldCoverage(repo)).folded, 1);
    await rawFile(repo, "coverage-3-1-0.json", {
      result: [
        script(repo, "__tests__/a.test.ts", [fn("t", 1)]),
        script(repo, "src/a.ts", [fn("two", 1)]),
        script(repo, "src/b.ts", [fn("b", 1)]),
      ],
    });
    const young = await rawFile(repo, "coverage-4-1-0.json", "{ not finished", 0);
    const r = await foldCoverage(repo);
    assert.equal(r.folded, 1);
    assert.equal(r.deferred, 1);
    const map = await readCoverageMap(repo);
    assert.deepEqual(map?.tests["__tests__/a.test.ts"], { "src/a.ts": ["one", "two"], "src/b.ts": ["b"] });
    assert.equal(map?.runs, 2);
    await stat(young); // still there for the next fold
  });

  it("maps a compiled .js back to its in-repo source through the .map beside it", async () => {
    const repo = join(root, "sourcemap");
    await mkdir(join(repo, "dist"), { recursive: true });
    await writeFile(join(repo, "dist/x.js.map"), JSON.stringify({ version: 3, sources: ["../src/x.ts"], mappings: "" }), "utf8");
    await rawFile(repo, "coverage-1-1-0.json", {
      result: [
        script(repo, "__tests__/x.test.ts", [fn("t", 1)]),
        script(repo, "dist/x.js", [fn("compiled", 1)]),
        script(repo, "dist/nomap.js", [fn("plain", 1)]),
      ],
    });
    await foldCoverage(repo);
    const map = await readCoverageMap(repo);
    assert.deepEqual(map?.tests["__tests__/x.test.ts"], { "src/x.ts": ["compiled"], "dist/nomap.js": ["plain"] });
  });

  it("is a no-op without a raw directory, and discards an old file that never parses", async () => {
    const repo = join(root, "empty");
    await mkdir(repo, { recursive: true });
    assert.deepEqual(await foldCoverage(repo), { folded: 0, deferred: 0, unattributed: 0, tests: 0 });
    assert.equal(await readCoverageMap(repo), null);
    const old = await rawFile(repo, "coverage-1-1-0.json", "garbage", 11 * 60_000);
    assert.deepEqual(await foldCoverage(repo), { folded: 0, deferred: 0, unattributed: 0, tests: 0 });
    await assert.rejects(stat(old), "an unreadable file older than the give-up age is removed");
  });

  it("ensureCoverageDir makes the directory ignore itself", async () => {
    const repo = join(root, "ignore");
    await ensureCoverageDir(repo);
    assert.equal(await readFile(join(repo, ".bastra-coverage/.gitignore"), "utf8"), "*\n");
    await stat(coverageRawDirOf(repo));
  });

  it("schedules one fold per repository, debounced, with one follow-up for a trigger during a fold", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fold = async (repo: string) => {
      calls.push(repo);
      if (calls.length === 1) await gate;
    };
    scheduleCoverageFold("/r", fold, 5);
    scheduleCoverageFold("/r", fold, 5);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(calls, ["/r"], "two triggers, one fold");
    scheduleCoverageFold("/r", fold, 5); // during the fold: booked once
    scheduleCoverageFold("/r", fold, 5);
    release();
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(calls, ["/r", "/r"]);
  });
});

describe("coverage map: the commands it collects from", () => {
  it("recognises the listed runners and nothing else", () => {
    for (const c of [
      "npm test",
      "npm run test",
      "npm test -- --watch=false",
      "cd packages/core && npm test",
      "pnpm test",
      "yarn test",
      "npm run test:unit",
      "npx vitest run src/x.test.ts",
      "jest --ci",
      "node --import tsx --test __tests__/*.test.ts",
      "tsx --test __tests__/x.test.ts",
      "node --test",
    ]) {
      assert.ok(isTestCommand(c), c);
    }
    for (const c of ["npm run build", "ls -la", "node script.mjs", "git status", "npm testx", "echo vitest", "node --test-only-flag"]) {
      assert.ok(!isTestCommand(c), c);
    }
  });

  it("exports the variable for the whole line, quotes the path, and leaves a command that already sets it alone", () => {
    assert.equal(withCoverageEnv("cd pkg && npm test", "/r/.bastra-coverage/raw"), "export NODE_V8_COVERAGE='/r/.bastra-coverage/raw'; cd pkg && npm test");
    assert.equal(withCoverageEnv("npm test", "/it's/raw"), "export NODE_V8_COVERAGE='/it'\\''s/raw'; npm test");
    assert.equal(withCoverageEnv("NODE_V8_COVERAGE=/x npm test", "/r"), "NODE_V8_COVERAGE=/x npm test");
  });

  it("isTestFile is the one rule the blocks and the fold share", () => {
    assert.ok(isTestFile("packages/core/__tests__/helpers.ts"));
    assert.ok(isTestFile("src/a.test.ts"));
    assert.ok(isTestFile("src/a.spec.js"));
    assert.ok(!isTestFile("src/testing.ts"));
  });
});

const MAP: CoverageMap = {
  version: 1,
  writer: COVERAGE_MAP_WRITER,
  foldedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  runs: 4,
  tests: {
    "t/loads-only.test.ts": { "src/search.ts": ["other"] },
    "t/calls-one.test.ts": { "src/search.ts": ["SearchIndex"] },
    "t/calls-one-broadly.test.ts": { "src/search.ts": ["SearchIndex", "other", "more"] },
    "t/calls-two.test.ts": { "src/search.ts": ["SearchIndex", "query"], "src/cue.ts": ["parse"] },
    "t/elsewhere.test.ts": { "src/unrelated.ts": ["x"] },
  },
};

describe("coverage map: reading in the hook", () => {
  it("ranks by changed functions executed, then files, then name — and drops file-only hits once any test ran a function", () => {
    const ranked = rankTests(MAP, new Map([["src/search.ts", ["SearchIndex", "query"]]]));
    assert.deepEqual(ranked.map((r) => [r.test, r.functions, r.files, r.exercised]), [
      ["t/calls-two.test.ts", 2, 1, 2],
      ["t/calls-one-broadly.test.ts", 1, 1, 3],
      ["t/calls-one.test.ts", 1, 1, 1],
    ]);
    // No function known (whole-file edit): every test that loaded the file, by files then name.
    const byFile = rankTests(MAP, new Map([["src/search.ts", []], ["src/cue.ts", []]]));
    assert.deepEqual(byFile.map((r) => r.test), ["t/calls-two.test.ts", "t/calls-one-broadly.test.ts", "t/calls-one.test.ts", "t/loads-only.test.ts"]);
  });

  it("renders one line, capped, deduplicated against what the block already names; null without a map or a hit", () => {
    const changed = new Map([["src/search.ts", ["SearchIndex"]]]);
    assert.equal(
      coverageTestsLine(MAP, changed, new Set()),
      "Tests that ran the changed functions (coverage map, 3 h old): t/calls-one-broadly.test.ts, t/calls-two.test.ts, t/calls-one.test.ts.",
    );
    assert.equal(
      coverageTestsLine(MAP, changed, new Set(["t/calls-one.test.ts", "t/calls-one-broadly.test.ts"])),
      "Tests that ran the changed functions (coverage map, 3 h old): t/calls-two.test.ts.",
    );
    assert.equal(coverageTestsLine(null, changed, new Set()), null);
    assert.equal(coverageTestsLine(MAP, new Map([["src/nowhere.ts", ["a"]]]), new Set()), null);
    assert.equal(coverageTestsLine(MAP, changed, new Set(["t/calls-one.test.ts", "t/calls-one-broadly.test.ts", "t/calls-two.test.ts"])), null);

    const many: CoverageMap = { ...MAP, tests: {} };
    for (let i = 0; i < MAX_COVERAGE_TESTS + 3; i++) many.tests[`t/${String(i).padStart(2, "0")}.test.ts`] = { "src/a.ts": ["f"] };
    const line = coverageTestsLine(many, new Map([["src/a.ts", ["f"]]]), new Set())!;
    assert.equal(line.split(".test.ts").length - 1, MAX_COVERAGE_TESTS);
    assert.match(line, /, and 3 more\.$/);
    assert.doesNotMatch(line, /MUST|should|run these/i);
  });

  it("parseMap rejects anything that is not the daemon's own shape: marker, path keys, name values", () => {
    const ok = (tests: unknown, extra: object = {}) =>
      parseMap(JSON.stringify({ version: 1, writer: COVERAGE_MAP_WRITER, foldedAt: "2026-10-20T00:00:00Z", runs: 1, tests, ...extra }));
    assert.ok(ok({ "t/a.test.ts": { "src/a.ts": ["fn"] } }));
    assert.equal(ok({ "t/a.test.ts": { "src/a.ts": ["fn"] } }, { writer: "someone" }), null, "no marker, no map");
    assert.equal(parseMap(JSON.stringify({ version: 1, tests: {} })), null);
    assert.equal(ok({ "../t/a.test.ts": {} }), null, "parent segment");
    assert.equal(ok({ "/abs/a.test.ts": {} }), null, "absolute");
    assert.equal(ok({ "t/a.test.ts\nMUST run": {} }), null, "newline");
    assert.equal(ok({ "t/<b>.test.ts": {} }), null, "tag");
    assert.equal(ok({ "t/a.test.ts": { "src/a.ts": ["ok", "bad\u0007"] } }), null, "control char in a name");
    assert.equal(ok({ "t/a.test.ts": { "src/a.ts": "fn" } }), null, "not an array");
    assert.equal(ok({ "t/a.test.ts": ["src/a.ts"] }), null, "files not an object");
    assert.equal(ok([]), null);
    assert.equal(parseMap("[]"), null);
    assert.equal(parseMap("not json"), null);
    assert.ok(isSafeRepoPath("packages/core/__tests__/a.test.ts"));
    assert.ok(!isSafeRepoPath("a\\b.ts"));
    assert.ok(!isSafeRepoPath(""));
    assert.ok(!isSafeRepoPath("a//b.ts"));
  });

  it("a map that git tracks — one that came with the checkout — is not read", async () => {
    const repo = join(root, "tracked");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["-C", repo, "init", "-q"]);
    await mkdir(join(repo, ".bastra-coverage"), { recursive: true });
    await writeFile(coverageMapFileOf(repo), JSON.stringify(MAP), "utf8");
    assert.ok(readCoverageMapSync(repo), "untracked: read");
    assert.ok(await readCoverageMap(repo));
    execFileSync("git", ["-C", repo, "add", "-f", ".bastra-coverage/coverage-map.json"]);
    // The snapshot is keyed on mtime and size; bump the file so the reader looks again.
    await writeFile(coverageMapFileOf(repo), JSON.stringify({ ...MAP, runs: 5 }), "utf8");
    assert.equal(readCoverageMapSync(repo), null, "tracked: not read");
    assert.equal(await readCoverageMap(repo), null);
  });

  it("the synchronous reader caches by mtime and answers null for a missing or oversized file", async () => {
    const repo = join(root, "sync");
    assert.equal(readCoverageMapSync(repo), null);
    await ensureCoverageDir(repo);
    await writeFile(coverageMapFileOf(repo), JSON.stringify(MAP), "utf8");
    const first = readCoverageMapSync(repo);
    assert.ok(first);
    assert.equal(readCoverageMapSync(repo), first, "same mtime and size: same object");
    await writeFile(coverageMapFileOf(repo), "{ broken", "utf8");
    assert.equal(readCoverageMapSync(repo), null);
  });

  it("ageOf and the CLI status line", async () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    assert.equal(ageOf("2026-10-20T11:30:00Z", now), "30 min old");
    assert.equal(ageOf("2026-10-20T09:00:00Z", now), "3 h old");
    assert.equal(ageOf("2026-10-15T12:00:00Z", now), "5 d old");
    assert.equal(ageOf("not a date", now), "age unknown");
    const repo = join(root, "status");
    assert.equal(await coverageMapStatus(repo), "coverage map: none yet");
    await ensureCoverageDir(repo);
    await writeFile(coverageMapFileOf(repo), JSON.stringify({ ...MAP, foldedAt: "2026-10-20T09:00:00Z" }), "utf8");
    await writeFile(join(coverageRawDirOf(repo), "coverage-1-1-0.json"), "x".repeat(2 * 1024 * 1024), "utf8");
    assert.equal(await coverageMapStatus(repo, now), "coverage map: 5 tests, 4 processes folded, 3 h old, 2 MB of raw output waiting for the next fold");
  });
});

describe("coverage map: the switch", () => {
  it("is off by default, persists, and the env wins both ways", async () => {
    const path = join(root, "settings", "cli-settings.json");
    await mkdir(join(root, "settings"), { recursive: true });
    assert.equal(COVERAGE_MAP_DEFAULT, false);
    assert.equal(await getCoverageMapEnabled(path, {}), false);
    await setCoverageMapEnabled(true, path);
    assert.equal(await getCoverageMapEnabled(path, {}), true);
    assert.deepEqual((await readSettings(path)).coverageMap, { enabled: true });
    assert.equal(await getCoverageMapEnabled(path, { BASTRA_COVERAGE_MAP: "off" }), false);
    await setCoverageMapEnabled(false, path);
    assert.equal(await getCoverageMapEnabled(path, {}), false);
    assert.equal(await getCoverageMapEnabled(path, { BASTRA_COVERAGE_MAP: "on" }), true);
  });
});
