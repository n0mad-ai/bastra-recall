/**
 * `bastra doctor --replay` (#702) — the three checks the issue asks for, plus
 * the transcript reader:
 *
 *  (a) a replay never writes to the vault — run against a read-only copy,
 *      every file byte-identical afterwards, nothing new in the folder;
 *  (b) replay rows never enter the live numbers — they land in
 *      `replay-YYYY-MM-DD.jsonl`, never in `events-*.jsonl`, and the readouts'
 *      eval filter drops them even if one did;
 *  (c) the same transcripts and settings give the same report twice.
 *
 * (a) and (b) run the real daemon in-process: real vault, real `/hook/prompt`
 * in replay mode, real loopback recall and reflex — the one path the user's
 * report comes from.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/doctor-replay.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { startHttpServer } from "../src/http.js";
import { eventLogFile } from "../src/telemetry-sink.js";
import { isEvalTraffic } from "../src/telemetry-dimensions.js";
import {
  formatReplayDiff,
  formatReplayReport,
  parseDays,
  postReplayTurn,
  readClaudeTranscripts,
  replayAndReport,
  runReplay,
  summarizeReplay,
  type ReplayCorpus,
  type ReplayRow,
  type ReplayTurn,
} from "../src/cli/doctor-replay.js";

function memoryMarkdown(id: string, title: string, recallWhen: string[], extra: string[] = []): string {
  const ts = "2026-10-01T00:00:00.000Z";
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: lesson",
    `summary: ${title}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: replay-test",
    "recall_when:",
    ...recallWhen.map((r) => `  - ${r}`),
    ...extra,
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `Body for ${title}.`,
    "",
  ].join("\n");
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const st = await stat(path);
    if (st.isDirectory()) {
      for (const [k, v] of Object.entries(await snapshot(path))) out[`${name}/${k}`] = v;
    } else {
      out[name] = `${st.size}:${(await readFile(path)).toString("base64")}`;
    }
  }
  return out;
}

interface Daemon {
  port: number;
  vaultDir: string;
  logDir: string;
  telemetry: Telemetry;
  close: () => Promise<void>;
}

async function makeDaemon(): Promise<Daemon> {
  const vaultDir = await mkdtemp(join(tmpdir(), "bastra-replay-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-replay-logs-"));
  await writeFile(join(vaultDir, "alpha.md"), memoryMarkdown("alpha", "alpha bravo charlie", ["alpha bravo charlie"]), "utf8");
  await writeFile(join(vaultDir, "delta.md"), memoryMarkdown("delta", "delta echo foxtrot", ["delta echo foxtrot"]), "utf8");
  // A reflex memory: `/hook/reflex` serves it without any recall, so it is
  // the one hint that only the reflex route could anchor in the join state.
  await writeFile(
    join(vaultDir, "golf.md"),
    memoryMarkdown("golf", "golf hotel india", ["golf hotel india"], ["recall_mode: reflex"]),
    "utf8",
  );
  const vault = new Vault(vaultDir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  // The lane and the sink both resolve the log dir from the environment at
  // write time — point both at this test's folder for the whole daemon life.
  const prevLog = process.env.BASTRA_LOG_PATH;
  process.env.BASTRA_LOG_PATH = logDir;
  const telemetry = new Telemetry();
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: vaultDir },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
  });
  return {
    port: handle.port!,
    vaultDir,
    logDir,
    telemetry,
    close: async () => {
      if (prevLog === undefined) delete process.env.BASTRA_LOG_PATH;
      else process.env.BASTRA_LOG_PATH = prevLog;
      search.stop();
      await vault.stop?.();
      await handle.close();
      await rm(vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

function turn(session: string, at: number, text: string): ReplayTurn {
  return { session, cwd: null, at, text };
}

const CORPUS: ReplayCorpus = {
  turns: [
    turn("s1", 1, "where is alpha bravo charlie?"),
    turn("s1", 2, "<task-notification>\n<status>done</status>\n</task-notification>"),
    turn("s1", 3, "ok"),
    turn("s2", 1, "find delta echo foxtrot please"),
    turn("s2", 2, "where is alpha bravo charlie?"),
  ],
  loadedIds: new Set(["alpha"]),
  files: 2,
  sessions: 2,
};

async function settle(): Promise<void> {
  // Telemetry writes are fire-and-forget behind the response.
  await new Promise((r) => setTimeout(r, 150));
}

test("(a)+(b): a replay against a read-only vault changes nothing and files its rows apart from live traffic", async () => {
  const d = await makeDaemon();
  try {
    for (const name of await readdir(d.vaultDir)) await chmod(join(d.vaultDir, name), 0o444).catch(() => {});
    await chmod(d.vaultDir, 0o555);
    const before = await snapshot(d.vaultDir);

    const rows = await runReplay(CORPUS, postReplayTurn(`http://127.0.0.1:${d.port}`), { run: "r1" });
    await settle();

    assert.equal(rows.length, CORPUS.turns.length, "every turn gets a row");
    const system = rows.filter((r) => r.origin === "system");
    assert.equal(system.length, 1, "the task notification is tagged, not dropped");
    assert.ok(rows.every((r) => typeof r.session_id === "string" && r.session_id.startsWith("replay-r1-")), "replay session ids");
    const hinted = rows.flatMap((r) => r.hinted_ids ?? []);
    assert.ok(hinted.includes("alpha"), `the retrieval prompt gets its hint (${JSON.stringify(rows)})`);

    assert.deepEqual(await snapshot(d.vaultDir), before, "(a) no vault file changed, none added");

    const files = (await readdir(d.logDir)).sort();
    assert.ok(files.some((f) => f.startsWith("replay-") && f.endsWith(".jsonl")), `replay file written: ${files}`);
    assert.ok(!files.some((f) => f.startsWith("events-")), `(b) no live event file: ${files}`);
    const replayRows = (await readFile(join(d.logDir, files.find((f) => f.startsWith("replay-"))!), "utf8"))
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; dimensions?: { client?: string } });
    const kinds = new Set(replayRows.map((r) => r.kind));
    assert.ok(kinds.has("prompt_hook_call"), `lane rows in the replay file: ${[...kinds]}`);
    assert.ok(kinds.has("hook_recall"), `recall rows in the replay file: ${[...kinds]}`);
    for (const r of replayRows.filter((r) => r.kind === "prompt_hook_call" || r.kind === "hook_recall")) {
      assert.equal(r.dimensions?.client, "replay", `tagged: ${JSON.stringify(r)}`);
      assert.ok(isEvalTraffic(r), "the readouts' eval filter drops it too");
    }
  } finally {
    await chmod(d.vaultDir, 0o755).catch(() => {});
    for (const name of await readdir(d.vaultDir).catch(() => [] as string[])) await chmod(join(d.vaultDir, name), 0o644).catch(() => {});
    await d.close();
  }
});

test("(b) a replayed reflex hit leaves no join anchor a real load_memory could close", async () => {
  const d = await makeDaemon();
  try {
    const corpus: ReplayCorpus = {
      turns: [turn("s1", 1, "what about golf hotel india today?")],
      loadedIds: new Set(),
      files: 1,
      sessions: 1,
    };
    const rows = await runReplay(corpus, postReplayTurn(`http://127.0.0.1:${d.port}`), { run: "rx" });
    await settle();
    assert.ok((rows[0].hinted_ids ?? []).includes("golf"), `the reflex fired in the replay: ${JSON.stringify(rows)}`);
    assert.equal(d.telemetry.findHookHintFor("golf"), null, "no hook-hint anchor for the replayed reflex hit");
  } finally {
    await d.close();
  }
});

test("(b) unit: the sink routes a replay row by client or by session prefix, a live row stays in events-*", () => {
  const ts = "2026-10-20T10:00:00.000Z";
  assert.equal(eventLogFile("/l", ts, { session_id: "abc", dimensions: { client: "claude-code" } }), "/l/events-2026-10-20.jsonl");
  assert.equal(eventLogFile("/l", ts, { session_id: "abc", dimensions: { client: "replay" } }), "/l/replay-2026-10-20.jsonl");
  assert.equal(eventLogFile("/l", ts, { session_id: "replay-r1-abc" }), "/l/replay-2026-10-20.jsonl");
  assert.equal(isEvalTraffic({ dimensions: { client: "replay" } }), true);
  assert.equal(isEvalTraffic({ dimensions: { client: "claude-code" } }), false);
});

test("(c) the same turns and the same lane give the same report twice", async () => {
  const d = await makeDaemon();
  try {
    const post = postReplayTurn(`http://127.0.0.1:${d.port}`);
    const strip = (rows: ReplayRow[]): ReplayRow[] => rows.map((r) => ({ ...r, latency_ms_total: 0 }));
    const first = strip(await runReplay(CORPUS, post, { run: "a" }));
    const second = strip(await runReplay(CORPUS, post, { run: "b" }));
    const meta = { days: 14, sinceMs: Date.parse("2026-10-06T00:00:00.000Z") };
    const corpus = { ...CORPUS, turns: CORPUS.turns.length };
    const r1 = summarizeReplay(first.map((r) => ({ ...r, session_id: null })), corpus, meta);
    const r2 = summarizeReplay(second.map((r) => ({ ...r, session_id: null })), corpus, meta);
    assert.deepEqual(r1, r2);
    assert.equal(formatReplayReport(r1), formatReplayReport(r2));
    // Session dedup inside one session: the repeated alpha prompt in s2 is a
    // second session, so it hints again; the numbers below pin the shape.
    assert.equal(r1.system_turns, 1);
    assert.equal(r1.owner_prompts, 4);
    assert.equal(r1.gated_prompts, 1);
    assert.ok(r1.prompts_with_hint >= 2, JSON.stringify(r1));
    assert.ok(r1.slots_on_loaded >= 1, "alpha was loaded in the window");
    await settle();
  } finally {
    await d.close();
  }
});

test("summarizeReplay is pure and the top-ten share counts slots, not prompts", () => {
  const rows: ReplayRow[] = [
    { session_id: "replay-x-1", status: "ok", detected_mode: "retrieval", hinted_ids: ["a", "b"], latency_ms_total: 100 },
    { session_id: "replay-x-1", status: "ok", detected_mode: "generic", hinted_ids: ["a"], latency_ms_total: 300, bridges_fired: ["br1"] },
    { session_id: "replay-x-1", status: "gated", detected_mode: "none", gated: true, hinted_ids: [], latency_ms_total: 1 },
    { session_id: "replay-x-2", status: "gated", detected_mode: "none", gated: true, origin: "system", latency_ms_total: 1 },
    { session_id: "replay-x-2", status: "no-hits", detected_mode: "generic", hinted_ids: [], latency_ms_total: 200, bridges_fired: ["br1", "br2"] },
  ];
  const corpus = { loadedIds: new Set(["b"]), files: 1, sessions: 2, turns: 5 };
  const r = summarizeReplay(rows, corpus, { days: 3, sinceMs: Date.parse("2026-10-17T00:00:00.000Z") });
  assert.equal(r.system_turns, 1);
  assert.equal(r.owner_prompts, 4);
  assert.equal(r.gated_prompts, 1);
  assert.equal(r.prompts_with_hint, 2);
  assert.equal(r.slots, 3);
  assert.deepEqual(r.top_notes, [{ id: "a", slots: 2 }, { id: "b", slots: 1 }]);
  assert.equal(r.slots_on_loaded, 1);
  assert.deepEqual(r.bridges, [{ id: "br1", fires: 2 }, { id: "br2", fires: 1 }]);
  assert.deepEqual(r.latency, { n: 3, p50_ms: 200, p95_ms: 300 });
  assert.deepEqual(r.statuses, { gated: 1, "no-hits": 1, ok: 2 });
  assert.deepEqual(r.modes, { generic: 2, retrieval: 1 });
  assert.equal(r.since, "2026-10-17");
  const text = formatReplayReport(r);
  assert.match(text, /system turns\s+1 \(20%\)/);
  assert.match(text, /with a hint\s+2 \(50% of owner prompts\)/);
  assert.match(text, /ten most frequent notes\s+3 slots \(100%\)/);
  assert.match(text, /never counted with live traffic/);
});

test("readClaudeTranscripts: user turns with cwd, system turns kept, tool results and meta echoes and sidechains skipped, load_memory ids collected", async () => {
  const root = await mkdtemp(join(tmpdir(), "bastra-replay-projects-"));
  try {
    const proj = join(root, "-Users-me-proj");
    await mkdir(proj, { recursive: true });
    const at = (s: number): string => new Date(Date.parse("2026-10-19T12:00:00.000Z") + s * 1000).toISOString();
    const rows = [
      { type: "user", timestamp: at(1), cwd: "/Users/me/proj", message: { role: "user", content: "fix the parser" } },
      { type: "user", timestamp: at(2), cwd: "/Users/me/proj", message: { role: "user", content: [{ type: "tool_result", content: "out" }] } },
      { type: "user", timestamp: at(3), isMeta: true, message: { role: "user", content: "<command-name>/foo</command-name>" } },
      { type: "user", timestamp: at(4), isSidechain: true, message: { role: "user", content: "subagent prompt" } },
      { type: "user", timestamp: at(5), cwd: "/Users/me/proj", message: { role: "user", content: "<task-notification>\n<status>done</status>\n</task-notification>" } },
      { type: "assistant", timestamp: at(6), message: { role: "assistant", content: [{ type: "tool_use", name: "mcp__bastra-recall__load_memory", input: { id: "note-1" } }] } },
      { type: "user", timestamp: at(7), message: { role: "user", content: [{ type: "text", text: "old turn" }] } },
    ];
    await writeFile(join(proj, "sess-1.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    // A transcript older than the window is skipped by mtime before parsing.
    const corpus = await readClaudeTranscripts(root, Date.parse("2026-10-19T00:00:00.000Z"), Date.parse("2026-10-19T12:00:06.500Z"));
    assert.equal(corpus.files, 1);
    assert.equal(corpus.sessions, 1);
    assert.deepEqual(
      corpus.turns.map((t) => [t.session, t.cwd, t.text.slice(0, 19)]),
      [["sess-1", "/Users/me/proj", "fix the parser"], ["sess-1", "/Users/me/proj", "<task-notification>"]],
    );
    assert.deepEqual([...corpus.loadedIds], ["note-1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("without transcripts the replay is not evaluable, exit 0, and no daemon is asked", async () => {
  const root = await mkdtemp(join(tmpdir(), "bastra-replay-empty-"));
  try {
    const { report, code } = await replayAndReport({ days: 14, projectsDir: root });
    assert.equal(code, 0);
    assert.equal(report.evaluable, false);
    assert.match((report as { reason: string }).reason, /no Claude Code transcripts in the last 14 days/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--compare prints both columns with deltas and warns when the turn sets differ", () => {
  const base: ReplayRow[] = [
    { session_id: null, status: "ok", detected_mode: "generic", hinted_ids: ["a"], latency_ms_total: 100 },
  ];
  const corpus = { loadedIds: new Set<string>(), files: 1, sessions: 1, turns: 1 };
  const meta = { days: 3, sinceMs: Date.parse("2026-10-17T00:00:00.000Z") };
  const saved = summarizeReplay(base, corpus, meta);
  const now = summarizeReplay([...base, { session_id: null, status: "timeout", detected_mode: "generic", hinted_ids: [], latency_ms_total: 900 }], { ...corpus, turns: 2 }, meta);
  const text = formatReplayDiff(saved, now);
  assert.match(text, /turn sets differ/);
  assert.match(text, /hint slots\s+1\s+1\s+\(\+0\)/);
  assert.match(text, /timeouts\s+0\s+1\s+\(\+1\)/);
  assert.match(text, /latency p95 ms\s+100\s+900\s+\(\+800\)/);
  assert.doesNotMatch(formatReplayDiff(saved, saved), /turn sets differ/);
});

test("--days takes a whole number of days", () => {
  assert.equal(parseDays(null), 14);
  assert.equal(parseDays("3"), 3);
  assert.deepEqual(parseDays("x"), { error: "--days needs a whole number of days between 1 and 365, got 'x'" });
  assert.deepEqual(parseDays("0"), { error: "--days needs a whole number of days between 1 and 365, got '0'" });
});
