/**
 * The #117 verdict of doc2query-lift, in one place for the gate and the
 * printed table. Its three reliability checks — DATA-STARVED (n<5 on the
 * OOP or NEAR slice), HOLDOUT SANITY (NEAR ≥90%: recall_when may not be
 * held out) and ARM-DIVERGENCE SANITY (≥98% identical ranks across arms:
 * the lever is not reaching retrieval) — block PROMOTE, not just print.
 */
export interface ArmRow {
  meanDeltaRank: number;
  crossedIn: number;
  nearRegression: number;
}

export interface Doc2QueryVerdictInput {
  own: ArmRow;
  foreign: ArmRow;
  near: number;
  farInPool: number;
  oop: number;
  /** Eval queries, and how many of them ranked identically in all three arms. */
  cases: number;
  identicalArms: number;
}

export interface Doc2QueryVerdict {
  ownShowsLift: boolean;
  /** null-relative NEAR rule (#129): own pays NEAR-regression no worse than the foreign null. */
  nearWithinNull: boolean;
  beatsForeignCrossed: boolean;
  beatsForeignDelta: boolean;
  nearFrac: number;
  identicalFrac: number;
  dataStarved: boolean;
  holdoutSanityFailed: boolean;
  armDivergenceSanityFailed: boolean;
  promote: boolean;
}

export function doc2queryVerdict(x: Doc2QueryVerdictInput): Doc2QueryVerdict {
  const ownShowsLift = x.own.crossedIn > 0 || x.own.meanDeltaRank < 0;
  const nearWithinNull = x.own.nearRegression <= x.foreign.nearRegression;
  const beatsForeignCrossed = x.own.crossedIn > x.foreign.crossedIn;
  const beatsForeignDelta = x.own.meanDeltaRank < x.foreign.meanDeltaRank;
  const total = x.near + x.farInPool + x.oop;
  const nearFrac = total ? x.near / total : NaN;
  const identicalFrac = x.cases ? x.identicalArms / x.cases : NaN;
  const dataStarved = x.oop < 5 || x.near < 5;
  const holdoutSanityFailed = nearFrac >= 0.9;
  const armDivergenceSanityFailed = x.cases > 0 && identicalFrac >= 0.98;
  const promote =
    ownShowsLift &&
    nearWithinNull &&
    beatsForeignCrossed &&
    beatsForeignDelta &&
    !dataStarved &&
    !holdoutSanityFailed &&
    !armDivergenceSanityFailed;
  return {
    ownShowsLift,
    nearWithinNull,
    beatsForeignCrossed,
    beatsForeignDelta,
    nearFrac,
    identicalFrac,
    dataStarved,
    holdoutSanityFailed,
    armDivergenceSanityFailed,
    promote,
  };
}
