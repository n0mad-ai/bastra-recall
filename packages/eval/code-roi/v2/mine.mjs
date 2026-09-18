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
 * The walk order, the one-per-file rule and the stop rule come from the
 * registration and are not parameters here, so the selection cannot be tuned
 * after looking at what it produced.
 *
 * SPEED WITHOUT CHANGING THE SELECTION. Computing a truth set is the slow part
 * (~20 s per commit, and most changes break nothing), so it runs for several
 * commits at once, each in its own worktree. Which candidates are ACCEPTED is
 * decided afterwards, strictly in walk order, from the cached results — the
 * same rule a sequential walk applies, so parallelism changes the wall clock
 * and nothing else.
 *
 * Usage: node packages/eval/code-roi/v2/mine.mjs
 * Resumable: truth sets are cached in truth-cache.jsonl; candidates.jsonl is
 * rewritten from the cache on every pass.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const REPO = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const RANGE_END = "5483f56";
export const OUT = join(homedir(), ".bastra", "eval", "code-roi-v2");
const CANDIDATES = join(OUT, "candidates.jsonl");
const CACHE = join(OUT, "truth-cache.jsonl");
const TSC = join(REPO, "node_modules", ".bin", "tsc");
const WORKERS = 5;

// From the registration — not tunable here.
const STOP_AT = 45;
const MAX_TRUTH = 40;

mkdirSync(OUT, { recursive: true });

const BUF = { maxBuffer: 512 * 1024 * 1024, encoding: "utf8" };
const git = async (args, cwd = REPO) => (await run("git", args, { cwd, ...BUF })).stdout;

export async function ensureWorktree(wt) {
  if (!existsSync(wt)) await git(["worktree", "add", "--detach", wt, RANGE_END]);
}

/**
 * Dependencies without a network: the worktree's node_modules mirrors the main
 * checkout's, except that the workspace links point INTO the worktree — so a
 * change to core is seen by daemon through core's freshly built dist.
 */
function linkNodeModules(wt) {
  const mainNm = join(REPO, "node_modules");
  const wtNm = join(wt, "node_modules");
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
  for (const pkg of readdirSync(join(wt, "packages"))) {
    if (existsSync(join(wt, "packages", pkg, "package.json"))) {
      symlinkSync(join(wt, "packages", pkg), join(ws, pkg));
    }
    const pkgNm = join(REPO, "packages", pkg, "node_modules");
    const wtPkgNm = join(wt, "packages", pkg, "node_modules");
    if (existsSync(pkgNm) && !existsSync(wtPkgNm)) symlinkSync(pkgNm, wtPkgNm);
  }
}

async function checkout(wt, sha) {
  await git(["checkout", "--detach", "--force", sha], wt);
  // Build output and eval tsconfigs from the previous state must not leak in.
  await git(["clean", "-fdx", "-e", "node_modules", "-q"], wt);
  linkNodeModules(wt);
}

/**
 * Every type error as `file\tTScode\tmessage` → count. The position is left
 * out on purpose: a mutation shifts lines, and the same error one line lower
 * is not a new error.
 */
async function errorSignatures(wt) {
  const sigs = new Map();
  const pkgs = readdirSync(join(wt, "packages")).filter((p) => existsSync(join(wt, "packages", p, "tsconfig.json")));
  // core first: the others see it through its dist.
  if (pkgs.includes("core")) {
    // Emits even with errors (noEmitOnError is off); errors are collected below.
    await run(TSC, ["-p", join(wt, "packages/core/tsconfig.json")], { cwd: wt, ...BUF }).catch(() => {});
  }
  for (const pkg of pkgs) {
    const dir = join(wt, "packages", pkg);
    const cfg = join(dir, "tsconfig.eval-check.json");
    const include = ["src/**/*.ts"];
    if (existsSync(join(dir, "__tests__"))) include.push("__tests__/**/*.ts");
    writeFileSync(cfg, JSON.stringify({ extends: "./tsconfig.json", include, compilerOptions: { noEmit: true, rootDir: "." } }));
    const out = await run(TSC, ["-p", cfg, "--pretty", "false"], { cwd: dir, ...BUF }).then(
      (r) => r.stdout,
      (e) => `${e.stdout ?? ""}`,
    );
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

async function candidatesOf(sha) {
  const out = await git(["diff-tree", "--no-commit-id", "--name-status", "-r", sha]);
  return out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter(([status, path]) => status === "M" && /^packages\/[^/]+\/src\/.+\.ts$/.test(path ?? ""))
    .map(([, path]) => path)
    .filter((p) => !/__tests__|\.(test|spec)\.ts$|\.d\.ts$/.test(p))
    .sort();
}

/** Truth sets for every candidate file of one commit — one baseline, then one mutation per file. */
export async function analyze(commit, files, wt, { evidence = false } = {}) {
  const parent = (await git(["rev-parse", `${commit}^`])).trim();
  const subject = (await git(["log", "-1", "--format=%s", commit])).trim();
  await checkout(wt, parent);
  const baseline = await errorSignatures(wt);
  const results = [];
  for (const file of files) {
    const record = { commit, parent, file, subject };
    const diff = await git(["diff", parent, commit, "--", file]);
    await checkout(wt, parent);
    const patch = join(wt, ".eval-mutation.diff");
    writeFileSync(patch, diff);
    const applied = await git(["apply", patch], wt).then(() => true, () => false);
    rmSync(patch, { force: true });
    if (!applied) {
      results.push({ ...record, reason: "diff does not apply alone" });
      continue;
    }
    const after = await errorSignatures(wt);
    const truth = [...newErrorFiles(baseline, after)].filter((f) => f !== file).sort();
    const entry = { ...record, diff, truth, baselineErrors: [...baseline.values()].reduce((a, b) => a + b, 0) };
    // For hand adjudication: the new errors themselves, not just their files.
    if (evidence) entry.newErrors = [...after].filter(([sig, n]) => n > (baseline.get(sig) ?? 0)).map(([sig]) => sig);
    results.push(entry);
  }
  return results;
}

function loadCache() {
  const cache = new Map();
  if (!existsSync(CACHE)) return cache;
  for (const l of readFileSync(CACHE, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    cache.set(`${r.commit}:${r.file}`, r);
  }
  return cache;
}

/**
 * The registered selection, applied in walk order over cached results. Returns
 * the decisions so far and whether it had to stop for a missing result.
 */
function select(walk, cache) {
  const decisions = [];
  const files = new Set();
  let accepted = 0;
  for (const { commit, file } of walk) {
    if (accepted >= STOP_AT) return { decisions, accepted, blockedAt: null };
    if (files.has(file)) { decisions.push({ commit, file, accepted: false, reason: "file already used" }); continue; }
    const r = cache.get(`${commit}:${file}`);
    if (r === undefined) return { decisions, accepted, blockedAt: commit };
    if (r.reason) { decisions.push({ ...r, accepted: false }); continue; }
    if (r.truth.length === 0) { decisions.push({ ...r, accepted: false, reason: "breaks nothing" }); continue; }
    if (r.truth.length > MAX_TRUTH) { decisions.push({ ...r, accepted: false, reason: `breaks ${r.truth.length} files (> ${MAX_TRUTH})` }); continue; }
    decisions.push({ ...r, accepted: true });
    accepted++;
    files.add(file);
  }
  return { decisions, accepted, blockedAt: null };
}

async function main() {
  const commits = (await git(["rev-list", "--no-merges", RANGE_END])).split("\n").filter(Boolean);
  const walk = [];
  const filesByCommit = new Map();
  for (const commit of commits) {
    const files = await candidatesOf(commit);
    if (files.length === 0) continue;
    filesByCommit.set(commit, files);
    for (const file of files) walk.push({ commit, file });
  }
  const worktrees = Array.from({ length: WORKERS }, (_, i) => join(OUT, `wt-${i}`));
  for (const wt of worktrees) await ensureWorktree(wt);

  const cache = loadCache();
  for (;;) {
    const { decisions, accepted, blockedAt } = select(walk, cache);
    writeFileSync(CANDIDATES, decisions.map((d) => JSON.stringify(d)).join("\n") + "\n");
    process.stdout.write(`pass: ${accepted}/${STOP_AT} accepted, ${decisions.length} decided\n`);
    if (blockedAt === null) break;

    // The next commits in walk order that still lack a result, one per worker
    // slot a few times over. Some may later fall to a cap — wasted work, never
    // a different selection.
    const start = commits.indexOf(blockedAt);
    const batch = commits
      .slice(start)
      .filter((c) => filesByCommit.has(c) && filesByCommit.get(c).some((f) => !cache.has(`${c}:${f}`)))
      .slice(0, WORKERS * 3);
    let next = 0;
    await Promise.all(
      worktrees.map(async (wt) => {
        while (next < batch.length) {
          const commit = batch[next++];
          const files = filesByCommit.get(commit).filter((f) => !cache.has(`${commit}:${f}`));
          const results = await analyze(commit, files, wt).catch((e) =>
            files.map((file) => ({ commit, file, reason: `analysis failed: ${String(e?.message ?? e).slice(0, 200)}` })),
          );
          for (const r of results) {
            cache.set(`${r.commit}:${r.file}`, r);
            appendFileSync(CACHE, JSON.stringify(r) + "\n");
          }
        }
      }),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
