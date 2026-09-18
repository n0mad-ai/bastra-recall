/**
 * Scenario miner for the code-awareness measurement, registration v2 (#588).
 *
 * Walks non-merge commits reachable from the range end NEWEST first. For each
 * modified `.ts` file F under `packages/<pkg>/src/` (tests excluded), on a
 * worktree at the commit's parent:
 *
 *   1. typecheck every workspace package, src AND __tests__   → baseline
 *   2. apply ONLY F's diff from the commit
 *   3. typecheck again                                          → mutated
 *
 * A file is affected when it carries a type error after the mutation that it
 * did not carry before, errors compared as (file, TS code, message) with the
 * position ignored — many test files already carry errors, and a file-level
 * comparison would be blind to new ones there. F itself is excluded. That set
 * is the ground truth.
 * It is written OUTSIDE the repository (`~/.bastra/eval/code-roi-v2/`): v1's
 * treatment arm stumbled over answers that sat in the tree it searched.
 *
 * The walk order, the independence caps and the stop rule come from the
 * registration and are not parameters here, so the selection cannot be tuned
 * after looking at what it produced.
 *
 * Usage: node packages/eval/code-roi/v2/mine.mjs
 * Resumable: candidates already decided are read back from candidates.jsonl.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const REPO = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const RANGE_END = "5483f56";
const OUT = join(homedir(), ".bastra", "eval", "code-roi-v2");
const WT = join(OUT, "wt");
const CANDIDATES = join(OUT, "candidates.jsonl");
const TSC = join(REPO, "node_modules", ".bin", "tsc");

// From the registration — not tunable here.
const STOP_AT = 45;
const MAX_PER_DIR = 3;
const MAX_TRUTH = 40;

mkdirSync(OUT, { recursive: true });

const git = (args, cwd = REPO) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

function ensureWorktree() {
  if (!existsSync(WT)) git(["worktree", "add", "--detach", WT, RANGE_END]);
}

/**
 * Dependencies without a network: the worktree's node_modules mirrors the main
 * checkout's, except that the workspace links point INTO the worktree — so a
 * change to core is seen by daemon through core's freshly built dist.
 */
function linkNodeModules() {
  const mainNm = join(REPO, "node_modules");
  const wtNm = join(WT, "node_modules");
  if (!existsSync(wtNm)) {
    mkdirSync(wtNm);
    for (const entry of readdirSync(mainNm)) {
      if (entry === "@bastra-recall") continue;
      symlinkSync(join(mainNm, entry), join(wtNm, entry));
    }
  }
  const ws = join(wtNm, "@bastra-recall");
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws);
  for (const pkg of readdirSync(join(WT, "packages"))) {
    if (existsSync(join(WT, "packages", pkg, "package.json"))) {
      symlinkSync(join(WT, "packages", pkg), join(ws, pkg));
    }
    const pkgNm = join(REPO, "packages", pkg, "node_modules");
    const wtPkgNm = join(WT, "packages", pkg, "node_modules");
    if (existsSync(pkgNm) && !existsSync(wtPkgNm)) symlinkSync(pkgNm, wtPkgNm);
  }
}

function checkout(sha) {
  git(["checkout", "--detach", "--force", sha], WT);
  // Build output and eval tsconfigs from the previous state must not leak in.
  git(["clean", "-fdx", "-e", "node_modules", "-q"], WT);
  // `packages/<pkg>/node_modules` symlinks survive -e; a package that did not
  // exist at this commit may have left a dangling one, which is harmless.
  linkNodeModules();
}

function packagesWithTsconfig() {
  return readdirSync(join(WT, "packages")).filter((p) => existsSync(join(WT, "packages", p, "tsconfig.json")));
}

/**
 * Every type error as `file\tTScode\tmessage` → count. The position is left
 * out on purpose: a mutation shifts lines, and the same error one line lower
 * is not a new error.
 */
function errorSignatures() {
  const sigs = new Map();
  const pkgs = packagesWithTsconfig();
  // core first: the others see it through its dist.
  if (pkgs.includes("core")) {
    try {
      execFileSync(TSC, ["-p", join(WT, "packages/core/tsconfig.json")], { cwd: WT, stdio: "pipe" });
    } catch {
      // Emits anyway (noEmitOnError is off); the errors are collected below.
    }
  }
  for (const pkg of pkgs) {
    const dir = join(WT, "packages", pkg);
    const cfg = join(dir, "tsconfig.eval-check.json");
    const include = ["src/**/*.ts"];
    if (existsSync(join(dir, "__tests__"))) include.push("__tests__/**/*.ts");
    writeFileSync(
      cfg,
      JSON.stringify({ extends: "./tsconfig.json", include, compilerOptions: { noEmit: true, rootDir: "." } }),
    );
    let out = "";
    try {
      execFileSync(TSC, ["-p", cfg, "--pretty", "false"], { cwd: dir, stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      out = `${e.stdout ?? ""}`;
    }
    for (const line of out.split("\n")) {
      const m = /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/.exec(line);
      if (!m) continue;
      const sig = `packages/${pkg}/${m[1].replace(/^\.\//, "")}\t${m[2]}\t${m[3]}`;
      sigs.set(sig, (sigs.get(sig) ?? 0) + 1);
    }
  }
  return sigs;
}

/** Files with an error signature the baseline did not have (as often). */
function newErrorFiles(before, after) {
  const files = new Set();
  for (const [sig, n] of after) {
    if (n > (before.get(sig) ?? 0)) files.add(sig.split("\t")[0]);
  }
  return files;
}

function candidatesOf(sha) {
  const out = git(["diff-tree", "--no-commit-id", "--name-status", "-r", sha]);
  return out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter(([status, path]) => status === "M" && /^packages\/[^/]+\/src\/.+\.ts$/.test(path ?? ""))
    .map(([, path]) => path)
    .filter((p) => !/__tests__|\.(test|spec)\.ts$|\.d\.ts$/.test(p))
    .sort();
}

function loadDecided() {
  if (!existsSync(CANDIDATES)) return [];
  return readFileSync(CANDIDATES, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function main() {
  ensureWorktree();
  const decided = loadDecided();
  const seen = new Set(decided.map((d) => `${d.commit}:${d.file}`));
  const accepted = decided.filter((d) => d.accepted);
  const files = new Set(accepted.map((d) => d.file));
  const perDir = new Map();
  for (const d of accepted) perDir.set(dirname(d.file), (perDir.get(dirname(d.file)) ?? 0) + 1);

  const commits = git(["rev-list", "--no-merges", RANGE_END]).split("\n").filter(Boolean);
  const baselineCache = new Map();

  for (const commit of commits) {
    if (accepted.length >= STOP_AT) break;
    const todo = candidatesOf(commit).filter((f) => !seen.has(`${commit}:${f}`));
    if (todo.length === 0) continue;
    const parent = git(["rev-parse", `${commit}^`]).trim();

    for (const file of todo) {
      if (accepted.length >= STOP_AT) break;
      const record = { commit, parent, file, subject: git(["log", "-1", "--format=%s", commit]).trim() };
      const skip = (reason) => {
        appendFileSync(CANDIDATES, JSON.stringify({ ...record, accepted: false, reason }) + "\n");
        seen.add(`${commit}:${file}`);
      };
      // Independence caps first — cheap, and fixed by the registration.
      if (files.has(file)) { skip("file already used"); continue; }
      if ((perDir.get(dirname(file)) ?? 0) >= MAX_PER_DIR) { skip("directory cap"); continue; }

      const diff = git(["diff", parent, commit, "--", file]);
      let baseline = baselineCache.get(parent);
      if (baseline === undefined) {
        checkout(parent);
        baseline = errorSignatures();
        baselineCache.clear();
        baselineCache.set(parent, baseline);
      } else {
        checkout(parent);
      }
      try {
        execFileSync("git", ["apply", "-"], { cwd: WT, input: diff, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        skip("diff does not apply alone");
        continue;
      }
      const truth = [...newErrorFiles(baseline, errorSignatures())].filter((f) => f !== file).sort();
      if (truth.length === 0) { skip("breaks nothing"); continue; }
      if (truth.length > MAX_TRUTH) { skip(`breaks ${truth.length} files (> ${MAX_TRUTH})`); continue; }

      const entry = { ...record, accepted: true, diff, truth, baselineErrors: [...baseline.values()].reduce((a, b) => a + b, 0) };
      appendFileSync(CANDIDATES, JSON.stringify(entry) + "\n");
      seen.add(`${commit}:${file}`);
      accepted.push(entry);
      files.add(file);
      perDir.set(dirname(file), (perDir.get(dirname(file)) ?? 0) + 1);
      process.stdout.write(`accepted ${accepted.length}/${STOP_AT}: ${commit.slice(0, 7)} ${file} → ${truth.length}\n`);
    }
  }
  process.stdout.write(`done: ${accepted.length} accepted\n`);
}

main();
