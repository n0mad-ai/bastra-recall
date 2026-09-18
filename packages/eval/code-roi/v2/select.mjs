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
 *
 * ARM NAMES ARE THE ONES THE RUNNER KNOWS. This wrote `control`/`treatment`
 * long after the runner moved to three arms A/B/prefilled, and `run-arms-v3`
 * skipped every unknown value in silence — a full sample would have produced
 * no run at all and no error (#582). The names now come from `ARM_IDS`, and
 * the runner refuses an unknown one loudly.
 *
 * Usage: CODE_ROI_OUT=<dir> node select.mjs [--arms A,B,prefilled]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writableOut } from "./archive.mjs";

/**
 * The pilot commits the registration excludes. Read from the registration
 * rather than repeated here, so the two cannot drift; a scenario from one of
 * them would be a scenario the tooling was already tuned against.
 */
export function excludedPilotCommits(reg = REGISTRATION) {
  return new Set(reg?.sample?.excluded_pilot?.commits ?? []);
}

const REGISTRATION = JSON.parse(
  readFileSync(new URL("../../registrations/code-awareness-change-impact.json", import.meta.url), "utf8"),
);
const OUT = writableOut();
const SEED = Number(process.env.CODE_ROI_SEED ?? 20260918); // registration: statistics.seed

/** The arms a scenario is run through, in the order the runner understands. */
export const ARM_IDS = ["A", "B", "prefilled"];

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

/** Fisher-Yates on a copy, from the registered seed. */
export function shuffled(items, next) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function main() {
  const runs = join(OUT, "runs");
  const ranAlready = (d) =>
    [...ARM_IDS, "control", "treatment"].some((arm) => existsSync(join(runs, d, `${arm}.jsonl`)));
  if (existsSync(runs) && readdirSync(runs).some(ranAlready)) {
    throw new Error("arms have already run — the scenario file is frozen");
  }
  const accepted = readFileSync(join(OUT, "candidates.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((c) => c.accepted);
  // Pilot scenarios never enter a registered sample.
  const excluded = excludedPilotCommits();
  const kept = accepted.filter((c) => !excluded.has(c.commit));
  const dropped = accepted.length - kept.length;
  const next = rng(SEED);
  const scenarios = kept.map((c, i) => ({
    id: `S${String(i + 1).padStart(2, "0")}`,
    commit: c.commit,
    parent: c.parent,
    file: c.file,
    subject: c.subject,
    diff: c.diff,
    truth: c.truth,
    adjudication: [],
    armOrder: shuffled(ARM_IDS, next),
  }));
  writeFileSync(
    join(OUT, "scenarios.json"),
    JSON.stringify(
      {
        registration_version: 4,
        seed: SEED,
        range_end: process.env.CODE_ROI_RANGE_END ?? null,
        arms: ARM_IDS,
        scenarios,
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `${scenarios.length} scenarios written` +
      (dropped > 0 ? ` (${dropped} dropped: pilot commits, excluded by the registration)` : "") +
      "\n",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
