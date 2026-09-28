/**
 * #708 — one session id across MCP and hook events.
 *
 * Hook events carry the Claude Code session in `session_id`; MCP tool events
 * carry the daemon's telemetry id there. The forwarder sends the Claude Code id
 * as `x-bastra-cc-session`, but only `load_memory` recorded it — so a join of
 * "sessions with a save suggestion" against "sessions that saved" read zero
 * whatever had happened (#662: "0 of 56", recounted from transcripts 23 of 44).
 *
 * Pinned here:
 *   - a forwarded call with the header stamps `caller_session` on recall and
 *     save_memory, and `session_id` stays the daemon's id (no renamed field);
 *   - a forwarded call without the header (Codex, Cursor) stamps `null`;
 *   - a call that is not forwarded at all leaves the field off;
 *   - the save-suggestion join finds the saving session through it, and falls
 *     back to `session_id` for rows that have none.
 *
 * Runner: `node --import tsx --import ../../scripts/test-env.mjs --test __tests__/caller-session-708.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { saveMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";
import { dispatchApi } from "../src/http-api-routes.js";
import { Telemetry } from "../src/telemetry.js";
import { aggregateSaveSuggestions } from "../src/save-suggestion-stats.js";
import { aggregate, renderStats } from "../src/cli/log-stats.js";

type Row = Record<string, unknown>;

async function harness(t: { after: (fn: () => unknown) => void }): Promise<{ deps: ToolDeps; logDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-708-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-708-logs-"));
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry({ logDir }), vaultPath: dir };
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { deps, logDir };
}

async function readRows(logDir: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (const f of (await readdir(logDir)).filter((n) => /^events-.*\.jsonl$/.test(n))) {
    for (const line of (await readFile(join(logDir, f), "utf8")).split("\n")) {
      if (line.trim()) rows.push(JSON.parse(line) as Row);
    }
  }
  return rows;
}

/** Telemetry is fire-and-forget; wait until the rows of `kind` are on disk. */
async function rowsOf(logDir: string, kind: string, n = 1): Promise<Row[]> {
  for (let i = 0; i < 100; i++) {
    const rows = (await readRows(logDir)).filter((r) => r.kind === kind);
    if (rows.length >= n) return rows;
    await delay(20);
  }
  throw new Error(`no ${kind} row written`);
}

function savePayload(id: string): Row {
  return {
    id,
    title: `Note ${id}`,
    type: "reference",
    summary: "A memory written by the #708 session-join test.",
    body: `Body of ${id}.`,
    topic_path: ["tests", "telemetry"],
    tags: ["tests"],
    scope: "testlabel",
    recall_when: [`session join probe ${id}`],
  };
}

test("#708: a forwarded call with the header stamps caller_session on save_memory and recall", async (t) => {
  const { deps, logDir } = await harness(t);
  const ctx = { toolDeps: deps, documentWriteEnabled: true, ccSessionId: "cc-session-1" };

  await dispatchApi("save_memory", savePayload("join-a"), ctx);
  await dispatchApi("recall", { query: "session join probe" }, ctx);

  const [save] = await rowsOf(logDir, "save_memory");
  assert.equal(save.caller_session, "cc-session-1");
  assert.notEqual(save.session_id, "cc-session-1", "session_id stays the daemon's telemetry id");
  assert.equal(typeof save.session_id, "string");

  const [recall] = await rowsOf(logDir, "recall");
  assert.equal(recall.caller_session, "cc-session-1");
});

test("#708: a forwarded call without the header records caller_session: null, no guess", async (t) => {
  const { deps, logDir } = await harness(t);
  await dispatchApi("save_memory", savePayload("join-b"), {
    toolDeps: deps,
    documentWriteEnabled: true,
    ccSessionId: null,
  });
  const [save] = await rowsOf(logDir, "save_memory");
  assert.equal(save.caller_session, null);
});

test("#708: a call that is not forwarded (stdio MCP, Mac app) leaves the field off", async (t) => {
  const { deps, logDir } = await harness(t);
  await saveMemoryHandler(deps, savePayload("join-c"));
  const [save] = await rowsOf(logDir, "save_memory");
  assert.equal("caller_session" in save, false);
});

test("#708: one forwarded save and one hook event of the same session join", async (t) => {
  const { deps, logDir } = await harness(t);
  const day = new Date().toISOString().slice(0, 10);
  // The Stop lane's row, as stop-lane.ts writes it: the Claude Code id in
  // session_id, one second in the past so the save comes after it.
  const suggestion = {
    kind: "save_eval_call",
    ts: new Date(Date.now() - 1000).toISOString(),
    session_id: "cc-session-9",
    suggested_count: 1,
  };
  await writeFile(join(logDir, `events-${day}.jsonl`), JSON.stringify(suggestion) + "\n", "utf8");

  await dispatchApi("save_memory", savePayload("join-d"), {
    toolDeps: deps,
    documentWriteEnabled: true,
    ccSessionId: "cc-session-9",
  });
  await rowsOf(logDir, "save_memory");

  const stats = aggregateSaveSuggestions(await readRows(logDir));
  assert.deepEqual(stats, {
    suggestedSessions: 1,
    savedSessions: 1,
    savedAfterSuggestion: 1,
    saves: 1,
    savesWithCallerSession: 1,
  });
  // Joined on session_id alone — the pre-#708 join — the same log reads zero.
  const rows = (await readRows(logDir)).map(({ caller_session: _drop, ...rest }) => rest);
  assert.equal(aggregateSaveSuggestions(rows)?.savedSessions, 0);
});

test("#708: the join counts suggested sessions, saves before/after, and falls back to session_id", () => {
  const rows: Row[] = [
    // Session A: suggestion, then a forwarded save.
    { kind: "save_eval_call", ts: "2026-09-28T10:00:00Z", session_id: "A", suggested_count: 2 },
    { kind: "save_memory", ts: "2026-09-28T10:05:00Z", session_id: "daemon-1", caller_session: "A" },
    // Session B: saved BEFORE its suggestion only — saved, not after.
    { kind: "save_memory", ts: "2026-09-28T11:00:00Z", session_id: "daemon-1", caller_session: "B" },
    { kind: "save_eval_call", ts: "2026-09-28T11:10:00Z", session_id: "B", suggested_count: 1 },
    // Session C: suggestion, no save.
    { kind: "save_eval_call", ts: "2026-09-28T12:00:00Z", session_id: "C", suggested_count: 1 },
    // A Stop call that suggested nothing is not a suggested session.
    { kind: "save_eval_call", ts: "2026-09-28T12:30:00Z", session_id: "D", suggested_count: 0 },
    // An old save row without caller_session: fallback key is the daemon id,
    // which matches no hook session — counted as a save, never as a join.
    { kind: "save_memory", ts: "2026-09-28T13:00:00Z", session_id: "daemon-0" },
    // A client without the header: null, same fallback.
    { kind: "save_memory", ts: "2026-09-28T13:05:00Z", session_id: "daemon-1", caller_session: null },
  ];
  assert.deepEqual(aggregateSaveSuggestions(rows), {
    suggestedSessions: 3,
    savedSessions: 2,
    savedAfterSuggestion: 1,
    saves: 4,
    savesWithCallerSession: 2,
  });
  assert.equal(aggregateSaveSuggestions(rows.filter((r) => r.kind === "save_memory")), null);

  // The same fold reaches `bastra logs --stats`.
  const text = renderStats(aggregate(rows), 1000);
  assert.match(text, /save suggestions — 3 session\(s\) got one, 2 of them saved \(67%\), 1 after the suggestion/);
  assert.match(text, /2 of 4 save\(s\) carry one — the rest cannot be joined, so this is a lower bound/);
});
