/**
 * Turn the miner's accepted candidates into the run's scenario file (#588).
 *
 * Assigns ids in mining order and the arm order per scenario from the
 * registered seed, BEFORE any arm runs. Adjudication happens on the written
 * file: a truth entry is removed only with a reason in `adjudication`, and a
 * whole scenario only with `excluded: "<reason>"` — both visible in the
 * archive, never silent.
 *
 * Refuses to overwrite a scenario file once any arm has run, so the selection
 * cannot be redone after looking at results.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// CODE_ROI_OUT: a pilot directory, so a plumbing check never touches the real archive.
const OUT = process.env.CODE_ROI_OUT ?? join(homedir(), ".bastra", "eval", "code-roi-v2");
const SEED = 20260918; // registration: statistics.seed, reused for the arm order

/** mulberry32 — small, seedable, and stable across Node versions. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function main() {
  const runs = join(OUT, "runs");
  if (existsSync(runs) && readdirSync(runs).some((d) => existsSync(join(runs, d, "control.jsonl")) || existsSync(join(runs, d, "treatment.jsonl")))) {
    throw new Error("arms have already run — the scenario file is frozen");
  }
  const accepted = readFileSync(join(OUT, "candidates.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((c) => c.accepted);
  const next = rng(SEED);
  const scenarios = accepted.map((c, i) => ({
    id: `S${String(i + 1).padStart(2, "0")}`,
    commit: c.commit,
    parent: c.parent,
    file: c.file,
    subject: c.subject,
    diff: c.diff,
    truth: c.truth,
    adjudication: [],
    armOrder: next() < 0.5 ? ["control", "treatment"] : ["treatment", "control"],
  }));
  writeFileSync(
    join(OUT, "scenarios.json"),
    JSON.stringify({ registration_version: 2, seed: SEED, range_end: "5483f56", scenarios }, null, 2),
  );
  process.stdout.write(`${scenarios.length} scenarios written\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
