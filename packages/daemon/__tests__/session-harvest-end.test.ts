/**
 * #675 follow-ups to the after-session harvest:
 *   - SessionEnd books the session as finished, so the harvest does not wait
 *     for the 30-minute idle window; the adapter registers it with Stop.
 *   - Quotes the vault already holds are dropped before relaying.
 *   - `bastra logs --stats` gets a harvest line.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/session-harvest-end.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchIndex, Vault } from "@bastra-recall/core";
import { noteSessionForHarvest, runSessionHarvest, HARVEST_IDLE_MS } from "../src/session-harvest.js";
import { storedQuoteMatcher, weightedContainment } from "../src/harvest-vault-match.js";
import { loadTranscript, runStopLane } from "../src/stop-lane.js";
import { planHookEntries } from "../src/cli/adapters/claude-code.js";
import { aggregateHarvest } from "../src/save-suggestion-stats.js";
import { aggregate, renderStats } from "../src/cli/log-stats.js";

async function sandbox<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "harvest-end-"));
  const env: Record<string, string> = {
    BASTRA_TELEMETRY: "on",
    BASTRA_LOG_PATH: join(dir, "logs"),
    BASTRA_PENDING_SUGGESTIONS_PATH: join(dir, "pending.json"),
    BASTRA_DRAFTS_PATH: join(dir, "drafts.json"),
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

function claudeJsonl(rows: { role: string; content: unknown }[]): string {
  return rows.map((r) => JSON.stringify({ type: r.role, message: { role: r.role, content: r.content } })).join("\n");
}

const TRANSCRIPT = claudeJsonl([
  { role: "user", content: "wire up the release script" },
  { role: "assistant", content: [{ type: "text", text: "Should the script tag the release too?" }] },
  { role: "user", content: "Yes, and it must always sign the tag with the release key, never unsigned." },
  { role: "assistant", content: [{ type: "text", text: "Should the changelog be generated from commits?" }] },
  { role: "user", content: "No, the changelog is written by hand in the Unreleased section of the pull request." },
]);

async function harvestEvents(dir: string): Promise<Record<string, unknown>[]> {
  const files = await readdir(join(dir, "logs"));
  const rows: Record<string, unknown>[] = [];
  for (const f of files) {
    for (const line of (await readFile(join(dir, "logs", f), "utf8")).split("\n")) {
      if (line) rows.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return rows.filter((e) => e.kind === "session_harvest");
}

test("SessionEnd through the Stop lane: harvested on the next pass, no idle wait, even with a fresh transcript", async () => {
  await sandbox(async (dir) => {
    const transcript = join(dir, "sess.jsonl");
    await writeFile(transcript, TRANSCRIPT);
    const out = await runStopLane(
      { hook_event_name: "SessionEnd", session_id: "end-1", transcript_path: transcript, cwd: "/work/release-tool" },
      "http://127.0.0.1:1",
    );
    assert.equal(out, "{}");
    const queue = JSON.parse(await readFile(join(dir, "queue.json"), "utf8")) as { session_id: string; last_stop: number; ended_at?: number }[];
    assert.equal(queue[0].session_id, "end-1");
    assert.equal(queue[0].ended_at, queue[0].last_stop);

    const loadTurns = (p: string) => loadTranscript({ transcript_path: p });
    // One second later — far inside the idle window, the transcript just written.
    const r = await runSessionHarvest({ loadTurns, now: queue[0].last_stop + 1000 });
    assert.deepEqual(r, { harvested: 1, candidates: 2, stored: 0 });
    const events = await harvestEvents(dir);
    assert.equal(events[0].trigger, "session_end");
    assert.equal(events[0].stored_count, 0);
  });
});

test("a Stop after SessionEnd (resumed session) brings the idle rule back", async () => {
  await sandbox(async (dir) => {
    const transcript = join(dir, "sess.jsonl");
    await writeFile(transcript, TRANSCRIPT);
    const t0 = 1_000_000_000_000;
    await noteSessionForHarvest({ session_id: "end-2", transcript_path: transcript, ended: true, now: t0 });
    await noteSessionForHarvest({ session_id: "end-2", transcript_path: transcript, now: t0 + 5000 });
    const loadTurns = (p: string) => loadTranscript({ transcript_path: p });
    assert.deepEqual(await runSessionHarvest({ loadTurns, now: t0 + 6000 }), { harvested: 0, candidates: 0, stored: 0 });
    assert.equal(existsSync(join(dir, "pending.json")), false);
    // Ends again: due at once.
    await noteSessionForHarvest({ session_id: "end-2", transcript_path: transcript, ended: true, now: t0 + 7000 });
    assert.equal((await runSessionHarvest({ loadTurns, now: t0 + 8000 })).harvested, 1);
    assert.ok(t0 + 8000 - (t0 + 5000) < HARVEST_IDLE_MS);
  });
});

test("a quote the vault already holds is dropped before the cap and counted as stored", async () => {
  await sandbox(async (dir) => {
    const transcript = join(dir, "sess.jsonl");
    await writeFile(transcript, TRANSCRIPT);
    await noteSessionForHarvest({ session_id: "end-3", transcript_path: transcript, ended: true, now: 1000 });
    const r = await runSessionHarvest({
      loadTurns: (p) => loadTranscript({ transcript_path: p }),
      storedIn: () => (quote) => (/sign the tag/.test(quote) ? "release-tags-signed" : null),
      now: 2000,
    });
    assert.deepEqual(r, { harvested: 1, candidates: 1, stored: 1 });
    const pending = JSON.parse(await readFile(join(dir, "pending.json"), "utf8")) as { blocks: string }[];
    assert.doesNotMatch(pending[0].blocks, /sign the tag/);
    assert.match(pending[0].blocks, /written by hand/);
    assert.equal((await harvestEvents(dir))[0].stored_count, 1);
  });
});

test("everything already stored: nothing is relayed", async () => {
  await sandbox(async (dir) => {
    const transcript = join(dir, "sess.jsonl");
    await writeFile(transcript, TRANSCRIPT);
    await noteSessionForHarvest({ session_id: "end-4", transcript_path: transcript, ended: true, now: 1000 });
    const r = await runSessionHarvest({
      loadTurns: (p) => loadTranscript({ transcript_path: p }),
      storedIn: () => () => "some-id",
      now: 2000,
    });
    assert.deepEqual(r, { harvested: 1, candidates: 0, stored: 2 });
    assert.equal(existsSync(join(dir, "pending.json")), false);
  });
});

// ─── the vault check ─────────────────────────────────────────────────────────

function fakeVault(notes: Array<{ id: string; title: string; summary: string; body?: string }>): { vault: Vault; search: SearchIndex } {
  const mems = notes.map((n) => ({ fm: { id: n.id, title: n.title, summary: n.summary, tags: [], recall_when: [] }, body: n.body ?? "" }));
  const vault = { list: () => mems } as unknown as Vault;
  // Candidate generation is not under test: every note is a candidate.
  const search = { recall: () => mems.map((m) => ({ id: m.fm.id })) } as unknown as SearchIndex;
  return { vault, search };
}

test("vault check: the same words match, a new fact does not, function words weigh nothing in any language", () => {
  // Filler notes that make function words common — as in any vault of that language.
  const filler = Array.from({ length: 20 }, (_, i) => ({
    id: `filler-${i}`,
    title: `Notiz ${i}`,
    summary: `Das ist die Notiz ${i} und der Text dazu ist kurz`,
    body: `No, we keep it with the other notes; it is short.`,
  }));
  const { vault, search } = fakeVault([
    ...filler,
    { id: "staging-db", title: "Staging database", summary: "Staging always gets its own database, never shared with production." },
  ]);
  const match = storedQuoteMatcher(vault, search);
  assert.equal(match("No — staging always gets its own database, we never share it with production."), "staging-db");
  assert.equal(match("Releases are cut from the main branch after the tracker issue is closed."), null);
  // Shares only function words with the filler notes: not stored.
  assert.equal(match("Das ist die Regel und der Server läuft auf Port 8080"), null);
});

test("weightedContainment: weights decide, not the raw share of words", () => {
  const idf = (t: string): number => (t === "the" ? 0.01 : 1);
  assert.equal(weightedContainment(new Set(["the", "x"]), new Set(["the"]), idf) < 0.02, true);
  assert.equal(weightedContainment(new Set(["the", "x"]), new Set(["x"]), idf) > 0.98, true);
  assert.equal(weightedContainment(new Set(), new Set(["x"]), idf), 0);
});

// ─── registration ────────────────────────────────────────────────────────────

function commandsOf(entries: unknown[] | undefined): string[] {
  return (entries ?? []).flatMap((e) => ((e as { hooks?: unknown[] }).hooks ?? []).map((h) => (h as { command?: string }).command ?? ""));
}

test("adapter: SessionEnd is registered with Stop, on the Stop client, and kept with a preserved Stop", () => {
  const withStop = planHookEntries("install", {}, { includeStop: true, stubPresent: false });
  const end = commandsOf(withStop.after.SessionEnd);
  assert.equal(end.length, 1);
  assert.match(end[0], /stop-hook\.js$/);
  assert.match(end[0], /^BASTRA_HOOK_CLIENT=claude-code /);

  const without = planHookEntries("install", {}, { includeStop: false, stubPresent: false });
  assert.equal(commandsOf(without.after.SessionEnd).length, 0);

  // An earlier opt-in to Stop, written before SessionEnd existed: the rerun keeps Stop and adds SessionEnd.
  const preserved = planHookEntries(
    "install",
    { Stop: withStop.after.Stop },
    { includeStop: false, stubPresent: false },
  );
  assert.equal(preserved.stopPreserved, true);
  assert.equal(commandsOf(preserved.after.SessionEnd).length, 1);

  const removed = planHookEntries("uninstall", { SessionEnd: withStop.after.SessionEnd }, { includeStop: false, stubPresent: false });
  assert.equal(commandsOf(removed.after.SessionEnd).length, 0);
});

// ─── stats ───────────────────────────────────────────────────────────────────

test("stats: harvest line joins the delivering session start to later saves on caller_session", () => {
  const rows: Record<string, unknown>[] = [
    { kind: "session_harvest", ts: "2026-09-28T10:00:00Z", session_id: "a", candidate_count: 2, stored_count: 1, trigger: "session_end" },
    { kind: "session_harvest", ts: "2026-09-28T10:05:00Z", session_id: "b", candidate_count: 1, stored_count: 0, trigger: "idle" },
    { kind: "session_hook_call", ts: "2026-09-28T11:00:00Z", session_id: "c", pending_harvest: 1 },
    { kind: "session_hook_call", ts: "2026-09-28T11:30:00Z", session_id: "d", pending_harvest: 1 },
    { kind: "session_hook_call", ts: "2026-09-28T11:40:00Z", session_id: "e" },
    // c saves after its start (joined on caller_session), d saved only before.
    { kind: "save_memory", ts: "2026-09-28T11:10:00Z", session_id: "daemon-x", caller_session: "c" },
    { kind: "save_memory", ts: "2026-09-28T11:20:00Z", session_id: "daemon-x", caller_session: "d" },
    { kind: "save_memory", ts: "2026-09-28T11:50:00Z", session_id: "daemon-x", caller_session: "e" },
  ];
  assert.deepEqual(aggregateHarvest(rows), {
    harvestedSessions: 2,
    skippedSessions: 0,
    candidates: 3,
    stored: 1,
    bySessionEnd: 1,
    deliveredSessions: 2,
    savedAfterDelivery: 1,
  });
  assert.equal(aggregateHarvest(rows.filter((r) => r.kind === "save_memory")), null);

  // #887: a row with `skipped_reason` is a session the job could NOT read —
  // it has its own count and never raises "session(s) read".
  const skipped = { kind: "session_harvest", ts: "2026-09-28T10:06:00Z", session_id: "r", candidate_count: 0, stored_count: 0, trigger: "session_end", skipped_reason: "transcript_path not readable: ENOENT" };
  const withSkipped = aggregateHarvest([...rows, skipped]);
  assert.equal(withSkipped?.harvestedSessions, 2);
  assert.equal(withSkipped?.bySessionEnd, 1);
  assert.equal(withSkipped?.skippedSessions, 1);
  assert.match(
    renderStats(aggregate([...rows, skipped]), 600),
    /session harvest — 2 session\(s\) read \(1 on SessionEnd\), 3 quote\(s\) relayed, 1 already in the vault, 1 skipped \(transcript not readable on this host\)/,
  );
  assert.equal(aggregateHarvest([skipped])?.harvestedSessions, 0, "a window of skipped sessions only still reports them");
  const text = renderStats(aggregate(rows), 600);
  assert.match(text, /session harvest — 2 session\(s\) read \(1 on SessionEnd\), 3 quote\(s\) relayed, 1 already in the vault/);
  assert.match(text, /delivered to 2 session start\(s\), 1 of them saved afterwards/);
});
