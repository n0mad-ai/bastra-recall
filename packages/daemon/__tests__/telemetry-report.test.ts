/**
 * #463 — der Telemetrie-Report für den UI-Tab rechnet die stats.ts-Serien
 * nach denselben Regeln und trägt seine Lücken mit, statt sie zu glätten.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/telemetry-report.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import {
  buildTelemetryReport,
  readEventWindow,
  summarizeContextTax,
  summarizeEvidence,
  summarizeLatency,
  summarizeQuality,
  summarizeSessionStart,
  type ReportEvent,
} from "../src/telemetry-report.js";
import { handleUiTelemetry, parseDays } from "../src/webui-telemetry.js";

const T = { mustLoadScore: 100, scoreFloor: 30 };
const ts = (day: string, hh = "10") => `${day}T${hh}:00:00.000Z`;

test("#463 quality: bands from hook hits, loaded/acted from surfaced episodes, direct loads excluded", () => {
  const events: ReportEvent[] = [
    { kind: "hook_call", ts: ts("2026-09-01"), daemon_reachable: true, hint_count: 2, top_score: 150 },
    { kind: "hook_call", ts: ts("2026-09-01"), daemon_reachable: true, hint_count: 0, top_score: 40 },
    { kind: "hook_call", ts: ts("2026-09-01"), daemon_reachable: false, hint_count: 0, top_score: null },
    {
      kind: "hook_recall",
      ts: ts("2026-09-01"),
      recall_id: "r1",
      tool_name: "Write",
      hits: [{ id: "a", score: 150 }, { id: "b", score: 60 }, { id: "c", score: 10 }],
    },
    { kind: "hook_recall", ts: ts("2026-09-01"), recall_id: "r2", tool_name: "Bash", hits: [{ id: "d", score: 120 }] },
    { kind: "recall_episode", ts: ts("2026-09-01"), recall_id: "r1", memory_id: "a", surfaced: true, band: "required", acted_on: true },
    { kind: "recall_episode", ts: ts("2026-09-01"), recall_id: "r1", memory_id: "b", surfaced: true, band: "optional", acted_on: false },
    { kind: "recall_episode", ts: ts("2026-09-01"), recall_id: "r2", memory_id: "d", surfaced: true, band: "required", acted_on: true },
    // Direkt-Load ohne Hint: in keiner Bandquote (#77).
    { kind: "recall_episode", ts: ts("2026-09-01"), recall_id: null, memory_id: "z", surfaced: false, band: "not_hinted", acted_on: true },
    { kind: "load_memory", ts: ts("2026-09-01"), id: "a", found: true, from_hook_recall: "r1", hook_hint_rank: 1 },
    { kind: "load_memory", ts: ts("2026-09-01"), id: "d", found: true, from_hook_recall: "r2", hook_hint_rank: 1 },
    { kind: "load_memory", ts: ts("2026-09-01"), id: "z", found: true },
  ];
  const q = summarizeQuality(events, T);
  assert.deepEqual(q.hookCalls, { calls: 3, reachable: 2, withHints: 1, topScore: { required: 1, optional: 1, below_floor: 0, none: 1 } });
  assert.deepEqual(q.bands, [
    { band: "required", surfaced: 2, loaded: 2, acted: 2 },
    { band: "optional", surfaced: 1, loaded: 1, acted: 0 },
    { band: "below_floor", surfaced: 1, loaded: 0, acted: 0 },
  ]);
  assert.equal(q.directLoads, 1);
  assert.deepEqual(q.bySource, [
    { source: "bash-tripwire", surfaced: 1, loaded: 1, acted: 1 },
    { source: "write-edit", surfaced: 3, loaded: 2, acted: 1 },
  ]);
  assert.deepEqual(q.followThrough, { loads: 3, fromHint: 2, hookRecallsWithHits: 2, hookRecallsConsumed: 2, ranks: [{ rank: 1, count: 2 }] });
});

test("#463 context tax: daily series follows the ledger rules, archival list keeps directives apart and old rows untyped", () => {
  const events: ReportEvent[] = [
    { kind: "session_hook_call", ts: ts("2026-09-01"), session_id: "s1", hint_tokens_est: 2000, hinted_ids: ["fact-1", "rule-1"], hinted_types: ["project-fact", "preference"] },
    { kind: "prompt_hook_call", ts: ts("2026-09-01"), session_id: "s1", hint_tokens_est: 500, hinted_ids: ["fact-1", "rule-1"], hinted_types: ["project-fact", "preference"] },
    { kind: "prompt_hook_call", ts: ts("2026-09-02"), session_id: "s2", hint_tokens_est: 300, hinted_ids: ["fact-1", "rule-1", "old-1"], hinted_types: ["project-fact", "preference", "lesson"] },
    // Alte Zeile: kein Typfeld, keine Größe — zählt unknown, nicht 0.
    { kind: "hook_call", ts: ts("2026-09-02"), session_id: "s2", hinted_ids: ["old-1", "old-1"] },
    { kind: "hook_call", ts: ts("2026-09-02"), session_id: "s2", hinted_ids: ["old-1"] },
    { kind: "recall", ts: ts("2026-09-02"), caller_session: "s2", payload_tokens_est: 400 },
    { kind: "load_memory", ts: ts("2026-09-02"), caller_session: "s2", found: true, delivered_tokens_est: 250, presentation: "lean" },
    { kind: "load_memory", ts: ts("2026-09-02"), caller_session: "s2", found: false },
  ];
  const c = summarizeContextTax(events);
  assert.equal(c.totalTokens, 2000 + 500 + 300 + 400 + 250);
  assert.equal(c.totalUnknown, 2, "the two hook_call rows without a size field are unknown, never zero");
  assert.deepEqual(c.daily, [
    { day: "2026-09-01", lanes: 2500, tools: 0, unknown: 0, sessions: 1 },
    { day: "2026-09-02", lanes: 300, tools: 650, unknown: 2, sessions: 1 },
  ]);
  assert.deepEqual(c.topSessions.map((s) => [s.session, s.tokens]), [["s1", 2500], ["s2", 950]]);
  // fact-1: 3× emittiert, nie acted_on, bewertbarer Typ → Kandidat.
  // rule-1: 3× emittiert, Direktive → NICHT Kandidat.
  // old-1: 4× emittiert, Typ nur aus der neuen Zeile bekannt (lesson) → Kandidat, typisiert.
  assert.deepEqual(
    c.archival.candidates.map((x) => [x.id, x.emitted, x.type]),
    [["old-1", 4, "lesson"], ["fact-1", 3, "project-fact"]],
  );
  assert.deepEqual(c.archival.directives.map((x) => [x.id, x.type]), [["rule-1", "preference"]]);
  assert.equal(c.archival.typedEmissions, 3);
  assert.equal(c.archival.untypedEmissions, 2);
  // Ohne die typisierte Zeile bleibt old-1 `unknown` — und wird als solches gezählt.
  const older = summarizeContextTax(events.filter((e) => !(Array.isArray(e.hinted_ids) && (e.hinted_ids as string[]).includes("old-1") && e.hinted_types)));
  const old = older.archival.candidates.find((x) => x.id === "old-1");
  assert.equal(old?.type, "unknown");
  assert.equal(older.archival.unknownTyped, 1);
});

test("#463 latency: per lane median/p95 and a per-day hook/recall split", () => {
  const events: ReportEvent[] = [
    { kind: "hook_call", ts: ts("2026-09-01"), latency_ms_total: 10 },
    { kind: "hook_call", ts: ts("2026-09-01"), latency_ms_total: 30 },
    { kind: "prompt_hook_call", ts: ts("2026-09-02"), latency_ms_total: 50 },
    { kind: "hook_recall", ts: ts("2026-09-02"), latency_ms_recall: 80 },
    { kind: "recall", ts: ts("2026-09-02"), latency_ms: 100 },
    { kind: "recall", ts: ts("2026-09-02") }, // kein Feld → kein Messwert
  ];
  const l = summarizeLatency(events);
  assert.deepEqual(l.lanes, [
    { lane: "hook_call", n: 2, median: 20, p95: 30 },
    { lane: "prompt_hook_call", n: 1, median: 50, p95: 50 },
    { lane: "hook_recall", n: 1, median: 80, p95: 80 },
    { lane: "recall", n: 1, median: 100, p95: 100 },
  ]);
  assert.deepEqual(l.daily, [
    { day: "2026-09-01", hook: { lane: "hook", n: 2, median: 20, p95: 30 }, recall: null },
    { day: "2026-09-02", hook: { lane: "hook", n: 1, median: 50, p95: 50 }, recall: { lane: "recall", n: 2, median: 90, p95: 100 } },
  ]);
});

test("#463 evidence: acceptance over shadow only, mix over usable, divergence only on fused runs", () => {
  const dec = (memory_id: string, decision: string, lexical_score: number) => ({ memory_id, decision, evidence: { lexical_score }, hop: "direct" });
  const events: ReportEvent[] = [
    { kind: "hook_recall", ts: ts("2026-09-01"), recall_id: "f", score_kind: "rrf" },
    { kind: "hook_recall", ts: ts("2026-09-01"), recall_id: "u", score_kind: "bm25" },
    { kind: "evidence_decision", ts: ts("2026-09-01"), session_id: "s1", recall_id: "f", shadow: true, decisions: [dec("a", "required", 150), dec("b", "optional", 150), dec("c", "required", 50)] },
    { kind: "evidence_decision", ts: ts("2026-09-02"), session_id: "s2", recall_id: "u", shadow: true, decisions: [dec("d", "no_answer", 500)] },
    { kind: "evidence_decision", ts: ts("2026-09-02"), session_id: "s2", recall_id: "x", shadow: false, decisions: [dec("e", "optional", 60)] },
    { kind: "evidence_decision", ts: ts("2026-09-02"), recall_id: "f", shadow: true, degraded: true, decisions: [dec("g", "no_answer", 1)] },
    { kind: "evidence_decision", ts: ts("2026-09-02"), recall_id: "f", shadow: true, failed: true, decisions: [] },
  ];
  const ev = summarizeEvidence(events, T)!;
  assert.deepEqual(ev.shadow, { calls: 2, decisions: 4, days: 2 });
  assert.deepEqual(ev.live, { calls: 1, decisions: 1 });
  assert.deepEqual(ev.excluded, { degraded: 1, failed: 1 });
  assert.equal(ev.acceptance.decisions, 4);
  assert.equal(ev.acceptance.sessions, 2);
  assert.equal(ev.acceptance.route, null);
  assert.deepEqual(ev.decisions, [
    { decision: "required", count: 2 },
    { decision: "optional", count: 2 },
    { decision: "no_answer", count: 1 },
  ]);
  // f: a agree (both required), b withholds (legacy required, gate optional), c promotes (gate required, legacy not).
  // u: unfused → skipped. x: no hook_recall → unknown space.
  assert.deepEqual(ev.divergence, { agree: 1, withholds: 1, promotes: 1, unknownSpace: 1, unfused: 1 });
  assert.equal(summarizeEvidence([], T), null);
});

test("#463 session start: shares only over starts that carry per-part data, the rest is counted as a gap", () => {
  const events: ReportEvent[] = [
    { kind: "session_hook_call", ts: ts("2026-09-01"), source: "startup", hint_tokens_est: 1000, hint_tokens_by_part: { recalls: 600, taxonomy: 400, care: 0 } },
    { kind: "session_hook_call", ts: ts("2026-09-01"), source: "clear", hint_tokens_est: 800, hint_tokens_by_part: { recalls: 400, taxonomy: 400, care: 0 } },
    { kind: "session_hook_call", ts: ts("2026-08-01"), source: "startup", hint_tokens_est: 2300 }, // vor #462
  ];
  const ss = summarizeSessionStart(events);
  assert.equal(ss.starts, 3);
  assert.equal(ss.withParts, 2);
  assert.equal(ss.withoutParts, 1);
  assert.equal(ss.totalTokens, 1800);
  assert.deepEqual(ss.parts, [
    { part: "recalls", tokens: 1000, avgPerStart: 500, presentIn: 2 },
    { part: "taxonomy", tokens: 800, avgPerStart: 400, presentIn: 2 },
  ]);
  assert.deepEqual(ss.bySource.map((s) => [s.source, s.n, s.parts[0]]), [
    ["startup", 1, { part: "recalls", avg: 600 }],
    ["clear", 1, { part: "recalls", avg: 400 }],
  ]);
});

test("#463 window: only day files inside the window are read, and the route is ui-gated and retention-clamped", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-telemetry-logs-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "bastra-telemetry-settings-"));
  const settingsPath = join(settingsDir, "cli-settings.json");
  const now = Date.parse("2026-09-04T12:00:00.000Z");
  const line = (o: object) => JSON.stringify(o) + "\n";
  try {
    await writeFile(join(logDir, "events-2026-09-04.jsonl"), line({ kind: "hook_call", ts: "2026-09-04T11:00:00.000Z", latency_ms_total: 5 }) + "not json\n");
    await writeFile(join(logDir, "events-2026-09-03.jsonl"), line({ kind: "hook_call", ts: "2026-09-03T11:00:00.000Z", latency_ms_total: 7 }));
    await writeFile(join(logDir, "events-2026-08-01.jsonl"), line({ kind: "hook_call", ts: "2026-08-01T11:00:00.000Z", latency_ms_total: 9 }));
    const w = await readEventWindow(logDir, 2, now);
    assert.equal(w.files, 2, "the August file is never opened");
    assert.equal(w.events.length, 2, "the malformed line is skipped");
    assert.equal(w.from, "2026-09-03T11:00:00.000Z");
    assert.equal(w.to, "2026-09-04T11:00:00.000Z");
    const report = buildTelemetryReport(w, 2, T, 90);
    assert.equal(report.window.events, 2);
    assert.equal(report.window.retentionDays, 90);
    assert.equal(report.latency.lanes[0].median, 6);

    assert.equal(parseDays("/ui/telemetry", 90), 7);
    assert.equal(parseDays("/ui/telemetry?days=365", 90), 90, "clamped to retention — a longer window would promise data retention deleted");
    assert.equal(parseDays("/ui/telemetry?days=abc", 90), 7);
    assert.equal(parseDays("/ui/telemetry?days=0", 90), 7);

    const server = createServer((req, res) => {
      void handleUiTelemetry(req, res, req.url ?? "", { logDir, settingsPath, retentionDays: 90 });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const get = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        })
          .on("error", reject)
          .end();
      });
    try {
      const off = await get("/ui/telemetry");
      assert.equal(off.status, 404, "ui.enabled off → 404 like every other /ui route");
      await writeFile(settingsPath, JSON.stringify({ update: { mode: "notify" }, ui: { enabled: true } }));
      const on = await get("/ui/telemetry?days=90");
      assert.equal(on.status, 200);
      const body = JSON.parse(on.body) as { window: { days: number; events: number }; quality: unknown; contextTax: unknown };
      assert.equal(body.window.days, 90);
      assert.equal(body.window.events, 3);
      assert.ok(body.quality && body.contextTax);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  } finally {
    await rm(logDir, { recursive: true, force: true });
    await rm(settingsDir, { recursive: true, force: true });
  }
});

test("#458 budget shadow: per lane and per day, sessions affected, first crossing, changed budget flagged", async () => {
  const { summarizeBudgetShadow } = await import("../src/telemetry-report.js");
  const ev = (day: string, session_id: string, lane: string, tokens: number, would_drop: boolean, extra: object = {}) => ({
    kind: "budget_shadow", ts: ts(day), session_id, lane, tokens, budget: 1000, would_drop, ...extra,
  });
  const events: ReportEvent[] = [
    ev("2026-09-04", "s1", "session_hook_call", 700, false, { emission_index: 1 }),
    ev("2026-09-04", "s1", "prompt_hook_call", 400, true, { first_over: true, emission_index: 2 }),
    ev("2026-09-04", "s1", "hook_call", 100, true, { emission_index: 3 }),
    ev("2026-09-05", "s2", "session_hook_call", 300, false, { emission_index: 1 }),
    ev("2026-09-05", "s3", "prompt_hook_call", 900, false, { emission_index: 1, budget: 2000 }),
  ];
  const b = summarizeBudgetShadow(events)!;
  assert.equal(b.budget, 2000, "the latest decision's budget");
  assert.deepEqual(b.budgets, [1000, 2000]);
  assert.deepEqual([b.emissions, b.tokens, b.sessions, b.sessionsAffected, b.wouldDrop, b.tokensTrimmed], [5, 2400, 3, 1, 2, 500]);
  assert.deepEqual(b.byLane, [
    { lane: "session_hook_call", emissions: 2, tokens: 1000, wouldDrop: 0, tokensTrimmed: 0 },
    { lane: "prompt_hook_call", emissions: 2, tokens: 1300, wouldDrop: 1, tokensTrimmed: 400 },
    { lane: "hook_call", emissions: 1, tokens: 100, wouldDrop: 1, tokensTrimmed: 100 },
  ]);
  assert.deepEqual(b.daily, [
    { day: "2026-09-04", tokens: 1200, tokensTrimmed: 500, wouldDrop: 2, sessionsAffected: 1 },
    { day: "2026-09-05", tokens: 1200, tokensTrimmed: 0, wouldDrop: 0, sessionsAffected: 0 },
  ]);
  assert.equal(b.firstOverAtEmission, 2);
  assert.equal(summarizeBudgetShadow([]), null);
});
