/**
 * #140: demand-gap detection from the recall log and its REPORT.md section.
 *
 * Run: npx tsx --test packages/daemon/__tests__/demand-gaps.test.ts
 */
import { homedir } from "node:os";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { collectDemandGaps } from "../src/demand-gaps.js";
import { renderVaultHealthReport, type VaultHealthData } from "../src/vault-report.js";
import type { TelemetryEvent } from "../src/learned-recall/harvest.js";

let n = 0;
function recall(query: string, opts: { day: number; session?: string; hits?: number; weak?: boolean; origin?: string; kind?: string; eval?: boolean }): TelemetryEvent {
  return {
    kind: opts.kind ?? "recall",
    ts: `2026-10-${String(opts.day).padStart(2, "0")}T10:00:00.000Z`,
    recall_id: `r-${++n}`,
    query,
    hit_count: opts.hits ?? 0,
    ...(opts.weak !== undefined ? { weak_result: opts.weak } : {}),
    ...(opts.origin ? { origin: opts.origin } : {}),
    ...(opts.session ? { dimensions: { experiment_session: opts.session } } : {}),
    ...(opts.eval ? { eval_run: true } : {}),
  };
}

test("a query that misses on two independent occasions is a gap; one occasion is not", () => {
  const gaps = collectDemandGaps([
    recall("Where is the parking permit?", { day: 1 }),
    recall("where is the  parking permit?", { day: 3, weak: true, hits: 2 }),
    recall("dentist appointment", { day: 2 }),
    // Same session twice = one occasion.
    recall("tax id number", { day: 4, session: "s1" }),
    recall("tax id number", { day: 5, session: "s1" }),
  ]);
  assert.deepEqual(gaps, [{ query: "where is the  parking permit?", occasions: 2, lastSeen: "2026-10-03T10:00:00.000Z" }]);
});

test("a gap disappears once the latest ask found something fitting", () => {
  const gaps = collectDemandGaps([
    recall("vpn config", { day: 1 }),
    recall("vpn config", { day: 2 }),
    recall("vpn config", { day: 3, hits: 3, weak: false }),
  ]);
  assert.deepEqual(gaps, []);
});

test("hook recalls, tool and system queries and eval runs never count", () => {
  const gaps = collectDemandGaps([
    recall("hook only", { day: 1, kind: "hook_recall" }),
    recall("hook only", { day: 2, kind: "hook_recall" }),
    recall("npm test packages/daemon", { day: 1, origin: "tool" }),
    recall("npm test packages/daemon", { day: 2, origin: "tool" }),
    recall("eval probe", { day: 1, eval: true }),
    recall("eval probe", { day: 2, eval: true }),
  ]);
  assert.deepEqual(gaps, []);
});

test("gaps sort by occasions, then recency, and are bounded", () => {
  const events = [
    recall("a", { day: 1 }), recall("a", { day: 2 }),
    recall("b", { day: 1 }), recall("b", { day: 2 }), recall("b", { day: 3 }),
    recall("c", { day: 4 }), recall("c", { day: 5 }),
  ];
  assert.deepEqual(collectDemandGaps(events).map((g) => g.query), ["b", "c", "a"]);
  assert.equal(collectDemandGaps(events, 1).length, 1);
});

const BASE: VaultHealthData = {
  generatedAt: "2026-10-20T12:00:00Z",
  vaultSize: 3,
  stale: [],
  floors: [],
  conflicts: [],
  dangling: [],
};

test("report: section omitted when not collected, unavailable on null, none on empty", () => {
  assert.ok(!renderVaultHealthReport(BASE).includes("bastra-report:demand-gaps"));
  const unavailable = renderVaultHealthReport({ ...BASE, demandGaps: null });
  assert.ok(unavailable.includes("<!-- bastra-report:demand-gaps -->"));
  assert.ok(unavailable.includes("Not available"));
  assert.ok(!unavailable.includes("None. No question"));
  assert.ok(renderVaultHealthReport({ ...BASE, demandGaps: [] }).includes("None. No question"));
});

test("report: rows are one-line code spans without backticks, bounded in length", () => {
  const long = "x".repeat(300);
  const report = renderVaultHealthReport({
    ...BASE,
    demandGaps: [
      { query: "where is the `permit`\nform", occasions: 3, lastSeen: "2026-10-19T08:00:00Z" },
      { query: long, occasions: 2, lastSeen: "2026-10-18T08:00:00Z" },
    ],
  });
  assert.ok(report.includes("- `where is the 'permit' form` · 3 occasions · last asked 2026-10-19"));
  assert.ok(report.includes(`\`${"x".repeat(159)}…\``));
  assert.ok(report.includes("not yet calibrated against a null sample"));
  assert.ok(report.indexOf("demand-gaps") < report.indexOf("bastra-report:dangling"), "section sits before dangling links");
});

function batch(day: number, id: string, fitting = false): TelemetryEvent[] {
  return ["boiler handbook", "heating instructions"].map((query, i) => ({
    ...recall(query, { day, hits: fitting && i === 1 ? 1 : 0 }),
    batch_id: id, query_count: 2, batch_collapsed: 0,
  }));
}

test("batch phrasings form one ask across independent occasions, irrespective of order", () => {
  assert.deepEqual(collectDemandGaps(batch(1, "b1")), []);
  const events = [...batch(1, "b1"), ...batch(2, "b2").reverse()];
  const gaps = collectDemandGaps(events);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.occasions, 2);
  assert.equal(gaps[0]!.query, "boiler handbook | heating instructions");
  assert.deepEqual(collectDemandGaps([...events, ...batch(3, "b3", true)]), [], "one fitting sibling answers the latest batch");
  assert.deepEqual(collectDemandGaps([...batch(1, "b1", true), ...batch(2, "b2")]), [], "a mixed batch is not a prior miss");
});

test("batches in the same session remain one occasion; separate batches in a day do not become siblings", () => {
  const events = [...batch(1, "b1"), ...batch(2, "b2")].map(e => ({ ...e, dimensions: { experiment_session: "one-session" } }));
  assert.deepEqual(collectDemandGaps(events), []);
  assert.equal(collectDemandGaps([...batch(1, "b1"), ...batch(1, "b2"), ...batch(2, "b3")])[0]!.occasions, 2);
});

test("legacy multi-phrasing and incomplete batches cannot prove gaps; collapsed singleton can", () => {
  const legacy = [...batch(1, "b1"), ...batch(2, "b2")].map(({ batch_id, ...e }) => e);
  assert.deepEqual(collectDemandGaps(legacy), []);
  assert.deepEqual(collectDemandGaps([batch(1, "b1")[0]!, batch(2, "b2")[0]!]), []);
  const singleton = [recall("boiler handbook", { day: 1 }), recall("boiler handbook", { day: 2 })]
    .map(e => ({ ...e, query_count: 2, batch_collapsed: 1 }));
  assert.equal(collectDemandGaps(singleton)[0]!.occasions, 2);
});

test("report redacts secrets and home paths before flattening or clipping queries", () => {
  const secret = "fixture-password-never-publish";
  const report = renderVaultHealthReport({ ...BASE, demandGaps: [
    { query: `manual ${homedir()}/private password=${secret}`, occasions: 2, lastSeen: "2026-10-18" },
    { query: `-----BEGIN RSA PRIVATE KEY-----\n${secret}\n-----END RSA PRIVATE KEY-----`, occasions: 2, lastSeen: "2026-10-18" },
    { query: `${"a ".repeat(70)}password=${secret}`, occasions: 2, lastSeen: "2026-10-18" },
  ] });
  assert.ok(report.includes("[REDACTED]"));
  assert.ok(!report.includes(secret));
  assert.ok(!report.includes(homedir()));
  assert.ok(!report.includes("BEGIN RSA"));
  assert.ok(!report.includes("fixture-password"), "clipping cannot expose the start of a secret");
});

test("telemetry queries keep structural secret syntax until report redaction, including batches", () => {
  const query = "password: |\n  fixture-private-line\n  fixture-second-line\nhost: example";
  const single = [recall(query, { day: 1 }), recall(query, { day: 2 })];
  const batched = [1, 2].flatMap(day => [query, "manual"].map(text => ({
    ...recall(text, { day }), batch_id: `sensitive-${day}`, query_count: 2,
  })));
  for (const events of [single, batched]) {
    const report = renderVaultHealthReport({ ...BASE, demandGaps: collectDemandGaps(events) });
    assert.ok(report.includes("[REDACTED]"));
    assert.ok(!report.includes("fixture-private-line"));
    assert.ok(!report.includes("fixture-second-line"));
  }
});

test("batch identity preserves phrasing boundaries even when queries contain the display separator", () => {
  const first = ["a | b", "c"].map(query => ({ ...recall(query, { day: 1 }), query_count: 2, batch_id: "first" }));
  const second = ["a", "b | c"].map(query => ({ ...recall(query, { day: 2 }), query_count: 2, batch_id: "second" }));
  assert.deepEqual(collectDemandGaps([...first, ...second]), [], "different sets cannot manufacture two occasions");
  const repeat = ["c", "A | B"].map(query => ({ ...recall(query, { day: 3 }), query_count: 2, batch_id: "repeat" }));
  const gaps = collectDemandGaps([...first, ...second, ...repeat]);
  assert.equal(gaps.length, 1, "the matching set still joins across order and casing");
  assert.equal(gaps[0]!.occasions, 2);
});

test("single-query identity cannot collide with a batch's readable joined text", () => {
  const single = recall("a | b", { day: 1 });
  const batched = ["a", "b"].map(query => ({ ...recall(query, { day: 2 }), query_count: 2, batch_id: "pair" }));
  assert.deepEqual(collectDemandGaps([single, ...batched]), [], "single and batch are independent evidence groups");
  const repeat = recall("A | B", { day: 3 });
  assert.deepEqual(collectDemandGaps([single, ...batched, repeat]), [{
    query: "A | B", occasions: 2, lastSeen: repeat.ts,
  }]);
});
