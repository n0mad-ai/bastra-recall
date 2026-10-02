/**
 * #675: after-session harvest — the Stop lane books a session, a daemon job
 * reads its transcript once it has gone quiet and relays what the user said
 * that the session did not save. Synthetic transcripts only; nothing here
 * writes to a vault.
 *
 * Run: node --import tsx --test packages/daemon/__tests__/session-harvest.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  harvestCandidates,
  noteSessionForHarvest,
  runSessionHarvest,
  HARVEST_IDLE_MS,
  type HarvestTurn,
} from "../src/session-harvest.js";
import { loadTranscript, parseTranscriptFile, runStopLane } from "../src/stop-lane.js";

const u = (content: string): HarvestTurn => ({ role: "user", content });
const a = (content: string, tools?: string[]): HarvestTurn => ({ role: "assistant", content, ...(tools ? { tools } : {}) });

test("answer: a substantive reply to the agent's question is a candidate, a bare yes is not", () => {
  const turns = [
    u("set up the deploy"),
    a("I can deploy.\nShould staging use the same database as production?"),
    u("No — staging always gets its own database, we never share it with production."),
    a("Understood. Proceed with the migration?"),
    u("yes"),
  ];
  const c = harvestCandidates(turns);
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, "answer");
  assert.equal(c[0].turn, 2);
  assert.match(c[0].context ?? "", /same database/);
});

test("language-neutral: the same shapes fire in Polish, Japanese and Arabic", () => {
  const pl = harvestCandidates([
    a("Którą bazę danych mam użyć?"),
    u("Zawsze używamy osobnej bazy dla środowiska testowego, nigdy produkcyjnej."),
  ]);
  assert.equal(pl[0]?.kind, "answer");
  const ja = harvestCandidates([
    a("どちらのデータベースを使いますか？"),
    u("テスト環境には必ず別のデータベースを使ってください本番とは絶対に共有しません"),
  ]);
  assert.equal(ja[0]?.kind, "answer");
  const ar = harvestCandidates([
    a("هل نستخدم نفس قاعدة البيانات؟"),
    u("لا، بيئة الاختبار تستخدم دائما قاعدة بيانات منفصلة عن الإنتاج"),
  ]);
  assert.equal(ar[0]?.kind, "answer");
});

test("restated and correction: re-explaining and interrupting are candidates, ranked first", () => {
  const turns = [
    u("please keep the changelog entries in English, the repository is public"),
    a("done"),
    u("fix the parser"),
    a("working on it"),
    u("[Request interrupted by user for tool use]"),
    u("do not touch the generated files under dist, only edit the sources"),
    a("ok"),
    u("again: keep the changelog entries in English, this repository is public!"),
  ];
  const c = harvestCandidates(turns);
  assert.deepEqual(c.map((x) => x.kind), ["restated", "correction"]);
  assert.equal(c[0].turn, 7);
  assert.equal(c[1].turn, 5);
});

test("a candidate the session saved afterwards is dropped; `from` skips harvested turns", () => {
  const turns = [
    a("Which branch do releases come from?"),
    u("Releases are always cut from the main branch after the tracker issue is closed."),
    a("Saving that.", ["mcp__bastra-recall__save_memory"]),
  ];
  assert.equal(harvestCandidates(turns).length, 0);
  const unsaved = turns.slice(0, 2);
  assert.equal(harvestCandidates(unsaved).length, 1);
  assert.equal(harvestCandidates(unsaved, 2).length, 0, "already harvested up to turn 2");
});

test("pastes and system-injected turns are never candidates", () => {
  const turns = [
    a("What does the log say?"),
    u("x".repeat(50) + " ".repeat(10) + "log line ".repeat(300)),
    { role: "system-injected", content: "<task-notification>agent finished, what next?</task-notification>" },
  ];
  assert.equal(harvestCandidates(turns).length, 0);
});

test("#701 — a row the client injected (isMeta) is not quoted as the user", () => {
  const question = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Should staging share the production database?" }] } };
  const feedback =
    "Stop hook feedback:\nbastra-recall memory check. Judge each line from this conversation and save it via save_memory if it holds.";
  const jsonl = (isMeta: boolean): string =>
    [question, { type: "user", ...(isMeta ? { isMeta } : {}), message: { role: "user", content: feedback } }]
      .map((r) => JSON.stringify(r))
      .join("\n");

  const turns = parseTranscriptFile(jsonl(true));
  assert.equal(turns[1].role, "system-injected");
  assert.equal(harvestCandidates(turns).length, 0);
  // Revert-check: only the flag tells this row from an answer — no prefix does.
  assert.equal(harvestCandidates(parseTranscriptFile(jsonl(false)))[0]?.kind, "answer");
});

test("#701 — Codex harness wrappers are not quoted as the user", () => {
  const codex = (role: string, text: string): object => ({
    type: "response_item",
    payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
  });
  const rollout = (userText: string): string =>
    [codex("assistant", "Which database should staging use?"), codex("user", userText)].map((r) => JSON.stringify(r)).join("\n");
  const wrappers = [
    "<environment_context>\n  <current_date>2026-09-14</current_date>\n  <timezone>Europe/Berlin</timezone>\n  <filesystem><workspace_roots><root>/work/repo</root></workspace_roots></filesystem>\n</environment_context>",
    '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call_1\\",0]","question":"Which database should staging use?","answer":"Its own one, never the production database"}]\n</send_user_message_question_reply>',
    "<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n</recommended_plugins>",
    '<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n</codex_internal_context>',
  ];
  for (const wrapper of wrappers) {
    const turns = parseTranscriptFile(rollout(wrapper));
    assert.equal(turns[1].role, "system-injected", wrapper.slice(0, 40));
    assert.equal(harvestCandidates(turns).length, 0, wrapper.slice(0, 40));
  }
  // Only the start of the turn counts: a user who quotes the tag is still the user.
  const quoted = parseTranscriptFile(rollout("what does <environment_context> tell you about the timezone here?"));
  assert.equal(harvestCandidates(quoted)[0]?.kind, "answer");
});

async function sandbox<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-harvest-"));
  const env: Record<string, string> = {
    BASTRA_TELEMETRY: "on",
    BASTRA_LOG_PATH: join(dir, "logs"),
    BASTRA_PENDING_SUGGESTIONS_PATH: join(dir, "pending.json"),
    BASTRA_HARVEST_QUEUE_PATH: join(dir, "queue.json"),
    BASTRA_HOOK_STATE_DIR: join(dir, "state"),
  };
  const before = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn(dir);
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

/** A Claude Code transcript as JSONL rows. */
function claudeJsonl(rows: { role: string; content: unknown }[]): string {
  return rows.map((r) => JSON.stringify({ type: r.role, message: { role: r.role, content: r.content } })).join("\n");
}

test("end to end: Stop books, the job waits for quiet, relays once, and never re-harvests old turns", async () => {
  await sandbox(async (dir) => {
    const transcript = join(dir, "sess.jsonl");
    await writeFile(
      transcript,
      claudeJsonl([
        { role: "user", content: "wire up the release script" },
        { role: "assistant", content: [{ type: "text", text: "Should the script tag the release too?" }] },
        { role: "user", content: "Yes, and it must always sign the tag with the release key, never unsigned." },
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
      ]),
    );
    // The Stop lane books the session (no suggestion fires on this transcript).
    const out = await runStopLane(
      { hook_event_name: "Stop", session_id: "harvest-e2e-1", transcript_path: transcript, cwd: "/work/release-tool" },
      "http://127.0.0.1:1",
    );
    assert.equal(out, "{}");
    const queue = JSON.parse(await readFile(join(dir, "queue.json"), "utf8")) as { session_id: string; last_stop: number }[];
    assert.equal(queue[0].session_id, "harvest-e2e-1");
    const booked = queue[0].last_stop;

    const loadTurns = (p: string) => loadTranscript({ transcript_path: p });
    // Too early: the session is still active.
    assert.deepEqual(await runSessionHarvest({ loadTurns, now: booked + 1000 }), { harvested: 0, candidates: 0, stored: 0 });
    assert.equal(existsSync(join(dir, "pending.json")), false);

    // Quiet for the idle window, transcript untouched as long.
    const later = booked + HARVEST_IDLE_MS + 1000;
    const old = new Date(booked - 1000);
    await utimes(transcript, old, old);
    assert.deepEqual(await runSessionHarvest({ loadTurns, now: later }), { harvested: 1, candidates: 1, stored: 0 });
    const pending = JSON.parse(await readFile(join(dir, "pending.json"), "utf8")) as { blocks: string; lane?: string }[];
    assert.equal(pending.length, 1);
    assert.equal(pending[0].lane, undefined, "recency lane (#513)");
    assert.match(pending[0].blocks, /<session-harvest session="harvest-" project="release-tool">/);
    assert.match(pending[0].blocks, /\[answer\] \(answering: "Should the script tag the release too\?"\)/);
    assert.match(pending[0].blocks, /always sign the tag/);

    // A second pass finds nothing new to do.
    assert.deepEqual(await runSessionHarvest({ loadTurns, now: later + 1000 }), { harvested: 0, candidates: 0, stored: 0 });

    // The session resumes: the new Stop re-books it, only new turns are harvested.
    await noteSessionForHarvest({ session_id: "harvest-e2e-1", transcript_path: transcript, now: later + 2000 });
    assert.deepEqual(
      await runSessionHarvest({ loadTurns, now: later + 2000 + HARVEST_IDLE_MS }),
      { harvested: 1, candidates: 0, stored: 0 },
    );

    const events = (await readFile(join(dir, "logs", (await import("node:fs")).readdirSync(join(dir, "logs"))[0]), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.kind === "session_harvest");
    assert.equal(events.length, 2);
    assert.equal(events[0].candidate_count, 1);
    assert.equal(events[0].session_id, "harvest-e2e-1");
  });
});

test("BASTRA_SESSION_HARVEST=0 books nothing and harvests nothing; inline transcripts are not booked", async () => {
  await sandbox(async (dir) => {
    await noteSessionForHarvest({ session_id: "inline", transcript_path: undefined });
    assert.equal(existsSync(join(dir, "queue.json")), false);
    process.env.BASTRA_SESSION_HARVEST = "0";
    try {
      await noteSessionForHarvest({ session_id: "off", transcript_path: join(dir, "x.jsonl") });
      assert.equal(existsSync(join(dir, "queue.json")), false);
    } finally {
      delete process.env.BASTRA_SESSION_HARVEST;
    }
  });
});

async function logRows(dir: string, kind: string): Promise<Record<string, unknown>[]> {
  const logs = join(dir, "logs");
  if (!existsSync(logs)) return [];
  const { readdirSync } = await import("node:fs");
  const out: Record<string, unknown>[] = [];
  for (const f of readdirSync(logs)) {
    for (const l of (await readFile(join(logs, f), "utf8")).split("\n").filter(Boolean)) {
      const e = JSON.parse(l) as Record<string, unknown>;
      if (e.kind === kind) out.push(e);
    }
  }
  return out;
}

test("a booked session whose transcript this host cannot read leaves a harvest row naming why", async () => {
  // A remote daemon gets the client host's transcript_path: not on this disk.
  await sandbox(async (dir) => {
    const t0 = Date.now() - 2 * HARVEST_IDLE_MS;
    await noteSessionForHarvest({ session_id: "remote-1", transcript_path: join(dir, "elsewhere", "remote-1.jsonl"), now: t0 });
    await runSessionHarvest({ loadTurns: async () => [], now: Date.now() });
    const rows = await logRows(dir, "session_harvest");
    assert.equal(rows.length, 1, "the skipped session is visible in telemetry");
    assert.equal(rows[0].session_id, "remote-1");
    assert.equal(rows[0].candidate_count, 0);
    // #887 follow-up: the reason is `skipped_reason`, not `error` — the job
    // did not fail, the transcript is on another host.
    assert.match(String(rows[0].skipped_reason), /not readable: ENOENT/);
    assert.equal(rows[0].error, undefined);
  });
});

test("the Stop lane writes a row for a transcript it cannot read, with the reason", async () => {
  await sandbox(async (dir) => {
    const out = await runStopLane(
      { hook_event_name: "Stop", session_id: "stop-unreadable", transcript_path: join(dir, "elsewhere", "s.jsonl"), cwd: "/work" },
      "http://127.0.0.1:1",
    );
    assert.equal(out, "{}");
    const rows = (await logRows(dir, "save_eval_call")).filter((e) => e.session_id === "stop-unreadable");
    assert.equal(rows.length, 1, "the Stop lane ran and says so");
    assert.equal(rows[0].turn_count, 0);
    // #887 follow-up: `skipped_reason`, not `error` — `error` is the fail-open
    // backstop's field and counts as a lane failure in the release gate.
    assert.match(String(rows[0].skipped_reason), /not readable on this host: ENOENT/);
    assert.equal(rows[0].error, undefined);

    // A genuinely empty transcript is a row too, without an error.
    const empty = join(dir, "empty.jsonl");
    await writeFile(empty, "");
    await runStopLane({ hook_event_name: "Stop", session_id: "stop-empty", transcript_path: empty, cwd: "/work" }, "http://127.0.0.1:1");
    const emptyRows = (await logRows(dir, "save_eval_call")).filter((e) => e.session_id === "stop-empty");
    assert.equal(emptyRows.length, 1);
    assert.equal(emptyRows[0].error, undefined);
    assert.equal(emptyRows[0].skipped_reason, undefined);
  });
});
