/**
 * The selection/holdout split for design A (§18.3; C-072, C-074).
 *
 * §18.3 forbids determining the held-fixed cue configuration on the same cases
 * the comparison then runs on. This produces the two parts that keeps them
 * apart — and it stratifies, because a seed alone is not a safeguard.
 *
 * The M0 baseline measured Recall@3 per gold file between 31.3% and 84.9%, a
 * standard deviation of 21.6pp, driven almost entirely by origin: the blind
 * batch of an independently working second person is far harder than hook
 * telemetry. An unstratified draw can therefore put most of the blind cases on
 * one side and move the comparison baseline further than the effect the
 * experiment is looking for — reproducibly so, which is worse than noisily.
 *
 * Registered in `registrations/cue-experiment.json`:
 * selection_share 0.30, holdout_share 0.70, split_seed 20260828,
 * stratify_by ["origin_type", "lang"].
 *
 * The CALLER chooses the pool, and that choice moves the numbers. Design A
 * holds the cue configuration at descriptive/item, so it passes the descriptive
 * cases and gets 109/256; passing every answerable case instead yields 112/260.
 * Both are correct splits of different pools — the registered min_n_per_condition
 * of 255 is measured against the first.
 */
import type { GoldCase } from "./goldset.js";

/** Deterministic 32-bit PRNG (mulberry32) — no dependency, same draw everywhere. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SplitOptions {
  /** Registered as 20260828. Fixed BEFORE the run — a seed chosen after seeing
   *  a split is not a safeguard but a selection. */
  seed: number;
  /** Registered as 0.30. The rest becomes the holdout. */
  selectionShare: number;
  /** Case fields the split balances on. Registered as origin_type + lang. */
  stratifyBy: readonly (keyof GoldCase)[];
}

export interface StratumReport {
  key: string;
  total: number;
  selection: number;
  holdout: number;
  /**
   * Stratum keys that were merged into this one because they were too small to
   * reach both halves (#444). Absent on a stratum that stands on its own.
   */
  coalesced_from?: string[];
}

export interface SplitResult {
  selection: GoldCase[];
  holdout: GoldCase[];
  /** Per-stratum sizes, so a report can show the split actually balanced. */
  strata: StratumReport[];
  /** Cases dropped before splitting, with the reason. */
  excluded: { probes: number; no_answer: number };
}

const stratumKey = (c: GoldCase, by: readonly (keyof GoldCase)[]): string =>
  by.map((f) => String(c[f])).join("|");

/**
 * Whether a stratum of this size reaches BOTH halves.
 *
 * `round(n × share)` puts a stratum of one entirely on one side, and small
 * strata can land the same way: the factor level is then absent from selection
 * or from holdout, which is precisely the balance the stratification promised
 * (#444). The gold set has such a stratum — `user_query|en` holds a single
 * case — so this is a real configuration, not a hypothetical one.
 */
const reachesBothHalves = (n: number, share: number): boolean => {
  const take = Math.round(n * share);
  return take > 0 && take < n;
};

/**
 * The coalescing policy for strata too small to reach both halves (#444).
 *
 * Refusing them outright would make the registered split unrunnable on the real
 * gold set, and a stratum of one cannot be divided by any arithmetic. So such a
 * stratum is merged into its LARGEST sibling under the same coarser key — the
 * one field further left stays intact, which matters because origin is the
 * factor the M0 baseline showed drives the variance (21.6pp between files),
 * while `lang` is the field backed off first. Ties break by key, so nothing
 * depends on iteration order, and a stratum with no sibling backs off one more
 * field.
 *
 * The LEADING field is never backed off. Merging across its levels would fuse
 * the very factor the split exists to balance — origin, on the registered
 * configuration — and that is the unstratified draw, arrived at politely. A
 * stratum that cannot be placed without it is refused by the caller instead.
 *
 * What survives the merge is the case, not the label: the merged keys are
 * reported on the surviving stratum rather than dropped.
 */
function coalesceStrata(
  byStratum: Map<string, GoldCase[]>,
  fieldCount: number,
  share: number,
): Map<string, { cases: GoldCase[]; from: string[] }> {
  const groups = new Map<string, { cases: GoldCase[]; from: string[] }>();
  for (const [k, v] of byStratum) groups.set(k, { cases: [...v], from: [] });

  const prefixOf = (key: string, depth: number): string => key.split("|").slice(0, depth).join("|");

  for (let depth = fieldCount - 1; depth >= 1; depth--) {
    const small = [...groups.entries()]
      .filter(([, g]) => !reachesBothHalves(g.cases.length, share))
      .map(([k]) => k)
      .sort();
    if (small.length === 0) break;
    for (const key of small) {
      const g = groups.get(key);
      if (!g) continue;
      const sibling = [...groups.entries()]
        .filter(([other]) => other !== key && prefixOf(other, depth) === prefixOf(key, depth))
        .sort((a, b) => b[1].cases.length - a[1].cases.length || a[0].localeCompare(b[0]))[0];
      if (!sibling) continue;
      sibling[1].cases.push(...g.cases);
      sibling[1].from.push(key, ...g.from);
      groups.delete(key);
    }
  }
  return groups;
}

/**
 * Splits the eligible gold cases into a selection part and a holdout.
 *
 * Excluded before anything else, and reported rather than silently dropped:
 *
 *   - probes (`probe_group`) — diagnostic and noise runs are not questions
 *     anyone asked and never share a denominator with them;
 *   - `no_answer` cases — design A compares two cue GENERATION paths on
 *     Recall@3, and a case with no expected id cannot contribute a rank.
 *
 * The draw is per stratum and deterministic: same seed, same input, byte-equal
 * output. Each stratum contributes `round(n × selectionShare)` cases, so the
 * proportions hold inside every stratum rather than only in the aggregate.
 *
 * Two ways the promised balance can be defeated without an empty `stratifyBy`,
 * both closed here (#444): a named field that is constant over the eligible
 * pool is refused, and a stratum too small to reach both halves is coalesced by
 * the explicit policy in {@link coalesceStrata} rather than quietly landing on
 * one side.
 */
export function splitGoldCases(cases: readonly GoldCase[], opts: SplitOptions): SplitResult {
  if (!(opts.selectionShare > 0 && opts.selectionShare < 1)) {
    throw new Error(`selectionShare must lie strictly between 0 and 1, got ${opts.selectionShare}`);
  }
  if (opts.stratifyBy.length === 0) {
    throw new Error("stratifyBy must name at least one field — an unstratified split is a lottery with a seed");
  }

  const probes = cases.filter((c) => c.probe_group).length;
  const noAnswer = cases.filter((c) => !c.probe_group && c.no_answer).length;
  const eligible = cases.filter((c) => !c.probe_group && !c.no_answer);

  // A field that does not vary over the pool names a factor that is not there:
  // it passes the length check above and still leaves a seeded draw with
  // nothing to balance (#444). Checked on the ELIGIBLE pool, because that is
  // what gets split — a field can vary over the file and be constant here.
  if (eligible.length > 0) {
    for (const f of opts.stratifyBy) {
      const values = new Set(eligible.map((c) => String(c[f])));
      if (values.size < 2) {
        throw new Error(
          `stratifyBy field \`${String(f)}\` is constant over the eligible pool (${[...values][0]}) — `
            + "a factor that does not vary balances nothing",
        );
      }
    }
  }

  const byStratum = new Map<string, GoldCase[]>();
  for (const c of eligible) {
    const k = stratumKey(c, opts.stratifyBy);
    const slot = byStratum.get(k);
    if (slot) slot.push(c);
    else byStratum.set(k, [c]);
  }
  const groups = coalesceStrata(byStratum, opts.stratifyBy.length, opts.selectionShare);
  const stillDegenerate = [...groups.entries()]
    .filter(([, g]) => !reachesBothHalves(g.cases.length, opts.selectionShare))
    .map(([k]) => k);
  if (stillDegenerate.length) {
    throw new Error(
      `stratum ${stillDegenerate.join(", ")} cannot reach both halves even after coalescing — `
        + "the pool is too small for this split, and a seed does not fix that",
    );
  }

  const selection: GoldCase[] = [];
  const holdout: GoldCase[] = [];
  const strata: StratumReport[] = [];

  // Sorted so the iteration order does not depend on insertion order, and the
  // ids inside a stratum are sorted too: the same cases in a different file
  // order must produce the same split.
  for (const key of [...groups.keys()].sort()) {
    const merged = groups.get(key);
    const group = [...(merged?.cases ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    // One generator per stratum, seeded from the run seed and the stratum name,
    // so adding a stratum cannot reshuffle the ones beside it.
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
    const rnd = seededRandom(opts.seed ^ h);
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]];
    }
    const take = Math.round(group.length * opts.selectionShare);
    selection.push(...group.slice(0, take));
    holdout.push(...group.slice(take));
    strata.push({
      key,
      total: group.length,
      selection: take,
      holdout: group.length - take,
      ...(merged?.from.length ? { coalesced_from: [...merged.from].sort() } : {}),
    });
  }

  return { selection, holdout, strata, excluded: { probes, no_answer: noAnswer } };
}
