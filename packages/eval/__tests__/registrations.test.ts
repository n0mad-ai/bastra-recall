/**
 * The M0 registration duties, checked (#261; C-029, C-040, C-072, C-074).
 *
 * These two gate conditions are discipline, and discipline that only lives in
 * a document holds until the first deadline. The tests below are the reason it
 * holds afterwards.
 *
 * Run: npx tsx --test packages/eval/__tests__/registrations.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkCueRegistration,
  checkForeignFigures,
  loadCueRegistration,
  loadForeignFigures,
  rankingBlocker,
  EVIDENCE_CLASSES,
  type ForeignFigure,
  checkPresentationRegistration,
  loadPresentationRegistration,
} from "../src/registrations.js";

const base: ForeignFigure = {
  id: "x", system: "X", claim: "1%", evidence_class: "peer_reviewed",
  source: "doi:10.0/x", version: "v1", locus: "Table 1", retrieved: "2026-07-25",
  reader: "gpt-4o", judge: "gpt-4o", top_k: "10", context_budget: "128k",
};

test("the committed foreign-figure registry passes its own rules", () => {
  const issues = checkForeignFigures();
  assert.deepEqual(issues, [], `registry violates §29.1: ${JSON.stringify(issues, null, 2)}`);

  const figures = loadForeignFigures();
  assert.ok(figures.length >= 19, "every measurement checked in §29.3 is carried");
  for (const f of figures) {
    assert.ok(EVIDENCE_CLASSES.includes(f.evidence_class), `${f.id} has a real evidence class`);
  }
});

test("a figure without an evidence class or a citation field is rejected", () => {
  const noClass = { ...base, evidence_class: "vibes" as unknown as ForeignFigure["evidence_class"] };
  assert.ok(checkForeignFigures([noClass]).some((i) => /evidence classes/.test(i.problem)));

  const noLocus = { ...base, locus: "" };
  assert.ok(checkForeignFigures([noLocus]).some((i) => /locus/.test(i.problem)));

  // An omitted configuration field is indistinguishable from an unchecked one,
  // so it is an error — while an explicit null is a finding and fine.
  const omitted = { ...base } as Partial<ForeignFigure>;
  delete omitted.judge;
  assert.ok(checkForeignFigures([omitted as ForeignFigure]).some((i) => /`judge` is absent/.test(i.problem)));
  assert.deepEqual(checkForeignFigures([{ ...base, judge: null }]), []);
});

test("unknown configuration blocks a shared ranking — it never counts as a match", () => {
  assert.equal(rankingBlocker(base, { ...base, id: "y" }), null, "fully stated and equal ranks together");

  assert.match(
    rankingBlocker(base, { ...base, id: "y", top_k: "200" }) ?? "",
    /`top_k` differs/,
    "Top 50 and Top 200 are two retrieval depths, not one ranking",
  );
  assert.match(
    rankingBlocker(base, { ...base, id: "y", judge: null }) ?? "",
    /does not state `judge`/,
    "an unstated judge cannot be asserted to match",
  );
});

test("the real registry is mostly unrankable, and that is the finding", () => {
  const figures = loadForeignFigures();
  const zep = figures.find((f) => f.id === "zep-locomo-longmemeval");
  const mem0 = figures.find((f) => f.id === "mem0-locomo");
  assert.ok(zep && mem0);

  assert.ok(rankingBlocker(zep, mem0), "the two headline vendor numbers may not share a ranking");

  // §29.3: of nineteen measurements, three name all four quantities. So almost
  // no pair is comparable — the check should say so rather than quietly allow it.
  const pairs = figures.length * (figures.length - 1) / 2;
  let blocked = 0;
  for (let i = 0; i < figures.length; i++) {
    for (let j = i + 1; j < figures.length; j++) if (rankingBlocker(figures[i], figures[j])) blocked++;
  }
  assert.ok(blocked / pairs > 0.9, `expected nearly every pair blocked, got ${blocked}/${pairs}`);
});

test("the committed cue registration is on the associative axis and does NOT clear an M2 run", () => {
  const reg = loadCueRegistration();
  // v3: the held-fixed configuration moved to associative/item after the OB
  // pre-question found the descriptive family moves nothing, and the status
  // dropped back with it — the numbers were derived on a 98%-descriptive pool.
  assert.equal(reg.status, "structure_registered");
  assert.equal(reg.design, "A");

  const a = (reg.admissible_designs as Record<string, Record<string, unknown>>).A;
  assert.deepEqual(a.fixed_cue_configuration, {
    descriptive_associative: "associative",
    item_scene: "item",
    cue_family: "associative_bridge",
  });
  const guard = a.contamination_guard as Record<string, unknown>;
  assert.equal(guard.mode, "selection_holdout_split");
  assert.equal((guard.selection_share as number) + (guard.holdout_share as number), 1);
  assert.deepEqual(guard.stratify_by, ["origin_type", "lang"]);
  assert.equal(a.interaction_evaluated, false);

  // M0's gate still passes — the structure is registered and unchanged.
  assert.deepEqual(checkCueRegistration("structure_registered", reg), []);
  // M2's does not, and that is the point of v3 rather than an oversight.
  assert.ok(checkCueRegistration("numbers_registered", reg).length > 0);
  assert.equal(a.min_n_per_condition, null, "sizing waits for a pool that exists");

  // The reconfiguration names the run that forced it. A configuration change
  // without its evidence is a preference, not a finding.
  const from = reg.reconfigured_from as Record<string, unknown>;
  assert.deepEqual(from.previous_configuration, { descriptive_associative: "descriptive", item_scene: "item" });
  assert.match(String(from.evidence_run), /eval-runs/);

  // The superseded numbers stay on the record so the re-derivation has
  // something to compare against.
  const sup = (reg.power_assumption as Record<string, Record<string, unknown>>).superseded_v2_values;
  assert.equal(sup.main_effects_min_n, 213);

  // The parts that never depended on any baseline stay as they were.
  const fallback = reg.underpowered_fallback as Record<string, string>;
  assert.match(fallback.main_effect_missed, /not evaluable/);
  assert.match(fallback.interaction_missed, /explorative/);

  const gold = reg.gold_set_requirement as Record<string, unknown>;
  assert.equal(gold.satisfied, false);
  const targets = gold.authoring_targets as Record<string, Record<string, number>>;
  assert.equal(targets.associative.minimum, 150);
});

test("unsatisfied preconditions block the numbers stage, however complete the numbers are", () => {
  const reg = loadCueRegistration();
  const pre = reg.preconditions as { items: { id: string; satisfied: boolean }[] };
  assert.equal(pre.items.length, 3, "gold cases, an associative generator, and the agent path");
  for (const item of pre.items) assert.equal(item.satisfied, false, `${item.id} is open`);

  // Even a registration with every number filled in stays blocked while a
  // precondition is open — numbers do not make an experiment buildable.
  const filled = {
    status: "numbers_registered",
    design: "A",
    preconditions: { items: [{ id: "associative_gold_cases", satisfied: false }] },
    admissible_designs: {
      A: {
        condition_count: 2,
        interaction_evaluated: false,
        fixed_cue_configuration: { descriptive_associative: "associative", item_scene: "item" },
        min_n_per_condition: 255,
        contamination_guard: {
          mode: "selection_holdout_split",
          selection_share: 0.3, holdout_share: 0.7, split_seed: 20260828,
          stratify_by: ["origin_type", "lang"],
        },
      },
    },
    power_assumption: { main_effects: { min_n: 213 }, interaction: { min_n: 852 } },
    evaluation_rule: "paired McNemar on the holdout",
  };
  assert.match(
    checkCueRegistration("numbers_registered", filled).map((i) => i.problem).join(" | "),
    /not buildable yet/,
  );

  // Satisfy it and the same registration clears.
  filled.preconditions.items[0].satisfied = true;
  assert.deepEqual(checkCueRegistration("numbers_registered", filled), []);
});

test("a design that contradicts §18.3 is rejected even when fully filled in", () => {
  const wrongA = {
    status: "structure_registered",
    design: "A",
    admissible_designs: {
      A: {
        condition_count: 4,
        interaction_evaluated: true,
        fixed_cue_configuration: null,
        contamination_guard: { mode: "same_cases" },
      },
    },
  };
  const issues = checkCueRegistration("structure_registered", wrongA).map((i) => i.problem).join(" | ");
  assert.match(issues, /exactly two conditions/, "four cells belong to the cue-axis experiment, not to A");
  assert.match(issues, /may not evaluate interactions/);
  assert.match(issues, /selection\/holdout split or a nested evaluation/);
  assert.match(issues, /held-fixed cue configuration/);

  const wrongB = {
    status: "structure_registered",
    design: "B",
    admissible_designs: { B: { cell_count: 4 } },
  };
  assert.match(
    checkCueRegistration("structure_registered", wrongB).map((i) => i.problem).join(" | "),
    /eight cells/,
  );

  const noThird = { status: "structure_registered", design: "C", admissible_designs: {} };
  assert.match(
    checkCueRegistration("structure_registered", noThird).map((i) => i.problem).join(" | "),
    /no third design/,
  );
});

test("an M2 run additionally requires the numbers, separately for main effects and interaction", () => {
  const structureOnly = {
    status: "numbers_registered",
    design: "A",
    admissible_designs: {
      A: {
        condition_count: 2,
        interaction_evaluated: false,
        fixed_cue_configuration: { descriptive_associative: "descriptive", item_scene: "item" },
        contamination_guard: { mode: "selection_holdout_split" },
      },
    },
    power_assumption: { main_effects: { min_n: 120 }, interaction: { min_n: null } },
    evaluation_rule: null,
  };
  const issues = checkCueRegistration("numbers_registered", structureOnly).map((i) => i.problem).join(" | ");
  assert.match(issues, /minimum N is required/, "the interaction N is missing and the interaction needs the larger one");
  assert.match(issues, /not chosen after seeing the data/, "the evaluation rule is missing");
});

test("a named split is not a registered split until it is quantified", () => {
  const withSplit = (guard: Record<string, unknown>) => ({
    status: "numbers_registered",
    design: "A",
    admissible_designs: {
      A: {
        condition_count: 2,
        interaction_evaluated: false,
        fixed_cue_configuration: { descriptive_associative: "descriptive", item_scene: "item" },
        min_n_per_condition: 255,
        contamination_guard: { mode: "selection_holdout_split", stratify_by: ["origin_type"], ...guard },
      },
    },
    power_assumption: { main_effects: { min_n: 120 }, interaction: { min_n: 480 } },
    evaluation_rule: "paired comparison of Recall@3 on the holdout",
  });

  const unquantified = checkCueRegistration("numbers_registered", withSplit({})).map((i) => i.problem).join(" | ");
  assert.match(unquantified, /selection_share and holdout_share are part of the registration/);

  const lopsided = checkCueRegistration(
    "numbers_registered",
    withSplit({ selection_share: 0.3, holdout_share: 0.6, split_seed: 1 }),
  ).map((i) => i.problem).join(" | ");
  assert.match(lopsided, /must cover the case set exactly/, "a gap between the parts silently drops cases");

  const unseeded = checkCueRegistration(
    "numbers_registered",
    withSplit({ selection_share: 0.3, holdout_share: 0.7 }),
  ).map((i) => i.problem).join(" | ");
  assert.match(unseeded, /needs a seed/);

  assert.deepEqual(
    checkCueRegistration("numbers_registered", withSplit({ selection_share: 0.3, holdout_share: 0.7, split_seed: 20260726 })),
    [],
  );

  // A seed alone only makes an unbalanced split reproducible. Recall@3 per gold
  // file ranged 31.3%–84.9% in the M0 baseline, so an unstratified draw can move
  // the comparison baseline further than the effect under test.
  const unstratified = checkCueRegistration(
    "numbers_registered",
    withSplit({ selection_share: 0.3, holdout_share: 0.7, split_seed: 20260726, stratify_by: [] }),
  ).map((i) => i.problem).join(" | ");
  assert.match(unstratified, /what it stratifies by/);
});

test("the chosen design carries its own N — the power assumption is a different experiment", () => {
  // §18.1 asks for the per-condition/per-cell N in addition to the cue-axis
  // power assumption. Without this a registration reaches `numbers_registered`
  // while the one number the run is actually sized on is still open.
  const withoutPerCondition = {
    status: "numbers_registered",
    design: "A",
    admissible_designs: {
      A: {
        condition_count: 2,
        interaction_evaluated: false,
        fixed_cue_configuration: { descriptive_associative: "descriptive", item_scene: "item" },
        contamination_guard: {
          mode: "selection_holdout_split",
          selection_share: 0.3,
          holdout_share: 0.7,
          split_seed: 20260828,
          stratify_by: ["origin_type", "lang"],
        },
      },
    },
    power_assumption: { main_effects: { min_n: 213 }, interaction: { min_n: 852 } },
    evaluation_rule: "paired McNemar on the holdout",
  };
  assert.match(
    checkCueRegistration("numbers_registered", withoutPerCondition).map((i) => i.problem).join(" | "),
    /min_n_per_condition is required/,
    "a full power assumption does not size design A",
  );

  // Design B is sized per cell instead, and only its own field is demanded.
  const designB = {
    ...withoutPerCondition,
    design: "B",
    admissible_designs: { B: { cell_count: 8, min_n_per_cell: 852 } },
  };
  assert.deepEqual(checkCueRegistration("numbers_registered", designB), []);
});

test("the M1 tolerances are versioned, derived, and above their own noise band", () => {
  const tol = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "registrations", "m1-tolerances.json"), "utf8"),
  ) as Record<string, Record<string, unknown>>;

  // §26.1 makes the numeric M1 tolerances a release condition, and §18.1 puts
  // them after the baseline. A tolerance without a traceable run is a guess.
  assert.match(String(tol.derived_from.run_artifact), /eval-runs/);
  assert.ok(String(tol.derived_from.git).length >= 40);

  const rl = tol.relevant_loss as Record<string, unknown>;
  type Measurement = { value: number; wilson_95_ci: [number, number] };
  const measured = rl.measured as Measurement;
  const confirming = (rl.confirmed_by ?? []) as Measurement[];

  // The whole point of the derivation: a tolerance inside the confidence
  // interval fires on a clean re-run that changed nothing. That has to hold
  // against EVERY run on record, not only the one it was first derived from —
  // v3 exists because a later run moved the bound past the old tolerance.
  for (const m of [measured, ...confirming]) {
    assert.ok(
      (rl.tolerance as number) > m.wilson_95_ci[1],
      `tolerance ${String(rl.tolerance)} must sit above the upper bound ${m.wilson_95_ci[1]} of every recorded run`,
    );
    assert.ok(m.value > m.wilson_95_ci[0] && m.value < m.wilson_95_ci[1], "each point estimate lies inside its own interval");
  }
  assert.ok(confirming.length >= 1, "a raised tolerance names the runs that forced the raise");
  assert.deepEqual(rl.report_separately, ["origin_type", "kind"]);

  // v4: the tolerance is measured against a FROZEN set of cases, not against an
  // axis. `kind == descriptive` looked stable over four runs and moved 7.5pp the
  // moment a new case family was authored into it, so the denominator has to be
  // a named list that authoring cannot touch.
  const ref = rl.reference_set as Record<string, unknown>;
  assert.equal(ref.case_count, 365);
  assert.match(String(rl.denominator), /frozen reference set/);
  assert.match(String(ref.growth_rule), /never inside it/, "new families are reported beside the set, not into it");

  // And the set is checkable: the ids are committed, and their hash is the one
  // the tolerance cites. A silent edit to either file breaks this.
  const refFile = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "registrations", "m1-reference-set.json"), "utf8"),
  ) as { case_ids: string[]; case_ids_sha256: string };
  assert.equal(refFile.case_ids.length, 365);
  assert.deepEqual(refFile.case_ids, [...refFile.case_ids].sort(), "the ids are stored sorted, so the hash is reproducible");
  assert.equal(new Set(refFile.case_ids).size, 365, "no duplicates");
  const digest = createHash("sha256").update(refFile.case_ids.join(",")).digest("hex");
  assert.equal(digest, refFile.case_ids_sha256, "the reference set hashes to what it says it does");
  assert.equal(digest, ref.case_ids_sha256, "and the tolerance cites that same hash");

  // False abstention is registered on weak_result, not on the score floor — the
  // floor could not fire on the hybrid path, so a tolerance on it was empty.
  const fa = tol.false_abstention as Record<string, unknown>;
  assert.equal(fa.mechanism, "weak_result");
  const faMeasured = fa.measured as { value: number; wilson_95_ci: [number, number] };
  assert.ok(
    (fa.tolerance as number) > faMeasured.wilson_95_ci[1],
    "the tolerance must sit above the upper bound of the measured interval, zero count or not",
  );
  assert.ok(String((fa.derived_from as Record<string, string>).run_artifact).includes("eval-runs"));

  // A tolerance on a predicate that never fires would be as empty as the floor
  // it replaced. The discriminance counts are what make it a real gate.
  const disc = fa.discriminance as Record<string, string>;
  assert.match(disc.gibberish_probes, /^[1-9]\d*\/\d+$/, "weak_result must fire on at least one nonsense probe");
  assert.equal(disc.answerable_cases, "0/372");

  // The abandoned mechanism stays on the record: it explains why the mechanism
  // was swapped rather than the number tuned.
  const sup = fa.supersedes as Record<string, string>;
  assert.equal(sup.previous_status, "not_registrable_on_the_current_mechanism");
  assert.match(sup.why_abandoned, /81\.967/, "the arithmetic that killed the floor is part of the record");
});

// ── Das §17.4-Präsentationsexperiment (#267) ────────────────────

/**
 * Diese Registrierung ist der ungewöhnliche Fall: Sie hält fest, dass ein
 * Experiment auf der heutigen Population NICHT auswertbar ist. Genau deshalb
 * muss der Validator strenger sein als sonst — eine fehlende Zahl ohne die
 * Messung, die sie erklärt, liest sich später als Versäumnis und nicht als
 * Befund.
 */
test("die Präsentations-Registrierung ist strukturell registriert und in sich schlüssig", () => {
  const issues = checkPresentationRegistration("structure_registered");
  assert.deepEqual(issues, [], JSON.stringify(issues, null, 2));
});

test("beide Armpaare sind benannt — auch die blockierten", () => {
  const reg = loadPresentationRegistration();
  const arms = reg.arms as Record<string, Record<string, unknown>>;
  assert.ok(arms.A_wording, "Wortlaut");
  assert.ok(arms.B_gate, "Gate");
  // Ein Arm, der in der Registrierung fehlt, wäre später ein nachträglich
  // hinzugefügter — genau die Konfundierung, die §18.3 verbietet.
  assert.equal(arms.A_wording.status, "blocked_on_open_text_decision");
  assert.equal(arms.B_gate.status, "blocked_on_422");
});

test("ein fehlendes Armpaar wird bemängelt", () => {
  const reg = { ...loadPresentationRegistration(), arms: { A_wording: (loadPresentationRegistration().arms as Record<string, unknown>).A_wording } };
  const issues = checkPresentationRegistration("structure_registered", reg);
  assert.ok(issues.some((i) => i.where === "arms.B_gate"));
});

test("die Zuweisungsfunktion gehört versioniert in die Registrierung", () => {
  const reg = loadPresentationRegistration();
  const fn = (reg.unit_of_randomisation as Record<string, unknown>).assignment_function as Record<string, unknown>;
  assert.equal(fn.name, "assignArm");
  assert.match(String(fn.source), /telemetry-dimensions/);
  assert.ok(fn.registered_at_commit, "§17.4: Zuweisungsfunktion und Konfiguration versioniert abgelegt");

  const ohne = { ...reg, unit_of_randomisation: { unit: "pseudonymous_session" } };
  assert.ok(
    checkPresentationRegistration("structure_registered", ohne).some((i) => i.where === "assignment_function"),
  );
});

test("die Session ist die Versuchseinheit — nicht das Ereignis", () => {
  const falsch = { ...loadPresentationRegistration(), unit_of_randomisation: { unit: "event", assignment_function: { name: "x", source: "y", registered_at_commit: "z" } } };
  const issues = checkPresentationRegistration("structure_registered", falsch);
  assert.ok(issues.some((i) => i.where === "unit_of_randomisation"));
});

test("ohne Mindest-N verlangt der Validator die Messung, die das begründet", () => {
  const ohne = { ...loadPresentationRegistration(), underpowered_fallback: undefined };
  const issues = checkPresentationRegistration("structure_registered", ohne);
  assert.ok(
    issues.some((i) => i.where === "min_n_per_arm"),
    "eine fehlende Zahl ohne Begründung ist eine Lücke, kein Befund",
  );
});

test("und die Berichtsregel aus §18.1 muss darin stehen", () => {
  const reg = loadPresentationRegistration();
  const fb = reg.underpowered_fallback as Record<string, unknown>;
  const conclusion = fb.conclusion as Record<string, unknown>;
  assert.match(String(conclusion.reporting_rule), /NICHT AUSWERTBAR|not evaluable/i);
  // Der Unterschied, um den es geht: „nicht auswertbar" ist keine Aussage über
  // die Wirkung, „kein Unterschied gefunden" wäre eine.
  assert.match(String(conclusion.reporting_rule), /niemals als Nullbefund|never as a null/i);

  const ohneRegel = { ...reg, underpowered_fallback: { ...fb, conclusion: { verdict: "x" } } };
  assert.ok(
    checkPresentationRegistration("structure_registered", ohneRegel).some((i) => i.where === "underpowered_fallback"),
  );
});

test("die gemessenen Zahlen tragen ihre Quelle", () => {
  const fb = loadPresentationRegistration().underpowered_fallback as Record<string, unknown>;
  const from = fb.measured_from as Record<string, unknown>;
  assert.match(String(from.source), /events-\*\.jsonl/);
  assert.match(String(from.window), /14 Tage/);
  const m = fb.measured as Record<string, Record<string, unknown>>;
  assert.equal(m.distinct_sessions_on_hook_recall.total_window, 80);
  assert.equal(m.sessions_with_at_least_one_loaded, 16);
});

test("wer die Zahlenstufe verlangt, bekommt gesagt, dass die Registrierung sie nicht hat", () => {
  // Die Datei steht auf `structure_registered`. Ein Aufrufer, der einen Lauf
  // starten will, erfährt hier, dass die Stufe fehlt — nicht erst beim Lauf.
  const issues = checkPresentationRegistration("numbers_registered");
  assert.ok(issues.some((i) => i.where === "status"));
});

test("und eine Registrierung, die die Zahlenstufe BEHAUPTET, scheitert an den offenen Voraussetzungen", () => {
  // Die Voraussetzungen sperren den ANSPRUCH auf die Stufe, nicht die Anfrage
  // danach — dieselbe Trennung wie bei der Cue-Registrierung. Vier sind offen:
  // Zweitwortlaut, Gate je Session, erreichbares Mindest-N, Query-Klasse.
  const behauptet = { ...loadPresentationRegistration(), status: "numbers_registered" };
  const issues = checkPresentationRegistration("numbers_registered", behauptet);
  const offen = issues.filter((i) => i.where.startsWith("precondition"));
  assert.equal(offen.length, 4, JSON.stringify(issues, null, 2));
  assert.ok(offen.some((i) => i.where.includes("min_n_reachable")));
  assert.ok(offen.some((i) => i.where.includes("arm_b_per_session_gate")));
});
