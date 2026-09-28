/**
 * #362 — die Ship-Bar des Query-Router-Harness (`router-lift.ts`).
 *
 * Die Bar ist das, woran „der Router hält die Baseline" hängt; sie muss eine
 * Verschlechterung in JEDER Kennzahl melden, und sie darf eine Verbesserung
 * nicht als Verstoß lesen.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/eval/__tests__/router-lift.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { armReport, shipBarViolations, type ArmReport } from "../src/router-lift.js";
import type { CaseResult } from "../src/goldset-run.js";

function row(id: string, rank: number, extra: Partial<CaseResult> = {}): CaseResult {
  return {
    id, query: id, no_answer: false, kind: "k", zone: "z", origin: "o", lang: "de", allowed_depth: 3,
    rank_expected: rank, rank_any: rank, top_id: "x", top_score: 50, gold_score: 50, abstained: false,
    weak_result: false, anchor: "title", unknown_ids: [], top_mode: "hybrid", top_k: [], ...extra,
  } as CaseResult;
}

const ms = new Map([["a", 10], ["b", 20], ["c", 30]]);

test("#362: armReport zählt relevant_loss nur auf dem Referenzset", () => {
  const r = armReport([row("a", 1), row("b", 0), row("c", 0)], ms, 60, new Set(["a", "b"]), new Set(["c"]));
  assert.deepEqual(r.relevant_loss_ref, { count: 1, n: 2, value: 0.5 });
  assert.equal(r.routed_query_ms?.p50, 30);
  assert.equal(r.query_ms.max, 30);
});

test("#362: gleich oder besser ist kein Verstoß", () => {
  const base = armReport([row("a", 2), row("b", 5)], ms, 30, new Set(["a", "b"]));
  const better = armReport([row("a", 1), row("b", 3)], ms, 30, new Set(["a", "b"]));
  assert.deepEqual(shipBarViolations(base, base), []);
  assert.deepEqual(shipBarViolations(base, better), []);
});

test("#362: jede Verschlechterung ist ein Verstoß", () => {
  const base = armReport([row("a", 1), row("b", 1)], ms, 30, new Set(["a", "b"]));
  const worse = armReport([row("a", 1), row("b", 0)], ms, 30, new Set(["a", "b"]));
  const v = shipBarViolations(base, worse);
  assert.ok(v.some((s) => s.startsWith("recall_at_1")), v.join("; "));
  assert.ok(v.some((s) => s.startsWith("relevant_loss 0 → 1")), v.join("; "));
  assert.ok(v.some((s) => s.includes("> tolerance")), "0.5 reißt die M1-Toleranz 0.24");
});

test("#362: eine neue Abstention ist ein Verstoß", () => {
  const base: ArmReport = armReport([row("a", 1)], ms, 10, new Set());
  const abst = armReport([row("a", 1, { weak_result: true })], ms, 10, new Set());
  assert.deepEqual(shipBarViolations(base, abst), ["false_abstention 0 → 1"]);
});
