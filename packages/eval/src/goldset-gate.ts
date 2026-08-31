/**
 * The §18.2 component gates, measured on the gold set (#422).
 *
 * §18.2 lists seven "vorläufige Komponenten-Schaltgates für den
 * Evidenzentscheid". This module computes them; it does NOT decide whether they
 * pass. Two of the seven — "kein relevanter Recall@3-Verlust" and the same for
 * identifier queries — have no registered threshold, and `m1-tolerances.json`
 * is explicit about what inventing one would be worth: "an unmeasured tolerance
 * is a guess whether or not it sits in a versioned file". So the run reports
 * numbers, a later registration turns them into gates, and nothing here claims
 * a verdict.
 *
 * Three of the seven are INVARIANTS of the predicate rather than properties of
 * a corpus: a `required` must rest on a hard anchor or independent signals, a
 * derived cue must not carry one on its own, and neither must a graph hop. They
 * are unit-tested directly against `decideHit` in
 * `packages/eval/__tests__/evidence-gate-invariants.test.ts` — a test there
 * fails without a measurement run. What this module adds is the corpus side:
 * how often each invariant is even exercised, and by how much.
 *
 * The decision itself is never recomputed here. It comes from `decideHits` in
 * core, called the way the daemon calls it, so the measurement describes the
 * predicate that ships.
 */
import { MIN_TRIGGER_COVERAGE, type RecallDecisionHit } from "@bastra-recall/core";

/** What the gated arm produced for one case. Compact on purpose — a full
 *  `RecallEvidence` per hit would multiply the artifact by its nine fields. */
export interface CaseGateResult {
  /** 1-based rank of the first expected id among the hits the gate KEPT. */
  rank_expected: number;
  /** Same for expected ∪ acceptable. */
  rank_any: number;
  required: number;
  optional: number;
  no_answer: number;
  /**
   * `required` hits resting on neither an exact identifier nor full
   * `recall_when` coverage — they cleared the bar through the two-of-three
   * rule. §18.2 says required needs "harten Anker ODER unabhängige
   * Arm-Evidenz", and the predicate reads the second half more broadly than
   * "both arms agreed". Counted so the gap is visible rather than argued.
   */
  required_without_hard_anchor: number;
  /**
   * `required` hits with no hand-written trigger match and no exact identifier
   * — everything they have came from elsewhere (arm agreement, scope). The
   * §18.2 rule is that a DERIVED CUE alone must not produce `required`;
   * `recall_when_coverage` counts only hand-written triggers by construction,
   * so this is the population where that rule does any work.
   */
  required_without_trigger: number;
  /** `required` reached only via a graph hop. Structurally impossible — the
   *  predicate excludes `hop === "1-hop"` before it can say required (C-046).
   *  Counted anyway: a number other than zero is a defect in the predicate. */
  required_hop_only: number;
}

/**
 * Score one case's served pool through the gate.
 *
 * `served` and `decisions` are positionally aligned — `decideHits` maps the
 * list without reordering it, and the ranks below depend on that.
 */
export function gateCase(
  served: { id: string; hop?: string }[],
  decisions: RecallDecisionHit[],
  expected: Set<string>,
  any: Set<string>,
): CaseGateResult {
  const kept: string[] = [];
  const out: CaseGateResult = {
    rank_expected: 0,
    rank_any: 0,
    required: 0,
    optional: 0,
    no_answer: 0,
    required_without_hard_anchor: 0,
    required_without_trigger: 0,
    required_hop_only: 0,
  };

  decisions.forEach((d, i) => {
    out[d.decision]++;
    if (d.decision !== "no_answer") kept.push(d.id);
    if (d.decision !== "required") return;
    const e = d.evidence;
    if (!e.exact_identifier && e.recall_when_coverage < 1) out.required_without_hard_anchor++;
    if (!e.exact_identifier && e.recall_when_coverage === 0) out.required_without_trigger++;
    if (served[i]?.hop === "1-hop") out.required_hop_only++;
  });

  out.rank_expected = kept.findIndex((id) => expected.has(id)) + 1;
  out.rank_any = kept.findIndex((id) => any.has(id)) + 1;
  return out;
}

/** One row's worth of what the report needs. Mirrors `CaseResult`. */
export interface GateRow {
  no_answer: boolean;
  probe_group?: string;
  has_identifier: boolean;
  /** Ungated rank, as the run measured it. */
  rank_expected: number;
  gate?: CaseGateResult;
  /** The same case under the anchor variant — see {@link gateVariants}. */
  gate_no_body?: CaseGateResult;
  /** …and under each candidate narrowing of the two-of-three rule. */
  gate_narrowed?: Record<string, CaseGateResult>;
}

const ratio = (n: number, d: number): number => (d === 0 ? 0 : Number((n / d).toFixed(4)));
const hitAt = (rank: number, k: number): boolean => rank >= 1 && rank <= k;

export interface ComponentGateReport {
  /**
   * §18.2: "Anti-Query-Fehlinjektionen < 5 %" — the threshold IS registered.
   *
   * Read the population before the number. `gibberish-probe` holds two kinds:
   * keyboard mash with no real word in it, and invented strings that still
   * carry one ("xqzzy frobnicate wombat telemetry"). The predicate abstains on
   * the first kind and can reach `required` on the second, through the real
   * term. Whether the second kind is an anti-query at all is a definition
   * question §18.2 does not settle, and this field does not settle it either —
   * it reports the rate over everything labelled a nonsense probe.
   */
  anti_query_injection: { value: number; count: string; threshold: 0.05; within: boolean };
  /** §18.2: "kein relevanter Recall@3-Verlust gegenüber demselben ungegateten
   *  Retrieval-Arm". No registered threshold — reported, not judged. */
  recall_at_3: { ungated: number; gated: number; delta: number; n: number };
  /** §18.2: "kein relevanter Verlust bei Identifier-Queries". Same. */
  recall_at_3_identifier_queries: { ungated: number; gated: number; delta: number; n: number };
  /** §18.2: "Falsch-Abstention bleibt unter der in M0 festgelegten Toleranz"
   *  — 0.015 on `weak_result` in m1-tolerances v4. Here: answerable cases the
   *  gate left with nothing at all. */
  false_abstention: { value: number; count: string; tolerance: 0.015; within: boolean };
  /** The three invariants, as corpus counts. Non-zero is a finding. */
  invariants: {
    required_hop_only: number;
    required_without_trigger: number;
    required_without_hard_anchor: number;
    $comment: string;
  };
  decisions: { required: number; optional: number; no_answer: number };
  $comment: string;
}

/**
 * The seven §18.2 figures over a scored run.
 *
 * Denominators follow the run's own conventions: probes never enter the main
 * ones, and the anti-query rate is measured ON the probes, which is what they
 * are for.
 */
export function componentGates(rows: GateRow[]): ComponentGateReport {
  const gated = rows.filter((r) => r.gate);
  const answerable = gated.filter((r) => !r.probe_group && !r.no_answer);
  const identifierQueries = answerable.filter((r) => r.has_identifier);

  // An anti-query is a NONSENSE query — `gibberish-probe`, keyboard mash and
  // invented words, authored so retrieval has to abstain. The other two probe
  // groups are not anti-queries: `body-loss` and `unique-n` are diagnostic runs
  // with real targets, and counting them here would measure the wrong thing in
  // the friendlier direction.
  const antiQueries = gated.filter((r) => r.probe_group === "gibberish-probe");
  const injected = antiQueries.filter((r) => (r.gate?.required ?? 0) > 0).length;
  const injection = ratio(injected, antiQueries.length);

  const at3 = (rs: GateRow[]): { ungated: number; gated: number; delta: number; n: number } => {
    const u = ratio(rs.filter((r) => hitAt(r.rank_expected, 3)).length, rs.length);
    const g = ratio(rs.filter((r) => hitAt(r.gate?.rank_expected ?? 0, 3)).length, rs.length);
    return { ungated: u, gated: g, delta: Number((g - u).toFixed(4)), n: rs.length };
  };

  // The gate abstained on everything it was given, on a case that has an answer.
  const abstained = answerable.filter((r) => (r.gate?.required ?? 0) + (r.gate?.optional ?? 0) === 0).length;
  const falseAbstention = ratio(abstained, answerable.length);

  const sum = (pick: (g: CaseGateResult) => number): number =>
    gated.reduce((a, r) => a + (r.gate ? pick(r.gate) : 0), 0);

  return {
    anti_query_injection: {
      value: injection,
      count: `${injected}/${antiQueries.length}`,
      threshold: 0.05,
      within: injection < 0.05,
    },
    recall_at_3: at3(answerable),
    recall_at_3_identifier_queries: at3(identifierQueries),
    false_abstention: {
      value: falseAbstention,
      count: `${abstained}/${answerable.length}`,
      tolerance: 0.015,
      within: falseAbstention <= 0.015,
    },
    invariants: {
      required_hop_only: sum((g) => g.required_hop_only),
      required_without_trigger: sum((g) => g.required_without_trigger),
      required_without_hard_anchor: sum((g) => g.required_without_hard_anchor),
      $comment:
        "required_hop_only must be 0 — the predicate excludes a 1-hop hit before it can say required (C-046). "
        + "The other two are populations, not defects: they say how many `required` rest on the two-of-three "
        + "rule rather than on a hard anchor, which is where §18.2's 'harter Anker ODER unabhängige "
        + "Arm-Evidenz' is read more broadly than the words alone suggest.",
    },
    decisions: {
      required: sum((g) => g.required),
      optional: sum((g) => g.optional),
      no_answer: sum((g) => g.no_answer),
    },
    $comment:
      "MEASUREMENT, not a verdict. Two of the seven §18.2 gates ('kein relevanter Verlust') carry no registered "
      + "threshold, so `recall_at_3` and `recall_at_3_identifier_queries` report a delta and nothing else. "
      + "The two that do carry one report `within`. Deriving the missing thresholds is a separate, deliberate "
      + "step — see m1-tolerances.json on what an unmeasured tolerance is worth.",
  };
}

/**
 * The two anchor readings, side by side (§10.3, the E decision).
 *
 * `hasExactIdentifier` searches the memory's TITLE, its `recall_when` and its
 * BODY. A query term shaped like an identifier that appears anywhere in flowing
 * prose therefore counts as a hard anchor, and a hard anchor alone carries
 * `required` — the A1 pattern of the divergence classification. Daniel's
 * decision is to narrow the anchor to title / recall_when / frontmatter, and to
 * put a number on it first.
 *
 * The counterfactual needs no second implementation and no change to the
 * predicate. `m.body` is read in exactly ONE place in `evidence-decision.ts`,
 * the identifier haystack; `temporalStatus` reads `obsolete`/`valid_until` and
 * `recallWhenCoverage` reads `recall_when`. So calling the SHIPPED `decideHits`
 * with a memory whose body is empty changes `exact_identifier` and nothing
 * else. The variant is therefore the real predicate answering a different
 * question, not a reimplementation of it that could drift.
 *
 * Both reports are computed by the same `componentGates`, so the seven figures
 * mean the same thing on both sides.
 */
export interface GateVariantReport {
  current: ComponentGateReport;
  anchor_without_body: ComponentGateReport;
  /** Every candidate rule side by side — see {@link variantTable}. */
  variants?: ReturnType<typeof variantTable>;
  delta: {
    /** How many hits stop being a duty when the body no longer anchors. */
    required: number;
    /** …and where they go. */
    optional: number;
    no_answer: number;
    /** The two figures a narrowing could cost something. */
    recall_at_3_gated: number;
    false_abstention: number;
    /** The figure it is meant to buy. */
    anti_query_injection: number;
    $comment: string;
  };
  $comment: string;
}

export function gateVariants(rows: GateRow[]): GateVariantReport {
  const current = componentGates(rows);
  const withoutBody = componentGates(
    rows.map((r) => ({ ...r, gate: r.gate_no_body })),
  );
  const d = (a: number, b: number): number => Number((b - a).toFixed(4));
  return {
    current,
    anchor_without_body: withoutBody,
    ...(rows.some((r) => r.gate_narrowed) ? { variants: variantTable(rows) } : {}),
    delta: {
      required: withoutBody.decisions.required - current.decisions.required,
      optional: withoutBody.decisions.optional - current.decisions.optional,
      no_answer: withoutBody.decisions.no_answer - current.decisions.no_answer,
      recall_at_3_gated: d(current.recall_at_3.gated, withoutBody.recall_at_3.gated),
      false_abstention: d(current.false_abstention.value, withoutBody.false_abstention.value),
      anti_query_injection: d(current.anti_query_injection.value, withoutBody.anti_query_injection.value),
      $comment:
        "Negative means the variant is lower. A narrowed anchor should cost `required` and buy "
        + "`anti_query_injection`; what it must NOT cost is recall_at_3_gated and false_abstention, and "
        + "those two are the price this measurement exists to name.",
    },
    $comment:
      "MEASUREMENT of a counterfactual, taken before any change to the predicate (§10.3). `anchor_without_body` "
      + "is the shipped `decideHits` called with an empty memory body — the only field the identifier haystack "
      + "reads beyond title and recall_when. Nothing here changes what the daemon does.",
  };
}

/**
 * A candidate narrowing of the two-of-three rule (§10.3, #422).
 *
 * The E variant could be measured by taking an INPUT away — blank the body and
 * the shipped predicate answers a different question by itself. This family
 * cannot: "partial coverage counts only from 0.5" is not a missing input, it is
 * a different combination rule, and no argument to `decideHit` expresses it.
 *
 * So the rule is re-derived here from the evidence the SHIPPED `collectEvidence`
 * produced — the features stay the product's, only their combination is varied.
 * That is a drift risk, and {@link assertReproducesShipped} is the answer to it:
 * with the identity rule the re-derivation must reproduce `decideHit`'s output
 * for every hit of the run, and the runner fails loudly if it ever does not.
 * A variant family whose baseline does not reproduce measures nothing.
 */
export interface NarrowingRule {
  /** Partial trigger coverage counts as a signal only from here. 0 = today
   *  ("any shared term at all"). */
  minCoverage?: number;
  /** …or, absolutely: at least this many query terms must have matched the
   *  hand-written trigger. Needs the case's term count. 0 = today. */
  minMatchedTerms?: number;
}

/**
 * Today's rule — the identity of the family.
 *
 * Carries `MIN_TRIGGER_COVERAGE` from core rather than a literal: the §10.3
 * narrowing landed IN the predicate on 2026-08-29, so the identity moved with
 * it. A hard-coded 0 here would make `assertReproducesShipped` fail on every
 * hit whose coverage sits between 0 and the threshold — the exact population
 * the change was about.
 */
export const CURRENT_RULE: NarrowingRule = { minCoverage: MIN_TRIGGER_COVERAGE };

/**
 * `decideHit`'s decision, re-derived from evidence (§10.3 variants).
 *
 * Mirrors `packages/core/src/evidence-decision.ts` exactly at the identity
 * rule: the two blocks (`stale`, `hopOnly`), the hard anchor, the two-of-three
 * count, and the `anySignal` fallback. `anySignal` is deliberately NOT narrowed
 * with the rule: the tightening is about what earns a DUTY, not about whether
 * anything was found at all, and folding it in would move cases to `no_answer`
 * for a reason nobody asked for.
 */
export function redecide(
  evidence: RecallDecisionHit["evidence"],
  hop: string | undefined,
  termCount: number,
  rule: NarrowingRule = CURRENT_RULE,
): RecallDecisionHit["decision"] {
  const stale = evidence.temporal_status === "expired" || evidence.temporal_status === "obsolete";
  const hopOnly = hop === "1-hop";
  const hardAnchor = evidence.exact_identifier || evidence.recall_when_coverage >= 1;

  const cov = evidence.recall_when_coverage;
  const matched = Math.round(cov * termCount);
  const coverageCounts =
    cov > 0
    && cov >= (rule.minCoverage ?? 0)
    && matched >= (rule.minMatchedTerms ?? 0);

  const independent = [coverageCounts, evidence.arm_agreement, evidence.scope_match].filter(Boolean).length;
  if (!stale && !hopOnly && (hardAnchor || independent >= 2)) return "required";

  const anySignal = cov > 0 || evidence.arm_agreement || evidence.scope_match || evidence.exact_identifier;
  return anySignal ? "optional" : "no_answer";
}

/**
 * The guarantee the whole variant family rests on.
 *
 * Throws when the re-derivation and the shipped predicate disagree on a single
 * hit at the identity rule. Called per case in the runner, so a divergence
 * stops the measurement instead of quietly skewing one column of it.
 */
export function assertReproducesShipped(
  decisions: RecallDecisionHit[],
  served: { hop?: string }[],
  termCount: number,
): void {
  decisions.forEach((d, i) => {
    const mine = redecide(d.evidence, served[i]?.hop, termCount, CURRENT_RULE);
    if (mine !== d.decision) {
      throw new Error(
        `variant re-derivation drifted from decideHit on ${d.id}: shipped ${d.decision}, re-derived ${mine}. `
          + "The narrowing measurements are only meaningful while these agree.",
      );
    }
  });
}

/** Score one case under a narrowing, from the shipped evidence. */
export function gateCaseUnder(
  served: { id: string; hop?: string }[],
  decisions: RecallDecisionHit[],
  expected: Set<string>,
  any: Set<string>,
  termCount: number,
  rule: NarrowingRule,
): CaseGateResult {
  const varied: RecallDecisionHit[] = decisions.map((d, i) => ({
    ...d,
    decision: redecide(d.evidence, served[i]?.hop, termCount, rule),
  }));
  return gateCase(served, varied, expected, any);
}

/**
 * The candidates §10.3 asks to be priced (#422).
 *
 * Two readings of "partial coverage is too cheap today", because they are not
 * the same claim: a RELATIVE floor asks what share of the question the trigger
 * answered, an ABSOLUTE one asks how many terms it actually matched. On a
 * three-word query they coincide; on a fifteen-word one they are far apart, and
 * the gold set holds both shapes.
 */
export const NARROWINGS: Record<string, NarrowingRule> = {
  /**
   * Two matched terms on top of the coverage floor — the candidate that was
   * measured beside `coverage>=0.5` and lost: it takes 74 % of the duties on
   * short queries and only 12 % on long ones, and the long keyword chains are
   * where a single shared term is weakest. Kept as a variant, not adopted.
   */
  "matched>=2": { minCoverage: MIN_TRIGGER_COVERAGE, minMatchedTerms: 2 },
  /** The next step up, unmeasured until someone asks for it. */
  "coverage>=0.75": { minCoverage: 0.75 },
};

/** One row of the comparison table: a variant, its seven figures, its shift. */
export interface VariantRow {
  variant: string;
  anti_query_injection: number;
  anti_query_count: string;
  recall_at_3_gated: number;
  recall_at_3_identifier: number;
  false_abstention: number;
  required: number;
  optional: number;
  no_answer: number;
  required_delta_vs_current: number;
  required_without_hard_anchor: number;
}

/**
 * Every variant against the current predicate, in one table (§10.3, #422).
 *
 * The point of putting them side by side rather than in separate runs: they are
 * measured on the SAME served pools, so a difference between two rows is the
 * rule and nothing else — not a re-run, not a grown vault, not a reshuffled
 * ranking.
 */
export function variantTable(rows: GateRow[]): { table: VariantRow[]; $comment: string } {
  const names = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.gate_narrowed ?? {})) names.add(k);

  const asRow = (variant: string, pick: (r: GateRow) => CaseGateResult | undefined): VariantRow => {
    const g = componentGates(rows.map((r) => ({ ...r, gate: pick(r) })));
    return {
      variant,
      anti_query_injection: g.anti_query_injection.value,
      anti_query_count: g.anti_query_injection.count,
      recall_at_3_gated: g.recall_at_3.gated,
      recall_at_3_identifier: g.recall_at_3_identifier_queries.gated,
      false_abstention: g.false_abstention.value,
      required: g.decisions.required,
      optional: g.decisions.optional,
      no_answer: g.decisions.no_answer,
      required_delta_vs_current: 0,
      required_without_hard_anchor: g.invariants.required_without_hard_anchor,
    };
  };

  const table = [
    asRow("current", (r) => r.gate),
    asRow("no_body", (r) => r.gate_no_body),
    ...[...names].sort().map((n) => asRow(n, (r) => r.gate_narrowed?.[n])),
  ];
  const base = table[0].required;
  for (const row of table) row.required_delta_vs_current = row.required - base;

  return {
    table,
    $comment:
      "All variants scored on the SAME served pools, so a difference between two rows is the rule alone. "
      + "`no_body` is the §10.3 anchor narrowing (an input taken away from the shipped predicate); the "
      + "`coverage>=` and `matched>=` rows re-derive the two-of-three combination from the shipped evidence, "
      + "guarded by a per-case assertion that the re-derivation reproduces `decideHit` at the identity rule. "
      + "Rows ending in `+no_body` are the combination of both.",
  };
}
