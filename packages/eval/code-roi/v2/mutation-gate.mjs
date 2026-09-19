/**
 * The SYNTHETIC half of the cross-package mechanism gate (#582, registration 6).
 *
 * WHY. The historical gate needs cross-package breakage and the histories do
 * not have it: bastra-io's whole past yields 2 such scenarios out of 111
 * candidates inside `packages/`, bastra-recall's fresh sample none. Waiting
 * for a repository to break itself across a package boundary twenty more times
 * is not a plan. So the breakage is MADE, mechanically and reproducibly.
 *
 * It complements the historical gate; it does not replace it. A synthetic
 * mutation is a fair test of the MECHANISM (does the bridge find the file that
 * really stopped compiling?) and no evidence at all about what people change
 * in practice — the historical gate is the one that speaks to that, and it
 * keeps its own threshold and its own n.
 *
 * HOW IT STAYS HONEST:
 *   - The operators are fixed in this file and registered; nothing is chosen
 *     per symbol, and no operator was picked after seeing what it finds.
 *   - Symbols are drawn with the REGISTERED seed, in a deterministic order, so
 *     the sample is the same on every run and cannot be re-drawn to taste.
 *   - A mutation is kept only when its truth crosses a package boundary, and
 *     that decision is made from the TYPE ERRORS, never from the graph.
 *   - The repository is only ever read: everything happens in an extracted
 *     tree under this archive.
 *
 * Usage: CODE_ROI_REPO=<repo> CODE_ROI_OUT=<gate archive> node mutation-gate.mjs [--target 20]
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  appendFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { writableOut } from "./archive.mjs";
import { extract, errorSignatures, newErrorFiles, PROFILE_OF, REPO } from "./mine-repo.mjs";
import { rng } from "./select.mjs";

const OUT = writableOut();
const REG = JSON.parse(
  readFileSync(new URL("../../registrations/code-awareness-change-impact.json", import.meta.url), "utf8"),
);
const SEED = Number(REG.statistics.seed);
const TARGET = Number(argOf("--target") ?? REG.mechanism_gate?.mutation?.target_cross_package_truth_files ?? 20);
const RESULTS = join(OUT, "mutations.jsonl");

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : null;
}

/**
 * The mutation operators, fixed and registered. Each one is a pure string
 * edit with a precondition, so applying it is deterministic and reverting it
 * is just writing the original text back.
 *
 * All three break the CONSUMER, not the definition: that is the whole point —
 * the file that stops compiling has to be somewhere else, ideally in another
 * package.
 */
export const OPERATORS = [
  {
    name: "require-param",
    /** `export function f(` -> `export function f(__mutation: never, ` */
    apply(text, symbol) {
      const re = new RegExp(`(export\\s+(?:async\\s+)?function\\s+${symbol}\\s*(?:<[^>]*>)?\\s*\\()`);
      return re.test(text) ? text.replace(re, `$1__mutation: never, `) : null;
    },
  },
  {
    name: "rename-export",
    /** Renames the exported binding, so every importer loses the name. */
    apply(text, symbol) {
      const decl = new RegExp(
        `(export\\s+(?:async\\s+)?(?:function|class|const|let|interface|type|enum)\\s+)${symbol}\\b`,
      );
      return decl.test(text) ? text.replace(decl, `$1${symbol}Renamed`) : null;
    },
  },
  {
    name: "require-field",
    /** `export interface I {` -> adds a required field every constructor must now pass. */
    apply(text, symbol) {
      const re = new RegExp(`(export\\s+interface\\s+${symbol}\\b[^{]*\\{)`);
      return re.test(text) ? text.replace(re, `$1\n  __mutation: never;`) : null;
    },
  },
];

/** Every `.ts`/`.tsx` file under a workspace package's source, repo-relative. */
export function packageSources(root, profile) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !/\.d\.ts$|\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
    }
  };
  for (const pkgDir of profile.packageDirs) {
    if (!pkgDir.startsWith("packages/")) continue;
    walk(join(root, pkgDir, "src"));
  }
  return out.map((f) => relative(root, f).split("\\").join("/"));
}

/** The exported symbol names a file declares, in source order. */
export function exportedSymbols(text) {
  const names = [];
  const re = /export\s+(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) if (!names.includes(m[1])) names.push(m[1]);
  return names;
}

/** Every (file, symbol, operator) triple, in a deterministic order. */
export function candidateMutations(files, readText) {
  const out = [];
  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;
    for (const symbol of exportedSymbols(text)) {
      for (const op of OPERATORS) out.push({ file, symbol, operator: op.name });
    }
  }
  return out;
}

/** Fisher-Yates with the registered seed — the draw is reproducible. */
export function drawOrder(items, seed = SEED) {
  const next = rng(seed);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const packageOf = (f) => f.split("/").slice(0, 2).join("/");

/**
 * The population, pinned — a hash of the drawn triple list (#582 review).
 *
 * The gate used to extract `HEAD` on every invocation. `HEAD` is whatever the
 * repository points at TODAY, so a run resumed after a commit in bastra-io
 * would have appended mutations of one tree to mutations of another, under one
 * seed, and reported the mixture as one sample. A seeded draw is only
 * reproducible against a fixed population; this is the fixed population, and
 * the run refuses to continue against a different one.
 */
export function populationHash(candidates) {
  return createHash("sha256")
    .update(candidates.map((c) => `${c.file}:${c.symbol}:${c.operator}`).join("\n"))
    .digest("hex");
}

const POPULATION_FILE = join(OUT, "population.json");

/**
 * Pin the population on the first run, and on every later one check it.
 *
 * A mismatch is an error, never a silent re-pin: the whole point is that a
 * resumed helping cannot quietly become a different sample.
 */
export function checkPopulation(recorded, current) {
  if (recorded === null) return { ok: true, write: true };
  for (const key of ["repository", "commit", "population_sha256", "candidates", "seed"]) {
    if (recorded[key] !== current[key]) {
      return {
        ok: false,
        write: false,
        why:
          `the population of this gate archive was pinned at ${key}=${String(recorded[key])} ` +
          `and is now ${String(current[key])}. A seeded draw is only reproducible against a ` +
          `fixed population, so this run would mix two samples under one seed. Start a new ` +
          `archive, or check out the pinned commit.`,
      };
    }
  }
  return { ok: true, write: false };
}

/** The unified diff a mutation produces, headed the way `changedLines` reads it. */
export function mutationDiff(file, original, mutated) {
  const dir = mkdtempSync(join(tmpdir(), "code-roi-mutdiff-"));
  try {
    writeFileSync(join(dir, "a"), original, "utf8");
    writeFileSync(join(dir, "b"), mutated, "utf8");
    let body = "";
    try {
      body = execFileSync("diff", ["-U3", join(dir, "a"), join(dir, "b")], { encoding: "utf8" });
    } catch (err) {
      // `diff` exits 1 when the files differ, which is the expected case.
      if (err.status !== 1) throw err;
      body = err.stdout ?? "";
    }
    const hunks = body.split("\n").filter((l) => !l.startsWith("--- ") && !l.startsWith("+++ "));
    return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, ...hunks].join("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const profile = PROFILE_OF(REPO);
  mkdirSync(OUT, { recursive: true });
  const dir = join(OUT, "mut-tree");
  // The pinned commit, resolved ONCE and recorded — not the moving `HEAD`.
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  process.stdout.write(`extracting ${REPO} @ ${head}\n`);
  await extract(head, dir);

  const baseline = await errorSignatures(dir);
  process.stdout.write(`baseline: ${[...baseline.values()].reduce((a, b) => a + b, 0)} pre-existing errors\n`);

  const files = packageSources(dir, profile);
  const readText = (f) => {
    try {
      return readFileSync(join(dir, f), "utf8");
    } catch {
      return null;
    }
  };
  const candidates = drawOrder(candidateMutations(files, readText));
  process.stdout.write(`${files.length} package sources, ${candidates.length} candidate mutations\n`);

  const pinned = {
    repository: REPO,
    commit: head,
    population_sha256: populationHash(candidates),
    candidates: candidates.length,
    seed: SEED,
  };
  const recorded = existsSync(POPULATION_FILE)
    ? JSON.parse(readFileSync(POPULATION_FILE, "utf8"))
    : null;
  const verdict = checkPopulation(recorded, pinned);
  if (!verdict.ok) throw new Error(`population drift: ${verdict.why}`);
  if (verdict.write) writeFileSync(POPULATION_FILE, JSON.stringify(pinned, null, 2) + "\n");
  process.stdout.write(`population ${pinned.population_sha256.slice(0, 12)} @ ${head.slice(0, 7)}\n`);

  const done = new Set(
    existsSync(RESULTS)
      ? readFileSync(RESULTS, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const r = JSON.parse(l);
            return `${r.file}:${r.symbol}:${r.operator}`;
          })
      : [],
  );
  let crossFiles = existsSync(RESULTS)
    ? readFileSync(RESULTS, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((r) => r.kept)
        .reduce((a, r) => a + r.crossTruth.length, 0)
    : 0;

  for (const cand of candidates) {
    if (crossFiles >= TARGET) break;
    const key = `${cand.file}:${cand.symbol}:${cand.operator}`;
    if (done.has(key)) continue;
    const op = OPERATORS.find((o) => o.name === cand.operator);
    const original = readText(cand.file);
    if (original === null) continue;
    const mutated = op.apply(original, cand.symbol);
    if (mutated === null) continue; // precondition not met — not a result, just a skip

    writeFileSync(join(dir, cand.file), mutated, "utf8");
    let record;
    try {
      const after = await errorSignatures(dir);
      const truth = [...newErrorFiles(baseline, after)].filter((f) => f !== cand.file).sort();
      const crossTruth = truth.filter((t) => packageOf(t) !== packageOf(cand.file));
      // The diff is KEPT (#582 review). Scoring the gate by handing the tool
      // the symbol name skips `diffSymbols` and `symbol-spans.ts` entirely, so
      // it measured the graph query and not the product: a user changes a file
      // and the product works out which symbols that touched. Storing the diff
      // is what lets the scorer run BOTH.
      record = { ...cand, diff: mutationDiff(cand.file, original, mutated), truth, crossTruth, kept: crossTruth.length > 0 };
    } finally {
      writeFileSync(join(dir, cand.file), original, "utf8");
    }
    appendFileSync(RESULTS, JSON.stringify(record) + "\n");
    done.add(key);
    if (record.kept) {
      crossFiles += record.crossTruth.length;
      process.stdout.write(
        `kept ${cand.operator} ${cand.file}:${cand.symbol} -> ${record.crossTruth.length} cross (${crossFiles}/${TARGET})\n`,
      );
    }
  }

  const kept = readFileSync(RESULTS, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.kept);
  process.stdout.write(
    `\n${kept.length} mutations kept, ${crossFiles} cross-package truth files (target ${TARGET})\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
