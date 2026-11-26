/**
 * #1438 — finished telemetry days come from the app database (migration v3
 * "telemetry-days"), only the current UTC day from the log; the report stays
 * identical to reading every log file.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/telemetry-day-store.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFile, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { mkdtempSync, readdirSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { APP_MIGRATIONS, openAppDatabase, type AppDatabase } from "../src/app-database.js";
import { buildTelemetryReport, readEventWindow, type ReportEvent } from "../src/telemetry-report.js";
import { foldClientDuplicates } from "../src/cli/log-stats-phases.js";
import { isEvalTraffic } from "../src/telemetry-dimensions.js";
import { TELEMETRY_DAY_VERSION, TelemetryDayStore, slimEvent } from "../src/telemetry-day-store.js";
import { handleUiTelemetry } from "../src/webui-telemetry.js";

const T = { mustLoadScore: 100, scoreFloor: 30 };
const dbFixture = () => join(mkdtempSync(join(tmpdir(), "bastra-tdays-db-")), "recall.db");

test("migration v3 adds telemetry_days after a backup of v2, leaves tasks/chat rows alone, runs once", () => {
  const path = dbFixture();
  const v2 = openAppDatabase({ path, migrations: APP_MIGRATIONS.slice(0, 2) });
  v2.sqlite.prepare("INSERT INTO app_records(namespace,key,value) VALUES('tasks','t1','{\"title\":\"x\"}')").run();
  v2.sqlite.prepare("INSERT INTO chat_conversations(id,title,created_at,updated_at) VALUES('c1','hi',1,1)").run();
  v2.sqlite.prepare("INSERT INTO chat_messages(conversation_id,role,text,created_at) VALUES('c1','user','hi',1)").run();
  v2.close();

  const db = openAppDatabase({ path, migrations: APP_MIGRATIONS.slice(0, 3) });
  assert.equal(db.sqlite.prepare("PRAGMA user_version").get()?.user_version, 3);
  const cols = db.sqlite
    .prepare("PRAGMA table_info(telemetry_days)")
    .all()
    .map((r) => r.name);
  assert.deepEqual(cols, [
    "log_dir",
    "day",
    "version",
    "file_size",
    "file_mtime_ms",
    "event_count",
    "events_json_gz",
    "computed_at",
  ]);
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM app_records").get()?.n, 1);
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM chat_messages").get()?.n, 1);
  db.close();

  const backups = readdirSync(`${path}.backups`).filter((x) => x.startsWith("before-v3-"));
  assert.equal(backups.length, 1);
  const snap = new DatabaseSync(join(`${path}.backups`, backups[0]!), { readOnly: true });
  assert.equal(snap.prepare("PRAGMA user_version").get()?.user_version, 2);
  assert.equal(
    snap.prepare("SELECT name FROM sqlite_master WHERE name='telemetry_days'").get(),
    undefined,
    "backup is the state before v3"
  );
  assert.equal(snap.prepare("SELECT count(*) n FROM chat_messages").get()?.n, 1);
  snap.close();

  const all = readdirSync(`${path}.backups`);
  openAppDatabase({ path, migrations: APP_MIGRATIONS.slice(0, 3) }).close();
  assert.deepEqual(readdirSync(`${path}.backups`), all, "reopening migrates nothing and backs up nothing");
});

// A log spread over several UTC days with the cases that cross day boundaries:
// a session over midnight, a stub/daemon duplicate pair split by midnight, a
// restart window reaching into the next day, eval rows, malformed lines and
// large fields the report never reads.
const at = (iso: string) => iso;
const LOG: Record<string, Array<Record<string, unknown> | string>> = {
  "2026-09-01": [
    {
      kind: "hook_call",
      ts: at("2026-09-01T08:00:00.000Z"),
      session_id: "s1",
      hook_version: "1.0.0",
      status: "ok",
      daemon_reachable: true,
      hint_count: 2,
      top_score: 150,
      latency_ms_total: 40,
      hinted_ids: ["a", "b"],
      hinted_types: ["lesson", "decision"],
      hint_tokens_est: 120,
      candidate_pool: [{ id: "x", text: "y".repeat(200) }],
      query: "secret query",
    },
    {
      kind: "hook_recall",
      ts: at("2026-09-01T08:00:00.100Z"),
      session_id: "s1",
      recall_id: "r1",
      tool_name: "Write",
      latency_ms_recall: 30,
      score_kind: "rrf",
      hits: [
        { id: "a", score: 150, title: "t", extra: { big: "z".repeat(100) } },
        { id: "b", score: 60 },
      ],
      usage_suppressed: [{ id: "m1", type: "lesson", surfaced: 2 }],
      usage_suppressed_mode: "shadow",
      usage_suppressed_tokens_est: 40,
    },
    {
      kind: "evidence_decision",
      ts: at("2026-09-01T08:00:00.200Z"),
      session_id: "s1",
      recall_id: "r1",
      shadow: true,
      decisions: [
        { memory_id: "a", decision: "required", hop: "direct", evidence: { lexical_score: 150, trust: 0.9 } },
        { memory_id: "b", decision: "optional", abstain_reason: "hop_only", evidence: { lexical_score: 60 } },
      ],
    },
    {
      kind: "recall_episode",
      ts: at("2026-09-01T08:01:00.000Z"),
      session_id: "s1",
      recall_id: "r1",
      memory_id: "a",
      surfaced: true,
      band: "required",
      acted_on: true,
    },
    {
      kind: "load_memory",
      ts: at("2026-09-01T08:01:00.000Z"),
      session_id: "s1",
      id: "a",
      found: true,
      from_hook_recall: "r1",
      hook_hint_rank: 1,
      delivered_tokens_est: 300,
      presentation: "lean",
    },
    {
      kind: "budget_shadow",
      ts: at("2026-09-01T09:00:00.000Z"),
      session_id: "s1",
      lane: "hook_call",
      tokens: 700,
      budget: 1000,
      would_drop: false,
      emission_index: 1,
    },
    {
      kind: "session_hook_call",
      ts: at("2026-09-01T09:00:00.000Z"),
      session_id: "s1",
      source: "startup",
      latency_ms_total: 90,
      hint_tokens_est: 500,
      hint_tokens_by_part: { kernel: 300, recalls: 200 },
      pending_lanes: { recency: 1, recency_chars: 80 },
    },
    { kind: "save_memory", ts: at("2026-09-01T10:00:00.000Z"), session_id: "s1", caller_session: "s1", created: true },
    { kind: "save_hold", ts: at("2026-09-01T10:00:01.000Z"), session_id: "s1", reason: "claim_gate", claimed_count: 2 },
    {
      kind: "code_graph_refresh",
      ts: at("2026-09-01T11:00:00.000Z"),
      repo: "r",
      outcome: "failed",
      reason: "watcher",
      duration_ms: 5000,
      detail: "boom",
    },
    {
      kind: "code_tool_call",
      ts: at("2026-09-01T11:00:01.000Z"),
      tool: "find_code",
      status: "ok",
      took_ms: 0.4,
      repo: "r",
      files: ["a.ts"],
    },
    {
      kind: "hook_call",
      ts: at("2026-09-01T12:00:00.000Z"),
      session_id: "e1",
      hook_version: "1.0.0",
      status: "ok",
      latency_ms_total: 50,
      dimensions: { client: "eval", model: "m", huge: "q".repeat(100) },
    },
    "not json",
    { kind: "warmup_settle", ts: at("2026-09-01T23:59:30.000Z"), trigger: "boot" },
    {
      kind: "hook_call",
      ts: at("2026-09-01T23:59:59.900Z"),
      session_id: "s2",
      hook_version: "1.0.0",
      status: "ok",
      latency_ms_total: 45,
    },
  ],
  "2026-09-02": [
    // The stub row of the call above, 200 ms later — on the next day.
    {
      kind: "hook_call",
      ts: at("2026-09-02T00:00:00.100Z"),
      session_id: "s2",
      hook_version: "0.6.0-stub",
      status: "timeout",
      latency_ms_total: 900,
    },
    // Inside the restart window that started before midnight.
    {
      kind: "prompt_hook_call",
      ts: at("2026-09-02T00:01:00.000Z"),
      session_id: "s1",
      status: "ok",
      latency_ms_total: 700,
      hinted_ids: ["a"],
      hint_tokens_est: 50,
    },
    {
      kind: "budget_shadow",
      ts: at("2026-09-02T00:02:00.000Z"),
      session_id: "s1",
      lane: "prompt_hook_call",
      tokens: 400,
      budget: 1000,
      would_drop: true,
      first_over: true,
      emission_index: 2,
    },
    { kind: "ollama_lifecycle", ts: at("2026-09-02T06:00:00.000Z"), action: "prewarm", embed_calls_since_boot: 0 },
    {
      kind: "hook_recall",
      ts: at("2026-09-02T09:00:00.000Z"),
      session_id: "s3",
      recall_id: "r2",
      tool_name: "Bash",
      latency_ms_recall: 25,
      score_kind: "bm25",
      hits: [{ id: "d", score: 120 }],
    },
    {
      kind: "evidence_decision",
      ts: at("2026-09-02T09:00:00.100Z"),
      session_id: "s3",
      recall_id: "r2",
      decisions: [{ memory_id: "d", decision: "required", evidence: { lexical_score: 90 } }],
    },
    {
      kind: "save_eval_call",
      ts: at("2026-09-02T09:30:00.000Z"),
      session_id: "s3",
      caller_session: "s3",
      suggested_count: 1,
    },
    {
      kind: "save_memory",
      ts: at("2026-09-02T09:40:00.000Z"),
      session_id: "s3",
      caller_session: "s3",
      overwrite: true,
    },
    { kind: "recall", ts: at("2026-09-02T10:00:00.000Z"), latency_ms: 33, found: 3, payload_tokens_est: 200 },
    {
      kind: "bash_hook_call",
      ts: at("2026-09-02T11:00:00.000Z"),
      session_id: "s3",
      status: "ok",
      latency_ms_total: 20,
      hint_count: 1,
      hinted_ids: ["d"],
      hint_tokens_est: 30,
    },
  ],
  "2026-09-03": [
    {
      kind: "hook_call",
      ts: at("2026-09-03T07:00:00.000Z"),
      session_id: "s4",
      hook_version: "1.0.0",
      status: "ok",
      daemon_reachable: true,
      hint_count: 0,
      top_score: 20,
      latency_ms_total: 33,
    },
    {
      kind: "recall_episode",
      ts: at("2026-09-03T07:01:00.000Z"),
      session_id: "s4",
      recall_id: null,
      memory_id: "z",
      surfaced: false,
      band: "not_hinted",
      acted_on: true,
    },
    {
      kind: "evidence_decision",
      ts: at("2026-09-03T07:02:00.000Z"),
      session_id: "s4",
      recall_id: "r9",
      degraded: true,
      decisions: [{ memory_id: "z", decision: "no_answer" }],
    },
  ],
};

async function writeLog(dir: string): Promise<void> {
  for (const [day, rows] of Object.entries(LOG)) {
    await writeFile(
      join(dir, `events-${day}.jsonl`),
      rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n"
    );
  }
}

const report = (w: Awaited<ReturnType<typeof readEventWindow>>, days: number) => buildTelemetryReport(w, days, T, 90);
const rows = (db: AppDatabase) =>
  db.sqlite
    .prepare("SELECT day, version, event_count FROM telemetry_days ORDER BY day")
    .all()
    .map((r) => ({ ...r }));

test("same report as reading every log, cold and warm, across rolling windows and UTC day boundaries", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-tdays-logs-"));
  const db = openAppDatabase({ path: dbFixture() });
  try {
    await writeLog(logDir);
    const store = new TelemetryDayStore(db);
    // "now" values: mid-day, just after UTC midnight (still the previous
    // evening in the Americas, already morning in Asia), and the window's
    // first day cut in the middle (rolling cutoff).
    const nows = [
      "2026-09-03T12:00:00.000Z",
      "2026-09-03T00:00:30.000Z",
      "2026-09-04T08:30:00.000Z",
      "2026-09-02T23:59:59.999Z",
    ];
    for (const now of nows.map(Date.parse)) {
      for (const days of [1, 2, 3, 7]) {
        for (const includeEval of [false, true]) {
          const expected = report(await readEventWindow(logDir, days, now, includeEval), days);
          const cold = report(await readEventWindow(logDir, days, now, includeEval, store), days);
          const warm = report(await readEventWindow(logDir, days, now, includeEval, store), days);
          assert.deepEqual(cold, expected, `cold ${new Date(now).toISOString()} days=${days} eval=${includeEval}`);
          assert.deepEqual(warm, expected, `warm ${new Date(now).toISOString()} days=${days} eval=${includeEval}`);
        }
      }
    }
    assert.ok(
      report(await readEventWindow(logDir, 3, Date.parse("2026-09-03T12:00:00.000Z")), 3).window.foldedDuplicates === 1,
      "precondition: the duplicate pair across midnight is folded"
    );
    // The current UTC day is never stored; at 2026-09-04 every file is finished.
    assert.deepEqual(
      rows(db).map((r) => r.day),
      ["2026-09-01", "2026-09-02", "2026-09-03"]
    );
    const fresh = openAppDatabase({ path: dbFixture() });
    await readEventWindow(logDir, 7, Date.parse("2026-09-03T00:00:30.000Z"), false, new TelemetryDayStore(fresh));
    assert.deepEqual(
      rows(fresh).map((r) => r.day),
      ["2026-09-01", "2026-09-02"],
      "the day of now (UTC) is read live, not stored"
    );
    fresh.close();
  } finally {
    db.close();
    await rm(logDir, { recursive: true, force: true });
  }
});

test("a finished day is read again when its log grew or the stored version is outdated", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-tdays-logs-"));
  const db = openAppDatabase({ path: dbFixture() });
  try {
    await writeLog(logDir);
    const store = new TelemetryDayStore(db);
    const now = Date.parse("2026-09-04T08:30:00.000Z");
    await readEventWindow(logDir, 7, now, false, store);
    const before = rows(db).find((r) => r.day === "2026-09-02")!;

    // A hook writes a line with yesterday's timestamp after midnight.
    await appendFile(
      join(logDir, "events-2026-09-02.jsonl"),
      JSON.stringify({
        kind: "hook_call",
        ts: "2026-09-02T23:59:59.000Z",
        session_id: "s9",
        status: "ok",
        latency_ms_total: 12,
      }) + "\n"
    );
    const grown = report(await readEventWindow(logDir, 7, now, false, store), 7);
    assert.deepEqual(grown, report(await readEventWindow(logDir, 7, now), 7));
    assert.equal(rows(db).find((r) => r.day === "2026-09-02")!.event_count, Number(before.event_count) + 1);

    // An older aggregation version: the stored content is not trusted.
    db.sqlite
      .prepare("UPDATE telemetry_days SET version=?, events_json_gz=? WHERE day='2026-09-01'")
      .run(TELEMETRY_DAY_VERSION - 1, gzipSync("[]"));
    const rebuilt = report(await readEventWindow(logDir, 7, now, false, store), 7);
    assert.deepEqual(rebuilt, report(await readEventWindow(logDir, 7, now), 7));
    assert.deepEqual(
      rows(db).map((r) => r.version),
      [TELEMETRY_DAY_VERSION, TELEMETRY_DAY_VERSION, TELEMETRY_DAY_VERSION]
    );
  } finally {
    db.close();
    await rm(logDir, { recursive: true, force: true });
  }
});

test("the stored extract keeps every field the report reads", async () => {
  // Record every top-level read the whole pipeline (eval filter, fold, all
  // sections) makes on the raw events; each such field must survive slimEvent.
  const raw = Object.values(LOG)
    .flat()
    .filter((r): r is Record<string, unknown> => typeof r !== "string") as ReportEvent[];
  const read = new Map<ReportEvent, Set<string>>();
  const wrapped = raw.map((e) => {
    const keys = new Set<string>();
    read.set(e, keys);
    return new Proxy(e, {
      get(t, p, r) {
        if (typeof p === "string") keys.add(p);
        return Reflect.get(t, p, r);
      },
    });
  });
  for (const includeEval of [false, true]) {
    const kept = includeEval ? wrapped : wrapped.filter((e) => !isEvalTraffic(e));
    const { events } = foldClientDuplicates(kept);
    buildTelemetryReport(
      { events: events as ReportEvent[], files: 0, from: null, to: null, excludedEval: 0, foldedDuplicates: 0 },
      7,
      T,
      90
    );
  }
  for (const [e, keys] of read) {
    const slim = slimEvent(e);
    for (const k of keys) if (k in e) assert.ok(k in slim, `${e.kind}.${k} is read by the report but not stored`);
  }
  const big = slimEvent(raw[0]!) as Record<string, unknown>;
  assert.equal("candidate_pool" in big || "query" in big, false, "unread payload is not stored");
});

test("GET /ui/telemetry serves the stored days and drops rows whose log retention deleted", async (t) => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-tdays-logs-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "bastra-tdays-settings-"));
  const settingsPath = join(settingsDir, "cli-settings.json");
  await writeFile(settingsPath, JSON.stringify({ ui: { enabled: true } }));
  const db = openAppDatabase({ path: dbFixture() });
  const store = new TelemetryDayStore(db);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-04T08:30:00.000Z") });
  const server = createServer((req, res) => {
    void handleUiTelemetry(req, res, req.url ?? "", { logDir, settingsPath, retentionDays: 90, store: () => store });
  });
  try {
    await writeLog(logDir);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const get = () =>
      new Promise<string>((resolve, reject) => {
        request({ hostname: "127.0.0.1", port, path: "/ui/telemetry?days=7", method: "GET" }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve(body));
        })
          .on("error", reject)
          .end();
      });
    const expected = JSON.parse(JSON.stringify(report(await readEventWindow(logDir, 7, Date.now()), 7)));
    assert.deepEqual(JSON.parse(await get()), expected);
    assert.equal(rows(db).length, 3);
    await unlink(join(logDir, "events-2026-09-01.jsonl"));
    await get();
    assert.deepEqual(
      rows(db).map((r) => r.day),
      ["2026-09-02", "2026-09-03"]
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    await rm(logDir, { recursive: true, force: true });
    await rm(settingsDir, { recursive: true, force: true });
  }
});

test("GET /ui/telemetry keeps the finished report while the data is unchanged and matches a fresh computation at every moment", async (t) => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-tdays-cache-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "bastra-tdays-settings-"));
  const settingsPath = join(settingsDir, "cli-settings.json");
  await writeFile(settingsPath, JSON.stringify({ ui: { enabled: true } }));
  const db = openAppDatabase({ path: dbFixture() });
  const store = new TelemetryDayStore(db);
  let computed = 0;
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-03T12:00:00.000Z") });
  const server = createServer((req, res) => {
    void handleUiTelemetry(req, res, req.url ?? "", {
      logDir,
      settingsPath,
      retentionDays: 90,
      store: () => (computed++, store),
    });
  });
  try {
    await writeLog(logDir);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const get = (days: number) =>
      new Promise<unknown>((resolve, reject) => {
        request({ hostname: "127.0.0.1", port, path: `/ui/telemetry?days=${days}`, method: "GET" }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve(JSON.parse(body)));
        })
          .on("error", reject)
          .end();
      });
    const fresh = async (days: number) =>
      JSON.parse(JSON.stringify(report(await readEventWindow(logDir, days, Date.now()), days)));

    await get(2);
    assert.equal(computed, 1);
    await get(2);
    await get(2);
    assert.equal(computed, 1, "unchanged polls are served from memory");
    await get(1);
    assert.equal(computed, 2, "each window has its own entry");

    // Walk the clock across the window: a cached answer must always equal a
    // fresh computation, i.e. the cache drops exactly when a row leaves the
    // rolling window or a file enters/leaves it.
    const start = Date.now();
    for (let step = 0; step <= 60; step++) {
      t.mock.timers.setTime(start + step * 17 * 60 * 1000); // 17-minute steps over ~17 h
      for (const days of [1, 2]) assert.deepEqual(await get(days), await fresh(days), `step ${step} days=${days}`);
    }
    const afterWalk = computed;
    assert.ok(afterWalk < 2 + 2 * 61, "most steps were served from memory");
    assert.ok(afterWalk > 2, "rows leaving the window forced recomputation");

    // The current day's log grows: recomputed, and the new row is in it.
    await get(1);
    const before = computed;
    await appendFile(
      join(logDir, "events-2026-09-04.jsonl"),
      JSON.stringify({
        kind: "hook_call",
        ts: new Date(Date.now() - 1000).toISOString(),
        session_id: "s7",
        status: "ok",
        latency_ms_total: 9,
      }) + "\n"
    );
    assert.deepEqual(await get(1), await fresh(1));
    assert.equal(computed, before + 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    await rm(logDir, { recursive: true, force: true });
    await rm(settingsDir, { recursive: true, force: true });
  }
});

test(
  "a FIFO under a log name skips that day instead of waiting forever",
  { skip: process.platform === "win32" ? "no mkfifo on Windows" : false, timeout: 30_000 },
  async () => {
    const { execFileSync, spawn } = await import("node:child_process");
    const logDir = await mkdtemp(join(tmpdir(), "bastra-tdays-logs-"));
    const dbPath = dbFixture();
    try {
      await writeLog(logDir);
      await unlink(join(logDir, "events-2026-09-02.jsonl"));
      // A finished day (the stored-day path) and the running day (direct read).
      execFileSync("mkfifo", [join(logDir, "events-2026-09-02.jsonl")]);
      execFileSync("mkfifo", [join(logDir, "events-2026-09-04.jsonl")]);
      // The reads run in a child with a kill timer: a blocking open() of a FIFO
      // would freeze this test's own event loop and the whole test run.
      const src = (file: string) => JSON.stringify(new URL(`../src/${file}`, import.meta.url).href);
      const code = `const { isDeepStrictEqual } = await import("node:util");
const { openAppDatabase } = await import(${src("app-database.ts")});
const { buildTelemetryReport, readEventWindow } = await import(${src("telemetry-report.ts")});
const { TelemetryDayStore } = await import(${src("telemetry-day-store.ts")});
const db = openAppDatabase({ path: ${JSON.stringify(dbPath)} });
const now = Date.parse("2026-09-04T08:30:00.000Z");
const report = (w) => buildTelemetryReport(w, 7, ${JSON.stringify(T)}, 90);
const stored = await readEventWindow(${JSON.stringify(logDir)}, 7, now, false, new TelemetryDayStore(db));
const direct = await readEventWindow(${JSON.stringify(logDir)}, 7, now);
const days = db.sqlite.prepare("SELECT day FROM telemetry_days").all().map((r) => r.day);
db.close();
process.stdout.write(JSON.stringify({ same: isDeepStrictEqual(report(stored), report(direct)), days }));`;
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      let out = "";
      child.stdout!.on("data", (chunk) => (out += chunk));
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      const [status, signal] = await new Promise<[number | null, string | null]>((resolve) =>
        child.once("exit", (c, sig) => resolve([c, sig]))
      );
      clearTimeout(timer);
      assert.equal(signal, null, "reading the planted FIFO hung");
      assert.equal(status, 0);
      const result = JSON.parse(out) as { same: boolean; days: string[] };
      assert.equal(result.same, true, "the stored and the direct report agree");
      assert.ok(!result.days.includes("2026-09-02"), "nothing is stored for the planted day");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  }
);
