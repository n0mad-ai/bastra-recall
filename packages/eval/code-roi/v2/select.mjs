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

/**
 * The pooled sample: candidates from several repositories, drawn in the
 * REGISTERED repository order, each repository capped (#582, registration 5).
 *
 * No single local repository supplies 40 scenarios with a usable share of
 * cross-package breaks, so the sample is pooled — and the two things that
 * could turn pooling into a way of choosing a result are fixed in the
 * registration rather than here: the order the repositories are drawn in, and
 * the cap that stops one of them from carrying the whole sample. Within a
 * repository, candidates keep their mining (walk) order, so a cap cuts the
 * tail and never picks among scenarios.
 *
 * @param byRepo  Map of repo path -> accepted candidates, in walk order
 * @param order   the registered repository order
 * @param cap     the registered per-repository maximum
 * @param target  min_scenarios; drawing stops once it is reached
 */
export function pooledCandidates(byRepo, order, cap, target) {
  const pooled = [];
  const takenPerRepo = new Map();
  // Repositories not named in the registration are never drawn from: an
  // unlisted repository in the archive is a mistake, not a silent addition.
  for (const repo of order) {
    if (pooled.length >= target) break;
    const room = Math.min(cap, target - pooled.length);
    const take = (byRepo.get(repo) ?? []).slice(0, room);
    takenPerRepo.set(repo, take.length);
    pooled.push(...take);
  }
  return { pooled, takenPerRepo };
}

/**
 * One scenario per FILE, and a file is identified by repo AND path: the same
 * path in two repositories is two different files.
 */
export function fileKey(candidate) {
  return `${candidate.repo ?? ""}\u0000${candidate.file}`;
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
  const afterPilot = accepted.filter((c) => !excluded.has(c.commit));
  const dropped = accepted.length - afterPilot.length;

  // One scenario per file, across the pool.
  const seenFiles = new Set();
  const unique = afterPilot.filter((c) => {
    const key = fileKey(c);
    if (seenFiles.has(key)) return false;
    seenFiles.add(key);
    return true;
  });

  const pooling = REGISTRATION?.sample?.pooling ?? {};
  const byRepo = new Map();
  for (const c of unique) {
    const repo = c.repo ?? REGISTRATION?.population?.repository_path ?? "";
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo).push(c);
  }
  const order = pooling.allowed === true ? (pooling.repo_order ?? [...byRepo.keys()]) : [...byRepo.keys()].slice(0, 1);
  const target = REGISTRATION?.sample?.min_scenarios ?? unique.length;
  // The cap bounds one repository's share OF A POOL. When the first repository
  // alone reaches the minimum there is no pool, so there is nothing to bound —
  // capping there would shrink a sufficient sample into an underpowered one.
  const firstRepoAlone = (byRepo.get(order[0]) ?? []).length;
  const pooled = pooling.allowed === true && firstRepoAlone < target;
  const cap = pooled ? (pooling.per_repo_cap ?? Infinity) : Infinity;
  // Draw a little past the minimum so hand adjudication has room to remove.
  const { pooled: drawn, takenPerRepo } = pooledCandidates(
    byRepo,
    pooled ? order : order.slice(0, 1),
    cap,
    Math.ceil(target * 1.125),
  );
  const kept = drawn;
  const next = rng(SEED);
  const scenarios = kept.map((c, i) => ({
    id: `S${String(i + 1).padStart(2, "0")}`,
    // The repository each scenario belongs to. Carried per scenario, not per
    // file: a sample may one day pool two repositories, and a scenario that
    // does not know its own repo cannot be re-run or re-scored.
    repo: c.repo ?? null,
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
        registration_version: REGISTRATION?.registration_version ?? 5,
        seed: SEED,
        range_end: process.env.CODE_ROI_RANGE_END ?? null,
        arms: ARM_IDS,
        repos: Object.fromEntries(takenPerRepo),
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
  for (const [repo, n] of takenPerRepo) {
    process.stdout.write(`  ${n} from ${repo}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
