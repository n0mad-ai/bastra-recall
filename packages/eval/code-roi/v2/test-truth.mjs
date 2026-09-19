/**
 * Test-based truth for the miner (#582, delivered-impact measurement).
 *
 * The type-error truth (`mine-repo.mjs`) asks tsc which files carry a NEW
 * error after one file's diff is applied. It is exact, but it only exists in a
 * repository that typechecks. For a JavaScript repository there is no tsc to
 * ask, and the honest substitute is the repository's own test suite: a file is
 * affected when a test that USED TO PASS now fails, and that test reaches the
 * file.
 *
 * THE RULE (`truth_rule: "tests/v2"` — quoted verbatim in the population file):
 *
 *   Given a commit C, its parent P, and exactly one file `d` changed in C:
 *
 *   1. BASELINE. Extract P and run the whole suite. `B` = the set of test
 *      cases that PASS. A run that errors before producing results, or that
 *      exceeds the time budget, makes the candidate NOT EVALUABLE — never
 *      "breaks nothing".
 *   2. MUTATION. Apply only `d`'s diff from P to C and run the suite again.
 *      `F` = the set of test cases that FAIL.
 *   3. BROKEN. `broke = F ∩ B`. A case that already failed on P is not
 *      evidence; a case that did not exist on P is not evidence either.
 *   4. CONFIRMATION. For every test FILE with a broken case, run that file
 *      alone once on the mutated tree and once on the clean P tree. The same
 *      case must fail mutated and pass clean. This drops flaky, already-red
 *      and suite-order-only failures rather than treating one red run as
 *      causal evidence.
 *   5. TRUTH. Each surviving test FILE is itself a truth file. It is the file
 *      that demonstrably changes from passing to failing, exactly as a source
 *      file carrying a new type error is itself the type truth. The import
 *      attribution below remains diagnostic metadata only:
 *        R1 `sibling-name` — a file in T's import closure whose basename
 *           matches T's, with `.test`/`.spec` or a `test_`/`spec_` prefix
 *           stripped. The test names its subject; believe it.
 *        R2 `direct-import` — the repo-internal source files T imports
 *           DIRECTLY. The subject is what the test reaches for.
 *        R3 `closure` — T's whole transitive internal import closure. Only
 *           when T imports nothing resolvable directly (a barrel, a CLI).
 *      R1/R2/R3 MUST NOT become truth: a test importing seven sources proves
 *      that the test failed, not that all seven sources need adaptation.
 *   6. BLIND SPOT. If `d` is NOT in T's static import closure, the break
 *      travelled over something an import graph cannot see — an HTTP route, an
 *      event name, a template string, a config key. Such a break is REAL and
 *      is counted, but it is flagged (`blindSpots`) and reported separately
 *      from import/call coupling, because a graph tool cannot be expected to
 *      find it and a grep over the literal might.
 *
 * THE GRAPH IS NOT USED ANYWHERE IN HERE. The truth is built from the
 * repository's tests and from static imports parsed in this file. The tool
 * under measurement never sees the population being built, so the population
 * cannot be shaped to flatter it.
 *
 * Running the suite and reading its report is the other half, in
 * `test-runner.mjs`; this file holds the rule.
 */
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";

/** The version string stamped into every population built with these rules. */
export const TRUTH_RULE = "tests/v2";

/**
 * Freeze scenario identity AND its adjudicated truth. Hashing only
 * `(commit,file)` lets a changed truth rule silently keep the same population
 * hash even though every score target moved.
 */
export function truthPopulationHash(entries) {
  const canonical = entries.map((e) => ({
    commit: e.commit,
    file: e.file,
    truthRule: e.truthRule ?? TRUTH_RULE,
    truth: [...(e.truth ?? [])].sort(),
    brokenTests: [...(e.brokenTests ?? [])].sort(),
    blindSpots: [...(e.blindSpots ?? [])].sort(),
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const SOURCE_EXTS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"];

/** True for a test file, by the conventions all four supported runners use. */
export function isTestFile(file) {
  return (
    /(^|\/)__tests__\//.test(file) ||
    /(^|\/)tests?\//.test(file) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    /(^|\/)(test|spec)_[^/]*\.[cm]?[jt]sx?$/.test(file)
  );
}

// ─── Import graph (static, repo-internal, no tooling) ────────────

const SPECIFIER_RE =
  /(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s*|\bimport\s+|\bjest\.mock\s*\(\s*|\bvi\.mock\s*\(\s*)["']([^"']+)["']/g;

/** Every module specifier a file names, in source order and de-duplicated. */
export function specifiersOf(source) {
  const found = [];
  for (const m of source.matchAll(SPECIFIER_RE)) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/**
 * One specifier, resolved to a repo-relative file, or null when it leaves the
 * repository. Relative specifiers are probed against the extensions and the
 * `index` forms Node itself would try; a workspace package name resolves to
 * that package's directory, so a cross-package import is a real edge.
 */
export function resolveSpecifier(dir, fromFile, spec, packageNames = new Map()) {
  let base = null;
  if (spec.startsWith(".")) {
    base = resolve(dirname(join(dir, fromFile)), spec);
  } else {
    for (const [pkgDir, name] of packageNames) {
      if (spec !== name && !spec.startsWith(`${name}/`)) continue;
      const rest = spec.slice(name.length).replace(/^\//, "");
      base = rest === "" ? join(dir, pkgDir, "src", "index") : join(dir, pkgDir, rest);
      break;
    }
  }
  if (base === null) return null;

  const probes = [
    base,
    // A TypeScript ESM import names the EMITTED file: `./x.js` is `./x.ts` on
    // disk. bastra-recall writes 524 of its 530 relative imports that way, and
    // without this rewrite none of them resolves — reachability collapses to
    // almost nothing and every truth set comes out too small, silently.
    ...jsToTs(base),
    ...SOURCE_EXTS.map((e) => base + e),
    ...SOURCE_EXTS.map((e) => join(base, `index${e}`)),
  ];
  for (const p of probes) {
    try {
      if (!statSync(p).isFile()) continue;
    } catch {
      continue;
    }
    const rel = relative(dir, p);
    if (rel.startsWith("..") || rel.includes("node_modules/")) return null;
    return rel;
  }
  return null;
}

/** The TypeScript sources a `.js`/`.mjs`/`.cjs` specifier can stand for. */
function jsToTs(base) {
  const m = /\.(js|mjs|cjs|jsx)$/.exec(base);
  if (m === null) return [];
  const stem = base.slice(0, -m[0].length);
  const swap = { js: ["ts", "tsx"], mjs: ["mts"], cjs: ["cts"], jsx: ["tsx"] }[m[1]];
  return swap.map((ext) => `${stem}.${ext}`);
}

/**
 * The repo-internal files a test file reaches, with the distance at which each
 * was first seen (1 = imported directly). Bounded, because a barrel in a large
 * application otherwise pulls in the whole tree and the bound is the honest
 * statement that a closure that big attributes nothing.
 */
export function importClosure(dir, entry, { packageNames = new Map(), maxFiles = 400, maxDepth = 8 } = {}) {
  const depths = new Map();
  let frontier = [entry];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next = [];
    for (const file of frontier) {
      let source;
      try {
        source = readFileSync(join(dir, file), "utf8");
      } catch {
        continue;
      }
      for (const spec of specifiersOf(source)) {
        const target = resolveSpecifier(dir, file, spec, packageNames);
        if (target === null || depths.has(target) || target === entry) continue;
        depths.set(target, depth);
        if (depths.size >= maxFiles) return depths;
        next.push(target);
      }
    }
    frontier = next;
  }
  return depths;
}

/**
 * WHICH TESTS TO RUN for one candidate file.
 *
 * Running the whole suite per candidate is the honest default and also the
 * unaffordable one: bastra-recall's suite is ~4 min, and a mining pass costs
 * one suite run per candidate on top of the baseline. So the run is narrowed,
 * and the narrowing rule is stated here because it BOUNDS WHAT CAN BE FOUND.
 *
 * A test is selected when either holds:
 *   - REACHABILITY. The changed file lies in the test's static import closure,
 *     computed from the SOURCE (this file's own parser), never from the code
 *     graph — the population has to stay blind to the tool being measured.
 *   - LITERAL. The diff adds or removes a string literal that the test's own
 *     source also contains. This is the probe for the blind spots: a route, an
 *     event name, a template string or a config key couples two files without
 *     an import, and reachability alone can never find such a break.
 *
 * If neither yields anything, the WHOLE suite runs (`mode: "full"`) rather
 * than concluding that nothing can break.
 *
 * KNOWN BOUND, stated rather than hidden: a break that travels over a string
 * the diff did not touch, or over a value computed at runtime, is not reached
 * by either clause and is missed. That bias runs TOWARDS import coupling —
 * that is, towards what a graph tool finds — so the blind-spot share reported
 * from this population is a LOWER bound, never an upper one.
 */
export function selectTests(dir, changedFile, { testFiles, closures, diff = "" } = {}) {
  const byReach = testFiles.filter((t) => closures.get(t)?.has(changedFile) === true);
  const literals = diffLiterals(diff);
  const byLiteral =
    literals.length === 0
      ? []
      : testFiles.filter((t) => {
          if (byReach.includes(t)) return false;
          let source;
          try {
            source = readFileSync(join(dir, t), "utf8");
          } catch {
            return false;
          }
          return literals.some((lit) => source.includes(lit));
        });

  const selected = [...byReach, ...byLiteral].sort();
  if (selected.length === 0) return { files: testFiles, mode: "full", reached: 0, literals: 0 };
  return {
    files: selected,
    mode: byLiteral.length > 0 ? "targeted+literals" : "targeted",
    reached: byReach.length,
    literals: byLiteral.length,
  };
}

/**
 * String literals a diff adds or removes, long enough to be a contract rather
 * than a word. Both sides are taken: a route that DISAPPEARS breaks its caller
 * exactly as loudly as one that appears.
 */
export function diffLiterals(diff) {
  const found = new Set();
  for (const line of diff.split("\n")) {
    if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
    for (const m of line.matchAll(/["'`]([^"'`\n]{4,120})["'`]/g)) {
      const value = m[1].trim();
      // A bare identifier-ish word is not a contract; something with a path
      // separator, a dot, a dash, a colon or a space usually is.
      if (value.length >= 4 && /[/.\-: ]/.test(value)) found.add(value);
    }
  }
  return [...found];
}

/** Every test file's import closure in one tree, computed once per commit. */
export function closuresOf(dir, testFiles, { packageNames = new Map() } = {}) {
  const closures = new Map();
  for (const t of testFiles) closures.set(t, new Set(importClosure(dir, t, { packageNames }).keys()));
  return closures;
}

/**
 * Rule 5: the source files one broken test file is evidence for, and which of
 * R1/R2/R3 produced them. `changed` is excluded here rather than by the caller
 * so that the recorded rule always describes a truth set that already holds.
 */
export function attribute(dir, testFile, changed, { packageNames = new Map() } = {}) {
  const depths = importClosure(dir, testFile, { packageNames });
  const internal = [...depths.keys()].filter((f) => !isTestFile(f) && f !== changed);

  const stem = testFile
    .split("/")
    .pop()
    .replace(/\.[cm]?[jt]sx?$/, "")
    .replace(/\.(test|spec)$/, "")
    .replace(/^(test|spec)_/, "");
  const sibling = internal.filter((f) => f.split("/").pop().replace(/\.[cm]?[jt]sx?$/, "") === stem);
  if (sibling.length > 0) return { rule: "sibling-name", files: sibling.sort(), closure: depths };

  const direct = internal.filter((f) => depths.get(f) === 1);
  if (direct.length > 0) return { rule: "direct-import", files: direct.sort(), closure: depths };

  return { rule: "closure", files: internal.sort(), closure: depths };
}

/**
 * Step 5 and 6 together: the truth set for one candidate, plus the blind-spot
 * bookkeeping. `brokenFiles` are the test files that survived confirmation.
 */
export function truthFromBrokenTests(dir, brokenFiles, changed, { packageNames = new Map() } = {}) {
  const truth = new Set(brokenFiles.filter((f) => f !== changed));
  const rules = {};
  const blindSpots = [];
  for (const testFile of brokenFiles) {
    const { rule, closure } = attribute(dir, testFile, changed, { packageNames });
    rules[testFile] = rule;
    if (!closure.has(changed)) blindSpots.push(testFile);
  }
  return { truth: [...truth].sort(), rules, blindSpots: blindSpots.sort() };
}
