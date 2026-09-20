/**
 * Mine scenarios out of ANY repository, without touching it (#582, v5).
 *
 * `mine.mjs` mines bastra-recall and stays as it is: it is the tool the v3 and
 * v4 archives were produced with. It cannot be pointed at another repository,
 * for two reasons that are not configuration:
 *
 *   1. IT CREATES GIT WORKTREES. `git worktree add` writes into the source
 *      repository's `.git`. On a repository this measurement does not own,
 *      that is a change to someone else's checkout. So this miner reads with
 *      `git archive` and extracts into its own directory: the source
 *      repository is only ever read.
 *   2. IT KNOWS ONE LAYOUT. Scope `@bastra-recall`, packages under
 *      `packages/`, a tsconfig per package, and "build core first". All four
 *      are derived here instead (`repo-profile.mjs`).
 *
 * WHY ANOTHER REPOSITORY AT ALL. bastra-recall's own history is exhausted:
 * 369 commits before the v3 range end yield 694 candidates, 11 qualifying
 * changes, 7 after the freshness exclusions — and ZERO of them break across a
 * package boundary, which is the one thing #582 built. A measurement of
 * cross-package impact needs a repository that has cross-package impact.
 *
 * TWO TRUTH DEFINITIONS, chosen with `--truth`:
 *
 *   `types` (default, unchanged from registration 3) — a file is affected when
 *     it carries a type error after applying exactly one file's diff that it
 *     did not carry before, compared as (file, code, message) multisets. Needs
 *     a tsconfig, so it only exists in a TypeScript repository.
 *   `tests` — a file is affected when a test that used to pass now fails and
 *     that test reaches the file. The whole rule, including the confirmation
 *     run and the blind-spot flag, lives in `test-truth.mjs`; nothing about
 *     the type-based path changes.
 *
 * Usage:
 *   CODE_ROI_REPO=/path/to/repo CODE_ROI_OUT=<dir> node mine-repo.mjs [--stop-at 45]
 *   CODE_ROI_REPO=/path/to/js-repo CODE_ROI_OUT=<dir> node mine-repo.mjs --truth tests
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writableOut } from "./archive.mjs";
import { extractTree } from "./repo-tree.mjs";
import { isScenarioFile, repoProfile, usesTests, usesTypes } from "./repo-profile.mjs";
import { buildExclusions, exclusionsHash, isExcludedFile } from "./exclusions.mjs";
import { TRUTH_RULE, attribute, closuresOf, selectTests, truthPopulationHash } from "./test-truth.mjs";
import {
  DEFAULT_TIMEOUT_MS,
  brokenCases,
  confirmCases,
  confirmedOnBoth,
  runSuite,
  testFileOfCase,
  testFilesOf,
} from "./test-runner.mjs";

const run = promisify(execFile);
const BUF = { maxBuffer: 512 * 1024 * 1024, encoding: "utf8" };

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : null;
}

export const PROFILE_OF = repoProfile;
export const REPO = argOf("--repo") ?? process.env.CODE_ROI_REPO ?? process.cwd();
export const OUT = writableOut();
const TSC = new URL("../../../../node_modules/.bin/tsc", import.meta.url).pathname;
/**
 * Candidates are written PER REPOSITORY and merged, so mining a second
 * repository into the same archive adds to the pool instead of replacing it —
 * the pooling rule in the registration is only real if the file survives.
 */
const CANDIDATES = join(OUT, "candidates.jsonl");
const repoSlug = REPO.split("/").filter(Boolean).slice(-1)[0] ?? "repo";
const CANDIDATES_REPO = join(OUT, `candidates.${repoSlug}.jsonl`);
const CACHE = join(OUT, "truth-cache.jsonl");
const WORKERS = Number(process.env.CODE_ROI_WORKERS ?? 4);
const STOP_AT = Number(argOf("--stop-at") ?? 45);
const MAX_TRUTH = 40;

export const TRUTH = argOf("--truth") ?? process.env.CODE_ROI_TRUTH ?? "types";
if (!["types", "tests", "tsc+tests"].includes(TRUTH)) {
  throw new Error(`--truth must be "types", "tests" or "tsc+tests", not ${JSON.stringify(TRUTH)}`);
}
const profile = repoProfile(REPO, { truth: TRUTH });
mkdirSync(OUT, { recursive: true });

/**
 * What may not enter this population — burned scenario files, the pilot
 * commits, and the two directories being worked on. Built only for the truth
 * modes that carry it; the type-only path keeps mining exactly as before.
 */
const EXCLUSIONS =
  TRUTH === "tsc+tests"
    ? buildExclusions({
        extraFiles: (process.env.CODE_ROI_EXCLUDE_FILES ?? "").split(",").map((f) => f.trim()).filter(Boolean),
      })
    : { files: [], commits: [], prefixes: [], reasons: {}, sources: [] };

const PILOT_COMMITS = [
  ...EXCLUSIONS.commits,
  ...(process.env.CODE_ROI_PILOT_COMMITS ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean),
];

/** The repository state this population was mined from, pinned in population.json. */
const REPO_HEAD = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
})();

const git = async (args, cwd = REPO) => (await run("git", args, { cwd, ...BUF })).stdout;

/**
 * One commit's tree on disk. The plumbing lives in `repo-tree.mjs`; this
 * binds it to the repository and profile this run was started with.
 */
export const extract = (sha, dir) => extractTree(REPO, profile, sha, dir);

/**
 * Every type error as `file\tTScode\tmessage` -> count, over the profile's
 * tsconfigs. Positions are left out: a mutation shifts lines, and the same
 * error one line lower is not a new error.
 */
export async function errorSignatures(dir) {
  const sigs = new Map();
  for (const pkgDir of profile.buildFirst) {
    // Emits even with errors; the errors are collected from the pass below.
    await run(TSC, ["-p", join(dir, pkgDir, "tsconfig.json")], { cwd: dir, ...BUF }).catch(() => {});
  }
  for (const cfg of profile.tsconfigs) {
    const cfgDir = join(dir, cfg, "..");
    const prefix = cfg.slice(0, cfg.lastIndexOf("/") + 1);
    const out = await run(TSC, ["-p", join(dir, cfg), "--pretty", "false"], {
      cwd: cfgDir,
      ...BUF,
    }).then(
      (r) => r.stdout,
      (e) => `${e.stdout ?? ""}`,
    );
    for (const line of out.split("\n")) {
      const m = /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/.exec(line);
      if (m === null) continue;
      const file = normalizeReported(prefix, m[1]);
      sigs.set(`${file}\t${m[2]}\t${m[3]}`, (sigs.get(`${file}\t${m[2]}\t${m[3]}`) ?? 0) + 1);
    }
  }
  return sigs;
}

/**
 * A path tsc reported, as a repo-relative one. tsc prints paths relative to
 * the tsconfig's directory, so `../../packages/db/src/x.ts` from an app config
 * is the same file as `packages/db/src/x.ts` — and counting it twice under two
 * spellings would make every cross-package error look new.
 */
function normalizeReported(prefix, reported) {
  const joined = `${prefix}${reported.replace(/^\.\//, "")}`;
  const parts = [];
  for (const seg of joined.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

export function newErrorFiles(before, after) {
  const files = new Set();
  for (const [sig, n] of after) {
    if (n > (before.get(sig) ?? 0)) files.add(sig.split("\t")[0]);
  }
  return files;
}

/**
 * Restrict candidates to one path prefix. Used ONLY for the cross-package
 * mechanism gate (registration 6), which is a different question from the
 * main sample and therefore has its own, separately registered selection: a
 * change inside a workspace package, where the package boundary can be
 * crossed at all. The main run never passes this.
 */
const FILE_PREFIX = argOf("--file-prefix") ?? process.env.CODE_ROI_FILE_PREFIX ?? "";

async function candidatesOf(sha) {
  const out = await git(["diff-tree", "--no-commit-id", "--name-status", "-r", sha]);
  return out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter(
      ([status, path]) =>
        status === "M" &&
        isScenarioFile(profile, path ?? "") &&
        !isExcludedFile(EXCLUSIONS, path ?? "") &&
        (FILE_PREFIX === "" || (path ?? "").startsWith(FILE_PREFIX)),
    )
    .map(([, path]) => path)
    .sort();
}

/**
 * Baselines are keyed by the PARENT TREE, not by the commit: a suite run is the
 * expensive step here, and two commits with the same parent tree have the same
 * baseline by definition. The cache survives a restart, so a mining run that
 * was interrupted does not pay for its baselines twice.
 */
const TEST_BASELINE_CACHE = join(OUT, "test-baseline-cache.jsonl");
const TEST_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
const testBaselines = new Map();

function loadTestBaselines() {
  if (!existsSync(TEST_BASELINE_CACHE)) return;
  for (const line of readFileSync(TEST_BASELINE_CACHE, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    testBaselines.set(r.key, r);
  }
}

/**
 * The passing cases of the parent tree for ONE SELECTION of test files.
 *
 * The key is the tree plus the selection, not the tree alone: with targeted
 * runs two candidates of the same commit run different test files, and a
 * baseline taken over one selection says nothing about cases the other one
 * runs. Keyed this way, a repeated selection — which is common, since many
 * changes reach the same tests — is still paid for once.
 */
async function testBaseline(tree, dir, selected) {
  const key = `${tree}:${createHash("sha256").update(selected.join("\n")).digest("hex").slice(0, 16)}`;
  const hit = testBaselines.get(key);
  if (hit !== undefined) return hit;
  const run = await runSuite(dir, profile.testRunner, { files: selected, timeoutMs: TEST_TIMEOUT_MS });
  const record =
    run.status === "ok"
      ? { key, tree, tests: selected.length, status: "ok", passing: [...run.cases].filter(([, s]) => s === "pass").map(([id]) => id) }
      : { key, tree, tests: selected.length, status: run.status, detail: run.detail ?? "", passing: [] };
  testBaselines.set(key, record);
  appendFileSync(TEST_BASELINE_CACHE, JSON.stringify(record) + "\n");
  return record;
}

/**
 * One candidate decided on the TYPE half of the rule alone, on a tree that has
 * no tests to run. Same comparison the `types` truth mode makes: signatures
 * before, signatures after exactly this file's diff, the changed file never
 * counting towards its own truth.
 *
 * `truthSource` is `tsc` or `none`, never `tests`, and `testSelection.mode` is
 * `no_tests` so the population can be counted without guessing why a scenario
 * carries no broken test.
 */
async function typeOnlyCandidate(record, file, diff, dir, parent, typeBaseline) {
  const patch = join(dir, ".eval-mutation.diff");
  writeFileSync(patch, diff);
  const applied = await run("git", ["apply", patch], { cwd: dir, ...BUF }).then(
    () => true,
    () => false,
  );
  if (!applied) {
    rmSync(patch, { force: true });
    return { ...record, file, reason: "diff does not apply alone" };
  }
  const afterTypes = usesTypes(TRUTH) ? await errorSignatures(dir) : null;
  const reverted = await run("git", ["apply", "-R", patch], { cwd: dir, ...BUF }).then(
    () => true,
    () => false,
  );
  rmSync(patch, { force: true });
  if (!reverted) await extract(parent, dir);
  const truth = afterTypes === null ? [] : [...newErrorFiles(typeBaseline, afterTypes)].filter((f) => f !== file);
  return {
    ...record,
    file,
    diff,
    truth: [...truth].sort(),
    truthFromTypes: [...truth].sort(),
    truthFromTests: [],
    truthSource: truth.length > 0 ? "tsc" : "none",
    brokenTests: [],
    truthRules: {},
    blindSpots: [],
    testSelection: { mode: "no_tests", files: 0, reached: 0 },
    baselinePassing: 0,
  };
}

/**
 * Test-based truth for every candidate file of one commit — the rule written
 * out in `test-truth.mjs`. The order of the steps is load-bearing:
 *
 *   apply diff -> run suite -> confirm on the MUTATED tree ->
 *   ATTRIBUTE ON THE MUTATED TREE -> revert -> confirm on the CLEAN tree ->
 *   keep only cases that fail mutated and pass clean.
 *
 * Attribution has to happen before the revert because the change itself can
 * add or remove an import, and the closure that matters is the one that exists
 * where the break exists. The two confirmation sides answer both causal
 * questions: "does it still fail alone WITH the change" and "does it pass
 * alone WITHOUT it".
 */
export async function analyzeTests(commit, files, dir, { evidence = false } = {}) {
  const parent = (await git(["rev-parse", `${commit}^`])).trim();
  const tree = (await git(["rev-parse", `${commit}^^{tree}`])).trim();
  const subject = (await git(["log", "-1", "--format=%s", commit])).trim();
  await extract(parent, dir);

  // The type pass runs FIRST and is not only the type baseline: `buildFirst`
  // emits the dist directories that the tests import across package
  // boundaries. Without it every cross-package test fails on the baseline too,
  // which is not a break — it is a tree that was never built.
  const typeBaseline = usesTypes(TRUTH) ? await errorSignatures(dir) : null;

  const testFiles = testFilesOf(dir, profile.testRunner);
  // Closures are computed ONCE per commit, on the parent tree. A candidate's
  // own diff can add an import, but a candidate is never a test file, so the
  // set of tests that reach a file is stable across the candidates of one
  // commit — and computing it per candidate would repeat the same walk.
  const closures = closuresOf(dir, testFiles, { packageNames: profile.packageNames });

  const record = { repo: profile.root, commit, parent, subject, truthRule: TRUTH_RULE, truthMode: TRUTH };
  const results = [];
  /**
   * A tree from before this repository had a test suite at all.
   *
   * `selectTests` already falls back to "run everything" when nothing is
   * selected, but everything is the empty set here, so the baseline ran the
   * runner against no files and reported `1..0`. That was recorded as
   * `not evaluable: baseline error (no test results parsed …)` — which reads
   * like the runner malfunctioning, and, worse, ended the candidate BEFORE the
   * type pass it never needed tests for. The registered truth is a UNION of
   * type errors and broken tests; dropping a candidate for having no tests
   * throws away the half of the rule that could still decide it.
   *
   * So a testless tree is not a failure: the test half contributes nothing and
   * the candidate is decided on types alone, which is exactly what `--truth
   * types` does with the same tree.
   */
  const testless = testFiles.length === 0;
  for (const file of files) {
    const diff = await git(["diff", parent, commit, "--", file]);
    if (testless) {
      results.push(await typeOnlyCandidate(record, file, diff, dir, parent, typeBaseline));
      continue;
    }
    const selection = selectTests(dir, file, { testFiles, closures, diff });
    const base = await testBaseline(tree, dir, selection.files);
    if (base.status !== "ok") {
      results.push({
        ...record,
        file,
        reason: `not evaluable: baseline ${base.status}${base.detail ? ` (${base.detail})` : ""}`,
      });
      continue;
    }
    const passing = new Map(base.passing.map((id) => [id, "pass"]));
    const patch = join(dir, ".eval-mutation.diff");
    writeFileSync(patch, diff);
    const applied = await run("git", ["apply", patch], { cwd: dir, ...BUF }).then(
      () => true,
      () => false,
    );
    if (!applied) {
      rmSync(patch, { force: true });
      results.push({ ...record, file, reason: "diff does not apply alone" });
      continue;
    }

    const afterTypes = usesTypes(TRUTH) ? await errorSignatures(dir) : null;
    const after = await runSuite(dir, profile.testRunner, {
      files: selection.files,
      timeoutMs: TEST_TIMEOUT_MS,
    });
    // Everything that needs the MUTATED tree is read here, before the revert:
    // the change itself can add or remove an import, and the closure that
    // decides attribution and the blind-spot flag is the one that exists where
    // the break exists.
    const broke = after.status === "ok" ? brokenCases(passing, after.cases, after.ambiguous) : [];
    const brokenFiles = [
      ...new Set(broke.map((id) => testFileOfCase(id, dir, after.files)).filter((f) => f !== null)),
    ].sort();
    const attributions = new Map(
      brokenFiles.map((t) => [t, attribute(dir, t, file, { packageNames: profile.packageNames })]),
    );
    const mutatedConfirmation = await confirmCases(
      dir,
      profile.testRunner,
      brokenFiles,
      broke,
      (id) => testFileOfCase(id, dir, after.files),
      "fail",
      { timeoutMs: TEST_TIMEOUT_MS },
    );

    const reverted = await run("git", ["apply", "-R", patch], { cwd: dir, ...BUF }).then(
      () => true,
      () => false,
    );
    rmSync(patch, { force: true });
    if (!reverted) await extract(parent, dir);

    if (after.status !== "ok") {
      // A suite that hangs or cannot start under the change is a candidate we
      // could not judge. Calling it "breaks nothing" would silently push a
      // hard case into the population as an easy one.
      results.push({ ...record, file, reason: `not evaluable: mutated run ${after.status}` });
      continue;
    }

    if (mutatedConfirmation.status !== "ok") {
      results.push({
        ...record,
        file,
        reason: `not evaluable: mutated confirmation ${mutatedConfirmation.status}`,
      });
      continue;
    }

    const cleanConfirmation = await confirmCases(
      dir,
      profile.testRunner,
      brokenFiles,
      broke,
      (id) => testFileOfCase(id, dir, after.files),
      "pass",
      { timeoutMs: TEST_TIMEOUT_MS },
    );
    if (cleanConfirmation.status !== "ok") {
      results.push({
        ...record,
        file,
        reason: `not evaluable: clean confirmation ${cleanConfirmation.status}`,
      });
      continue;
    }
    const confirmed = confirmedOnBoth(mutatedConfirmation, cleanConfirmation);
    const fromTests = new Set();
    const rules = {};
    const blindSpots = [];
    for (const t of brokenFiles) {
      if (!confirmed.has(t)) continue;
      const a = attributions.get(t);
      rules[t] = a.rule;
      // The failing TEST FILE is the observed truth. Its imports are useful
      // diagnostic metadata, but importing a source does not prove that source
      // itself fails or needs adaptation.
      fromTests.add(t);
      if (!a.closure.has(file)) blindSpots.push(t);
    }
    // The v3 rule, unchanged: a file that carries a type error it did not
    // carry before. The two truths are a UNION — a change can break a type
    // without breaking a test, and break a test without breaking a type.
    const fromTypes = usesTypes(TRUTH)
      ? [...newErrorFiles(typeBaseline, afterTypes)].filter((f) => f !== file)
      : [];
    const truth = [...new Set([...fromTypes, ...fromTests])].sort();
    const entry = {
      ...record,
      file,
      diff,
      truth,
      truthFromTypes: [...fromTypes].sort(),
      truthFromTests: [...fromTests].sort(),
      truthSource:
        fromTypes.length > 0 && fromTests.size > 0
          ? "both"
          : fromTypes.length > 0
            ? "tsc"
            : fromTests.size > 0
              ? "tests"
              : "none",
      brokenTests: [...confirmed].sort(),
      truthRules: rules,
      blindSpots,
      testSelection: { mode: selection.mode, files: selection.files.length, reached: selection.reached },
      baselinePassing: base.passing.length,
    };
    if (evidence) entry.brokenCases = broke.slice(0, 50);
    results.push(entry);
  }
  return results;
}

/** Truth sets for every candidate file of one commit: one baseline, one mutation per file. */
export async function analyze(commit, files, dir, { evidence = false } = {}) {
  if (usesTests(TRUTH)) return analyzeTests(commit, files, dir, { evidence });
  const parent = (await git(["rev-parse", `${commit}^`])).trim();
  const subject = (await git(["log", "-1", "--format=%s", commit])).trim();
  await extract(parent, dir);
  const baseline = await errorSignatures(dir);
  const results = [];
  // The tree is extracted ONCE per commit and each file's diff is applied and
  // then reverted, instead of re-extracting per file. Measured: extraction is
  // the dominant cost on a tree this size, and a revert that fails falls back
  // to a full extract, so the state a measurement starts from is never a guess.
  for (const file of files) {
    const record = { repo: profile.root, commit, parent, file, subject };
    const diff = await git(["diff", parent, commit, "--", file]);
    const patch = join(dir, ".eval-mutation.diff");
    writeFileSync(patch, diff);
    const applied = await run("git", ["apply", patch], { cwd: dir, ...BUF }).then(
      () => true,
      () => false,
    );
    if (!applied) {
      rmSync(patch, { force: true });
      results.push({ ...record, reason: "diff does not apply alone" });
      continue;
    }
    const after = await errorSignatures(dir);
    const reverted = await run("git", ["apply", "-R", patch], { cwd: dir, ...BUF }).then(
      () => true,
      () => false,
    );
    rmSync(patch, { force: true });
    if (!reverted) await extract(parent, dir);
    const truth = [...newErrorFiles(baseline, after)].filter((f) => f !== file).sort();
    const entry = {
      ...record,
      diff,
      truth,
      baselineErrors: [...baseline.values()].reduce((a, b) => a + b, 0),
    };
    if (evidence) {
      entry.newErrors = [...after].filter(([sig, n]) => n > (baseline.get(sig) ?? 0)).map(([sig]) => sig);
    }
    results.push(entry);
  }
  return results;
}

/**
 * The frozen description of the population, rewritten after every pass so an
 * interrupted mining run always leaves a readable intermediate state.
 *
 * It exists for the same reason `mutation-gate.mjs` pins its population: a
 * sample drawn later under a registered seed is only reproducible against a
 * FIXED set of scenarios. The hash is over the accepted (commit, file) pairs
 * in acceptance order, so adding one scenario changes it and nobody can
 * quietly re-mine a different population under the same registration.
 */
export function populationFreeze(decisions, accepted) {
  const kept = decisions.filter((d) => d.accepted === true);
  // `packages/daemon`, not `packages` — the first segment is the same for
  // every file in a monorepo and would report one bucket for the whole sample.
  const packageOf = (f) => f.split("/").slice(0, 2).join("/") || ".";
  const tally = (pairs) => {
    const counts = {};
    for (const key of pairs) counts[key] = (counts[key] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
  };
  return {
    repository: profile.root,
    repository_head: REPO_HEAD,
    truth: TRUTH,
    truth_rule: TRUTH_RULE,
    seed: Number(process.env.CODE_ROI_SEED ?? 20260918),
    stop_at: STOP_AT,
    max_truth: MAX_TRUTH,
    accepted,
    decided: decisions.length,
    excluded_pilot: PILOT_COMMITS,
    exclusions: {
      sha256: exclusionsHash(EXCLUSIONS),
      burned_files: EXCLUSIONS.files.length,
      prefixes: EXCLUSIONS.reasons,
      sources: EXCLUSIONS.sources,
    },
    population_sha256: truthPopulationHash(kept),
    distribution: {
      by_package: tally(kept.map((d) => packageOf(d.file))),
      truth_size: tally(kept.map((d) => String(d.truth?.length ?? 0))),
      truth_source: tally(kept.map((d) => d.truthSource ?? "types")),
      attribution_rule: tally(kept.flatMap((d) => Object.values(d.truthRules ?? {}))),
      test_selection: tally(kept.map((d) => d.testSelection?.mode ?? "n/a")),
      with_blind_spots: kept.filter((d) => (d.blindSpots?.length ?? 0) > 0).length,
    },
    rejected: tally(decisions.filter((d) => d.accepted !== true).map((d) => rejectionBucket(d.reason))),
  };
}

/**
 * The rejection CATEGORY, without the detail the reason carries after it.
 *
 * "not evaluable: baseline error (no test results parsed: …)" ends in a TAP
 * dump whose `duration_ms` differs every time, so counting raw reasons gave
 * the tests/v2 run twenty-four buckets of one to eleven candidates where there
 * was one cause with 46. A histogram nobody can read is a histogram that hides
 * the thing it was written to show; the full reason stays on every candidate
 * in `candidates.jsonl`.
 */
export function rejectionBucket(reason) {
  const text = String(reason ?? "unknown");
  const detail = text.indexOf(" (");
  return detail > 0 ? text.slice(0, detail) : text;
}

/** Every repository's candidate file, concatenated into the pooled one. */
function mergeCandidates() {
  // The pooled file is NOT one of its own inputs. `candidates.jsonl` matches
  // the same prefix and suffix as the per-repository files, so without this it
  // was concatenated into itself once per pass: 432 real decisions grew to
  // 5094 lines and 45 accepted scenarios appeared 682 times, which is what
  // `select.mjs` would then have drawn its sample from.
  const parts = readdirSync(OUT)
    .filter((f) => f.startsWith("candidates.") && f.endsWith(".jsonl") && f !== "candidates.jsonl")
    .sort();
  const lines = parts.flatMap((f) => readFileSync(join(OUT, f), "utf8").split("\n").filter(Boolean));
  writeFileSync(CANDIDATES, lines.join("\n") + "\n");
}

function loadCache() {
  const cache = new Map();
  if (!existsSync(CACHE)) return cache;
  for (const line of readFileSync(CACHE, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    cache.set(`${r.repo ?? REPO}:${r.commit}:${r.file}`, r);
  }
  return cache;
}

/**
 * Accept in walk order, applying the registration's caps: one scenario per
 * FILE, the truth set must be non-empty and at most MAX_TRUTH. Decided from
 * the cache, so running the analyses in parallel changes the wall clock and
 * nothing about which scenarios are chosen.
 */
function decide(commits, filesByCommit, cache) {
  const decisions = [];
  const usedFiles = new Set();
  let accepted = 0;
  for (const commit of commits) {
    for (const file of filesByCommit.get(commit) ?? []) {
      const r = cache.get(`${REPO}:${commit}:${file}`);
      if (r === undefined) return { decisions, accepted, blockedAt: commit };
      if (r.reason !== undefined) {
        decisions.push({ ...r, accepted: false });
        continue;
      }
      if (usedFiles.has(file)) {
        decisions.push({ ...r, accepted: false, reason: "file already used" });
        continue;
      }
      if (r.truth.length === 0) {
        decisions.push({ ...r, accepted: false, reason: "breaks nothing" });
        continue;
      }
      if (r.truth.length > MAX_TRUTH) {
        decisions.push({ ...r, accepted: false, reason: "too many truth files" });
        continue;
      }
      usedFiles.add(file);
      decisions.push({ ...r, accepted: true });
      if (++accepted >= STOP_AT) return { decisions, accepted, blockedAt: null };
    }
  }
  return { decisions, accepted, blockedAt: null };
}

async function main() {
  if (usesTypes(TRUTH) && profile.tsconfigs.length === 0) {
    throw new Error(`${REPO}: no tsconfig found — nothing to typecheck, so no truth can be built`);
  }
  if (usesTests(TRUTH) && profile.testRunner === null) {
    throw new Error(
      `${REPO}: no test runner found in package.json — a repository without a suite cannot carry test-based truth`,
    );
  }
  if (usesTests(TRUTH)) loadTestBaselines();
  process.stdout.write(
    `repo ${REPO}\n  truth ${TRUTH} (${TRUTH_RULE})\n` +
      `  packages ${profile.packageDirs.length}, scopes ${profile.scopes.join(",") || "none"}\n` +
      (usesTypes(TRUTH)
        ? `  tsconfigs ${profile.tsconfigs.join(", ")}\n  build first: ${profile.buildFirst.join(", ") || "nothing"}\n`
        : "") +
      (usesTests(TRUTH)
        ? `  runner ${profile.testRunner.kind} via ${JSON.stringify(profile.testRunner.script)}\n` +
          `  time budget ${TEST_TIMEOUT_MS} ms per suite run\n`
        : "") +
      (EXCLUSIONS.files.length > 0
        ? `  excluded: ${EXCLUSIONS.files.length} burned files, ${EXCLUSIONS.commits.length} pilot commits, ` +
          `prefixes ${EXCLUSIONS.prefixes.join(" ")} (${exclusionsHash(EXCLUSIONS).slice(0, 12)})\n`
        : ""),
  );

  const since = argOf("--since") ?? process.env.CODE_ROI_RANGE_END ?? "HEAD";
  const commits = (await git(["rev-list", "--no-merges", since])).split("\n").filter(Boolean);
  const filesByCommit = new Map();
  for (const commit of commits) {
    if (PILOT_COMMITS.includes(commit)) continue;
    const files = await candidatesOf(commit);
    if (files.length > 0) filesByCommit.set(commit, files);
  }

  const dirs = Array.from({ length: WORKERS }, (_, i) => join(OUT, `wt-${i}`));
  const cache = loadCache();
  for (;;) {
    const { decisions, accepted, blockedAt } = decide(commits, filesByCommit, cache);
    writeFileSync(CANDIDATES_REPO, decisions.map((d) => JSON.stringify(d)).join("\n") + "\n");
    mergeCandidates();
    writeFileSync(join(OUT, "population.json"), JSON.stringify(populationFreeze(decisions, accepted), null, 2) + "\n");
    process.stdout.write(
      `pass: ${accepted}/${STOP_AT} accepted, ${decisions.length} decided` +
        (TRUTH === "tests" ? `, ${decisions.filter((d) => d.blindSpots?.length > 0).length} with blind spots` : "") +
        `\n`,
    );
    if (blockedAt === null) break;

    const start = commits.indexOf(blockedAt);
    const batch = commits
      .slice(start)
      .filter((c) => filesByCommit.has(c) && filesByCommit.get(c).some((f) => !cache.has(`${REPO}:${c}:${f}`)))
      .slice(0, WORKERS * 2);
    let next = 0;
    await Promise.all(
      dirs.map(async (dir) => {
        while (next < batch.length) {
          const commit = batch[next++];
          // The repository prefix belongs in the key: without it nothing ever
          // looked cached here and every batch re-analysed files it had
          // already decided, which on the test-based path is a whole suite run.
          const files = filesByCommit.get(commit).filter((f) => !cache.has(`${REPO}:${commit}:${f}`));
          const results = await analyze(commit, files, dir).catch((e) =>
            files.map((file) => ({
              repo: profile.root,
              commit,
              file,
              // The same wording the truth rules use for everything that could
              // not be judged, so a crashed candidate is counted as what it is
              // rather than as evidence that the change breaks nothing.
              reason: `not evaluable: analysis failed: ${String(e?.message ?? e).slice(0, 200)}`,
            })),
          );
          for (const r of results) {
            cache.set(`${r.repo ?? REPO}:${r.commit}:${r.file}`, r);
            appendFileSync(CACHE, JSON.stringify(r) + "\n");
          }
        }
      }),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
