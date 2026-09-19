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
 * The truth definition is unchanged from registration 3: a file is affected
 * when it carries a type error after applying exactly one file's diff that it
 * did not carry before, compared as (file, code, message) multisets.
 *
 * Usage:
 *   CODE_ROI_REPO=/path/to/repo CODE_ROI_OUT=<dir> node mine-repo.mjs [--stop-at 45]
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { writableOut } from "./archive.mjs";
import { isScenarioFile, repoProfile } from "./repo-profile.mjs";

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

const profile = repoProfile(REPO);
mkdirSync(OUT, { recursive: true });

const git = async (args, cwd = REPO) => (await run("git", args, { cwd, ...BUF })).stdout;

/**
 * One commit's tree, extracted. NEVER a git worktree: `git archive` reads the
 * object store and writes nothing, so the source repository is untouched even
 * while several of these run at once.
 */
export async function extract(sha, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Streamed, not buffered: `execFile`'s options have no `input` (that is
  // `execFileSync`), so a buffered version leaves tar waiting on a stdin that
  // never closes — it hangs forever instead of failing.
  await new Promise((resolve, reject) => {
    const archive = spawn("git", ["archive", "--format=tar", sha], { cwd: REPO });
    const untar = spawn("tar", ["-x", "-C", dir]);
    archive.stdout.pipe(untar.stdin);
    let err = "";
    archive.stderr.on("data", (d) => (err += d));
    untar.stderr.on("data", (d) => (err += d));
    untar.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`extract ${sha}: ${err.slice(0, 300)}`)),
    );
    archive.on("error", reject);
    untar.on("error", reject);
  });
  linkNodeModules(dir);
}

/**
 * Dependencies without a network and without writing to the source repository:
 * every top-level entry of the original `node_modules` is symlinked in, EXCEPT
 * the workspace scopes — those are pointed at the extracted tree, so a change
 * to a package is seen by everything that imports it.
 *
 * Per-package `node_modules` are linked too. Measured on bastra-io: without
 * them the app's typecheck reports 331 errors on an unmodified tree, because
 * a package's own dependencies cannot resolve from the extracted copy.
 */
function linkNodeModules(dir) {
  const link = (from, to) => {
    if (!existsSync(from)) return;
    try {
      if (lstatSync(to)) rmSync(to, { recursive: true, force: true });
    } catch {
      /* not there yet */
    }
    symlinkSync(from, to);
  };

  const rootModules = join(REPO, "node_modules");
  if (existsSync(rootModules)) {
    const target = join(dir, "node_modules");
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(rootModules)) {
      if (profile.scopes.includes(entry)) continue;
      link(join(rootModules, entry), join(target, entry));
    }
    // pnpm keeps the real packages in `.pnpm`; without it every link dangles.
    for (const hidden of [".pnpm", ".bin", ".modules.yaml"]) {
      link(join(rootModules, hidden), join(target, hidden));
    }
    for (const scope of profile.scopes) {
      const scopeDir = join(target, scope);
      mkdirSync(scopeDir, { recursive: true });
      for (const [pkgDir, name] of profile.packageNames) {
        if (!name.startsWith(`${scope}/`)) continue;
        link(join(dir, pkgDir), join(scopeDir, name.slice(scope.length + 1)));
      }
    }
  }

  for (const pkgDir of profile.packageDirs) {
    const from = join(REPO, pkgDir, "node_modules");
    const to = join(dir, pkgDir, "node_modules");
    if (!existsSync(from) || existsSync(to)) continue;
    // The workspace scope inside a package's own node_modules must point at
    // the extracted tree as well, or the package resolves its siblings from
    // the original checkout and no mutation is ever seen.
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      if (profile.scopes.includes(entry)) continue;
      link(join(from, entry), join(to, entry));
    }
    for (const scope of profile.scopes) {
      const scopeDir = join(to, scope);
      mkdirSync(scopeDir, { recursive: true });
      for (const [otherDir, name] of profile.packageNames) {
        if (!name.startsWith(`${scope}/`)) continue;
        link(join(dir, otherDir), join(scopeDir, name.slice(scope.length + 1)));
      }
    }
  }
}

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
        (FILE_PREFIX === "" || (path ?? "").startsWith(FILE_PREFIX)),
    )
    .map(([, path]) => path)
    .sort();
}

/** Truth sets for every candidate file of one commit: one baseline, one mutation per file. */
export async function analyze(commit, files, dir, { evidence = false } = {}) {
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

/** Every repository's candidate file, concatenated into the pooled one. */
function mergeCandidates() {
  const parts = readdirSync(OUT)
    .filter((f) => f.startsWith("candidates.") && f.endsWith(".jsonl"))
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
  if (profile.tsconfigs.length === 0) {
    throw new Error(`${REPO}: no tsconfig found — nothing to typecheck, so no truth can be built`);
  }
  process.stdout.write(
    `repo ${REPO}\n  packages ${profile.packageDirs.length}, scopes ${profile.scopes.join(",") || "none"}\n` +
      `  tsconfigs ${profile.tsconfigs.join(", ")}\n  build first: ${profile.buildFirst.join(", ") || "nothing"}\n`,
  );

  const since = argOf("--since") ?? process.env.CODE_ROI_RANGE_END ?? "HEAD";
  const commits = (await git(["rev-list", "--no-merges", since])).split("\n").filter(Boolean);
  const filesByCommit = new Map();
  for (const commit of commits) {
    const files = await candidatesOf(commit);
    if (files.length > 0) filesByCommit.set(commit, files);
  }

  const dirs = Array.from({ length: WORKERS }, (_, i) => join(OUT, `wt-${i}`));
  const cache = loadCache();
  for (;;) {
    const { decisions, accepted, blockedAt } = decide(commits, filesByCommit, cache);
    writeFileSync(CANDIDATES_REPO, decisions.map((d) => JSON.stringify(d)).join("\n") + "\n");
    mergeCandidates();
    process.stdout.write(`pass: ${accepted}/${STOP_AT} accepted, ${decisions.length} decided\n`);
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
          const files = filesByCommit.get(commit).filter((f) => !cache.has(`${commit}:${f}`));
          const results = await analyze(commit, files, dir).catch((e) =>
            files.map((file) => ({
              repo: profile.root,
              commit,
              file,
              reason: `analysis failed: ${String(e?.message ?? e).slice(0, 200)}`,
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
