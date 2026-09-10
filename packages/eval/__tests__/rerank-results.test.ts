import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadRerankDecisionRegistration } from "../src/registrations.js";

/**
 * The #501 decision and the evidence under it must not drift apart.
 *
 * The reason this file exists is a real gap, not tidiness. The report cited
 * `rerank-501-gold-v2.json` as its source while that file lived only in a
 * session scratchpad, mode 0600 — so an independent reviewer could not find it,
 * and the committed record held aggregates with nothing to check them against.
 * A re-run does not repair that: the gold pass measured a LIVE vault, and two
 * runs over the same set already differed by one case at depth 30 because two
 * memories were written between them.
 *
 * So the numbers now travel twice — as the decision in `rerank-decision.json`
 * and as the evidence in `rerank-results.json`, each raw file identified by
 * sha256 — and these tests keep the two readings identical. Where the archive
 * is present they also verify the hashes against the actual bytes; where it is
 * not (CI, another machine) they check what is committed and say so, rather
 * than passing silently on an absent file.
 */

const REG_DIR = resolve(import.meta.dirname, "..", "registrations");
const results = JSON.parse(readFileSync(join(REG_DIR, "rerank-results.json"), "utf8")) as {
  archive: { directory: string };
  runs: {
    id: string;
    file: string;
    file_sha256: string;
    primary_result?: { delta: number; ci95: [number, number]; p: number; n: number; better: number; worse: number; unchanged: number };
    best_exploratory?: { delta: number; ci95: [number, number]; clears_point_threshold: boolean; ci_lower_above_zero: boolean };
    floor_effect?: { cells_differing: number; cells_total: number; by_n: Record<string, number> };
    all_rows_ci_below_zero?: boolean;
    robustness?: { weak_result: { n: number } };
  }[];
};
const decision = loadRerankDecisionRegistration() as {
  outcome: {
    recommendation: string;
    classification: string;
    primary: { delta_pp: number; ci95_pp: [number, number]; p: number; n: number; better: number; worse: number; unchanged: number };
  };
};

const gold = results.runs.find((r) => r.id === "gold-final")!;
const lme = results.runs.find((r) => r.id === "longmemeval-control")!;

const round1 = (x: number): number => Math.round(x * 1000) / 10;

test("every archived run is identified by a sha256", () => {
  assert.ok(results.runs.length >= 3);
  for (const r of results.runs) {
    assert.match(r.file_sha256, /^[0-9a-f]{64}$/, `${r.id} needs a full sha256`);
    assert.ok(r.file.endsWith(".json"), `${r.id} must name its file`);
  }
});

test("the decision's primary figures are the ones in the evidence — to the last digit", () => {
  // The registration reports percentage points, the evidence a raw ratio.
  // Comparing them at one decimal is the whole point: a drift between the two
  // readings is exactly what nobody would notice by eye.
  assert.equal(decision.outcome.primary.delta_pp, round1(gold.primary_result!.delta));
  assert.equal(decision.outcome.primary.ci95_pp[0], round1(gold.primary_result!.ci95[0]));
  assert.equal(decision.outcome.primary.ci95_pp[1], round1(gold.primary_result!.ci95[1]));
  assert.equal(decision.outcome.primary.p, gold.primary_result!.p);
  assert.equal(decision.outcome.primary.n, gold.primary_result!.n);
  assert.equal(decision.outcome.primary.better, gold.primary_result!.better);
  assert.equal(decision.outcome.primary.worse, gold.primary_result!.worse);
  assert.equal(decision.outcome.primary.unchanged, gold.primary_result!.unchanged);
});

test("the recommendation follows from the evidence rather than sitting beside it", () => {
  assert.equal(decision.outcome.recommendation, "close_501");
  assert.equal(decision.outcome.classification, "no_effect");
  // close_501 requires the primary to fail: delta below 2 pp OR the CI covering 0.
  const d = gold.primary_result!;
  assert.ok(round1(d.delta) < 2.0 || (d.ci95[0] <= 0 && d.ci95[1] >= 0), "the primary must actually fail its bar");
  // `no_effect` requires that NO arm clears delta >= 2 pp with a CI above 0.
  const b = gold.best_exploratory!;
  assert.equal(b.ci_lower_above_zero, false, "no arm may exclude zero, or the classification would be wrong");
});

test("the best exploratory arm clears the point threshold and fails on the interval — both recorded", () => {
  // An earlier report claimed it failed on BOTH, which overstated the margin in
  // our own favour. The evidence file has to keep that distinction visible.
  const b = gold.best_exploratory!;
  assert.equal(b.clears_point_threshold, true);
  assert.equal(b.ci_lower_above_zero, false);
  assert.ok(b.ci95[0] < 0 && b.ci95[1] > 0, "its interval must straddle zero");
});

test("the floor effect is recorded with its N breakdown, not as a single claim", () => {
  const f = gold.floor_effect!;
  assert.equal(f.cells_total, 36);
  assert.equal(f.cells_differing, 17);
  assert.equal(f.by_n["10"], 0, "the claim 'the floor never bites' holds ONLY at N=10");
  assert.ok(f.by_n["20"] > 0 && f.by_n["30"] > 0, "and fails at deeper N, which is the finding");
});

test("the control set is recorded as harmful and as carrying no recommendation", () => {
  assert.equal(lme.all_rows_ci_below_zero, true);
  assert.match(lme.role, /CONTROL FIGURE/);
  assert.match(lme.role, /no recommendation/);
});

test("weak_result fired on nothing, and that is written down rather than left out", () => {
  assert.equal(gold.robustness!.weak_result.n, 0);
});

test("the archived files match their recorded hashes", { skip: !existsSync(join(homedir(), ".bastra", "rerank-501-runs", "2026-09-09")) }, () => {
  const dir = join(homedir(), ".bastra", "rerank-501-runs", "2026-09-09");
  for (const r of results.runs) {
    const p = join(dir, r.file);
    assert.ok(existsSync(p), `${r.file} is missing from the archive`);
    const actual = execFileSync("shasum", ["-a", "256", p], { encoding: "utf8" }).split(" ")[0];
    assert.equal(actual, r.file_sha256, `${r.file} does not match its recorded hash`);
  }
});
