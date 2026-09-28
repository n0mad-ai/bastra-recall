#!/usr/bin/env tsx
/**
 * #362: Der Query-Router gegen die Baseline — Gold-Set-Lauf A, drei Arme.
 *
 * Misst, was `routeQueryArms` (core) bewirken WÜRDE, wenn er scharf wäre:
 * Anfragen, die er als `short`/`identifier` einstuft, laufen nur über den
 * BM25-Arm, alle anderen hybrid. Der Daemon schreibt dieselbe Entscheidung im
 * Schatten (`query_route` an `hook_recall`); dieses Skript ist die andere
 * Hälfte der Messuhr: Qualität und Zeit auf dem gelabelten Set.
 *
 * Drei Arme, in dieser Reihenfolge, auf demselben Index und derselben
 * Store-Kopie (`attachHybrid`, nie der Live-Store):
 *
 *   1. baseline  — hybrid für jede Anfrage (Lauf A, wie registriert)
 *   2. routed    — der Router entscheidet pro Anfrage
 *   3. control   — baseline noch einmal. Erst diese Zeile macht die anderen
 *                  lesbar: Sie legt den Rauschboden fest (Design 5d54c63,
 *                  Schritt 5), und sie weist aus, ob der Lauf deterministisch
 *                  ist (dieselben Ränge in Arm 1 und 3).
 *
 * Ship-Bar (Owner-Regel: die #387-Baseline nicht verschlechtern): Der
 * geroutete Arm darf in KEINER Kennzahl von `metricsFor` unter der Baseline
 * liegen, `relevant_loss` auf dem M1-Referenzset (m1-reference-set.json) nicht
 * steigen und die M1-Toleranz (0,24) halten, und `false_abstention`
 * (`weak_result`) nicht steigen. Sonst FAIL — und der Router bleibt Schatten.
 *
 * Usage (derselbe Aufruf wie Lauf A):
 *   BASTRA_VAULT_PATH=<vault> npx tsx src/router-lift.ts \
 *     --gold ~/.bastra/eval-goldset/gold-blind.json [--gold …] [--out result.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SearchIndex, Vault, routeQueryArms, type QueryRoute, type RecallHit } from "@bastra-recall/core";
import { loadGoldFiles, unknownGoldIds } from "./goldset-dataset.js";
import {
  PRODUCTION_K,
  attachHybrid,
  gatedHybridRecaller,
  metricsFor,
  scoreCases,
  type CaseResult,
  type SliceMetrics,
} from "./goldset-run.js";

/** M1-Toleranz für `relevant_loss` auf dem Referenzset (m1-tolerances.json v4). */
const RELEVANT_LOSS_TOLERANCE = 0.24;

type Recaller = (query: string, caseId: string) => Promise<RecallHit[]>;

export interface ArmReport {
  answerable: SliceMetrics;
  relevant_loss_ref: { count: number; n: number; value: number };
  false_abstention: number;
  total_ms: number;
  query_ms: { p50: number; p90: number; max: number };
  routed_query_ms?: { p50: number; p90: number; max: number };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function spread(values: number[]): { p50: number; p90: number; max: number } {
  return { p50: percentile(values, 50), p90: percentile(values, 90), max: Math.max(0, ...values) };
}

/** Misst jede Anfrage einzeln — die Zahl, die der Router in der Prompt-Lane spart. */
function timed(recall: Recaller, into: Map<string, number>): Recaller {
  return async (query, caseId) => {
    const t0 = performance.now();
    const hits = await recall(query, caseId);
    into.set(caseId, performance.now() - t0);
    return hits;
  };
}

export function armReport(
  rows: CaseResult[],
  ms: Map<string, number>,
  totalMs: number,
  referenceIds: Set<string>,
  routedIds?: Set<string>,
): ArmReport {
  const answerable = rows.filter((r) => !r.probe_group && !r.no_answer);
  const ref = answerable.filter((r) => referenceIds.has(r.id));
  const lost = ref.filter((r) => r.rank_expected === 0).length;
  return {
    answerable: metricsFor(answerable),
    relevant_loss_ref: { count: lost, n: ref.length, value: ref.length ? Number((lost / ref.length).toFixed(4)) : 0 },
    false_abstention: answerable.filter((r) => r.weak_result || r.abstained).length,
    total_ms: Math.round(totalMs),
    query_ms: spread([...ms.values()]),
    ...(routedIds
      ? { routed_query_ms: spread([...ms.entries()].filter(([id]) => routedIds.has(id)).map(([, v]) => v)) }
      : {}),
  };
}

/** Die Ship-Bar. Gibt die verletzten Bedingungen zurück — leer heißt PASS. */
export function shipBarViolations(baseline: ArmReport, routed: ArmReport): string[] {
  const out: string[] = [];
  for (const key of Object.keys(baseline.answerable) as Array<keyof SliceMetrics>) {
    if (key === "n") continue;
    if (routed.answerable[key] < baseline.answerable[key]) {
      out.push(`${key} ${baseline.answerable[key]} → ${routed.answerable[key]}`);
    }
  }
  if (routed.relevant_loss_ref.count > baseline.relevant_loss_ref.count) {
    out.push(`relevant_loss ${baseline.relevant_loss_ref.count} → ${routed.relevant_loss_ref.count}`);
  }
  if (routed.relevant_loss_ref.value > RELEVANT_LOSS_TOLERANCE) {
    out.push(`relevant_loss ${routed.relevant_loss_ref.value} > tolerance ${RELEVANT_LOSS_TOLERANCE}`);
  }
  if (routed.false_abstention > baseline.false_abstention) {
    out.push(`false_abstention ${baseline.false_abstention} → ${routed.false_abstention}`);
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const gold: string[] = [];
  let out = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--gold") gold.push(argv[++i] ?? "");
    else if (argv[i] === "--out") out = argv[++i] ?? "";
    else throw new Error(`unknown flag: ${argv[i]}`);
  }
  if (!gold.length) throw new Error("--gold is required (repeatable)");
  const vaultPath = process.env.BASTRA_VAULT_PATH;
  if (!vaultPath) throw new Error("BASTRA_VAULT_PATH is required");

  const { cases } = loadGoldFiles(gold);
  const vault = new Vault(vaultPath);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  if (search.size() !== vault.size()) throw new Error("lexical index incomplete — the BM25 arm would be blind");
  const knownIds = new Set(vault.list().map((m) => String(m.fm.id)));
  const unknown = unknownGoldIds(cases, knownIds);
  if (unknown.length) throw new Error(`${unknown.length} gold id(s) are not in the vault: ${unknown.join(", ")}`);
  const arm = await attachHybrid(vault, search, vaultPath);

  const reference = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "registrations", "m1-reference-set.json"), "utf8"),
  ) as { case_ids: string[] };
  const referenceIds = new Set(reference.case_ids);

  const hybrid = gatedHybridRecaller((q, o) => search.recallHybrid(q, o));
  const routes = new Map<string, QueryRoute>(cases.map((c) => [c.id, routeQueryArms(c.query)]));
  const routedIds = new Set([...routes].filter(([, r]) => r.arms === "bm25").map(([id]) => id));
  const routed: Recaller = async (query, caseId) =>
    routes.get(caseId)?.arms === "bm25" ? search.recall(query, { k: PRODUCTION_K }) : hybrid(query, caseId);

  const runArm = async (recall: Recaller, withRouted: boolean): Promise<{ rows: CaseResult[]; report: ArmReport }> => {
    const ms = new Map<string, number>();
    const t0 = performance.now();
    // hybridActive=true wie Lauf A. Für die gerouteten BM25-Zeilen ist
    // `weak_result` damit AUCH definiert — strenger als die Produktion, die
    // es auf der rohen Skala nicht setzt; die Bar vergleicht also nicht zu
    // wohlwollend.
    const rows = await scoreCases(cases, timed(recall, ms), knownIds, true);
    const total = performance.now() - t0;
    return { rows, report: armReport(rows, ms, total, referenceIds, withRouted ? routedIds : undefined) };
  };

  const baseline = await runArm(hybrid, true);
  const routedArm = await runArm(routed, true);
  const control = await runArm(hybrid, true);
  await arm.cleanup();

  const deterministic = baseline.rows.every((r, i) => {
    const c = control.rows[i]!;
    return r.id === c.id && JSON.stringify(r.top_k) === JSON.stringify(c.top_k);
  });
  const byReason = [...routes.values()].reduce<Record<string, number>>((a, r) => {
    a[r.reason] = (a[r.reason] ?? 0) + 1;
    return a;
  }, {});
  // Wo der Router einen Fall anders beantwortet: Rang des erwarteten Treffers
  // vorher → nachher, nur für geroutete, beantwortbare Fälle.
  const changed = routedArm.rows
    .map((r, i) => ({ r, b: baseline.rows[i]! }))
    .filter(({ r, b }) => routedIds.has(r.id) && !r.no_answer && !r.probe_group && r.rank_expected !== b.rank_expected)
    .map(({ r, b }) => ({ id: r.id, reason: routes.get(r.id)!.reason, rank_before: b.rank_expected, rank_after: r.rank_expected }));
  const violations = shipBarViolations(baseline.report, routedArm.report);

  const result = {
    arm: arm.label,
    cases: cases.length,
    routed: { total: routedIds.size, by_reason: byReason },
    deterministic,
    baseline: baseline.report,
    routed_arm: routedArm.report,
    control: control.report,
    rank_changes: changed,
    ship_bar: violations.length === 0 ? "PASS" : "FAIL",
    violations,
  };
  console.log(JSON.stringify(result, null, 2));
  if (out) writeFileSync(out, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
}

if (import.meta.filename === process.argv[1]) {
  main().catch((e: Error) => {
    console.error(`[router-lift] FATAL: ${e.message}`);
    process.exit(1);
  });
}
