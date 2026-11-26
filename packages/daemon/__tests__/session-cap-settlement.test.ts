/**
 * #1743: a session-start section the context cap (#1336) cuts never reached
 * the assistant, so it must not be booked as delivered. Runs the whole lane
 * against a stub daemon whose rule kernel fills nearly all of the cap, then
 * against one with a small kernel, and checks the stored relay/draft state
 * and the telemetry after each start.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/session-cap-settlement.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { dispatchLaneRoutes } from "../src/http-lane-routes.js";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSessionLane, type SessionPayload } from "../src/session-lane.js";
import { readAppRecord } from "../src/app-record-store.js";
import { writePendingSuggestion, type PendingSuggestion } from "../src/pending-suggestions.js";
import { recordDraftReviewCandidates, takeDraftReview } from "../src/draft-review.js";
import { draftFingerprint, draftId, listDrafts, transactDrafts, upsertDraft, type Draft } from "../src/draft-store.js";
import { withPathLock } from "../src/path-lock.js";
import type { DraftPromotionEvent } from "../src/draft-promote.js";

const VAULT = "vault-1743";
const now = Date.now();

/** Big: four full always-rules plus an index fill ~9,370 of the 9,900 chars. */
function kernelEntries(big: boolean) {
  const rule = (id: string, rulebook: "always" | "on-demand", body: string) => ({
    id,
    title: `Rule ${id} about amber`,
    group: rulebook === "always" ? "floor" : "explicit",
    revision: "r1",
    updated: "2026-11-01",
    stale_status: "fresh",
    rulebook,
    applies_when: "when the amber database fixture is deployed in a release",
    body,
  });
  if (!big) return [rule("rule-0", "always", "Rule 0 body.")];
  return [
    ...Array.from({ length: 4 }, (_, i) =>
      rule(`rule-${i}`, "always", `Rule ${i} body. ` + "keep this rule in force ".repeat(80))
    ),
    ...Array.from({ length: 8 }, (_, i) => rule(`on-demand-rule-${i}`, "on-demand", "x")),
  ];
}

function sessionContext(big: boolean): string {
  return JSON.stringify({
    context: "",
    vault_size: 1,
    blocks: [],
    retrieval: "hybrid",
    budget: {},
    aborted: [],
    data: {
      recalls: [],
      floors: [],
      conventions: [],
      care: { open: 0, queued: 0 },
      imports: { open: 0, queued: 0 },
      onboarding: false,
      kernel: { entries: kernelEntries(big), omitted: 0 },
    },
  });
}

function draft(i: number): Draft {
  const quote = `Fixture deployments ${i} require an isolated amber database before the release starts.`;
  const fp = draftFingerprint(quote);
  return {
    id: draftId("fixture-" + i, 1, fp),
    fp,
    quote,
    kind: "typed",
    state: "open",
    vault_id: VAULT,
    situation: { project: "fixture", before: ["deploy"], after: ["test"], reads: [], lits: ["deploy"] },
    evidence: [
      { session_id: "fixture-" + i, turn: 1, ts: now },
      { session_id: "repeat-" + i, turn: 1, ts: now },
    ],
    surfaced: [],
    created: now,
    last_touched: now,
  };
}

async function seedDrafts(): Promise<string[]> {
  const ids: string[] = [];
  const snapshot = new Map<string, DraftPromotionEvent>();
  for (let i = 0; i < 2; i++) {
    const d = draft(i);
    await upsertDraft(d, now);
    ids.push(d.id);
    snapshot.set(d.id, {
      kind: "draft_would_promote",
      draft_ids: [d.id],
      evidence_count: 2,
      reason: "dry-run",
      judge_statement: "durable",
    } as DraftPromotionEvent);
  }
  await recordDraftReviewCandidates(snapshot, VAULT, now);
  return ids;
}

function pendingRows(): PendingSuggestion[] {
  try {
    return JSON.parse(readAppRecord("pending-suggestions", process.env.BASTRA_PENDING_SUGGESTIONS_PATH!));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; // consumed: the record is gone
    throw error;
  }
}

async function events(dir: string): Promise<Array<Record<string, unknown>>> {
  const logs = join(dir, "logs");
  const files = await readdir(logs).catch(() => [] as string[]);
  const text = (await Promise.all(files.map((f) => readFile(join(logs, f), "utf8")))).join("");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface Fixture {
  dir: string;
  url: string;
  setBig: (big: boolean) => void;
  closeDuringReview: (abort: () => void) => void;
  beforeAnswer: (callback: () => Promise<void>) => void;
}

async function fixture(work: (ctx: Fixture) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "session-cap-1743-"));
  const env: Record<string, string> = {
    BASTRA_DRAFTS_PATH: join(dir, "drafts.json"),
    BASTRA_PENDING_SUGGESTIONS_PATH: join(dir, "pending.json"),
    BASTRA_LOG_PATH: join(dir, "logs"),
    BASTRA_DRAFT_PROMOTE: "0",
    BASTRA_PENDING_RELAY: "1",
    BASTRA_SESSION_HARVEST: "1",
    BASTRA_DRAFT_HINTS: "1",
    BASTRA_TELEMETRY: "1",
  };
  const prev = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  let big = true;
  let abortDuringReview: (() => void) | undefined;
  let beforeAnswer: (() => Promise<void>) | undefined;
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const handled = dispatchLaneRoutes(
      req,
      res,
      req.method!,
      path,
      undefined,
      async (out) => {
        await beforeAnswer?.();
        return out;
      },
      async () => {
        const review = await takeDraftReview(VAULT, "en", now);
        if (abortDuringReview) {
          const closed = once(res, "close");
          abortDuringReview();
          await closed;
        }
        return review;
      }
    );
    if (handled) return;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(path === "/hook/session-context" ? sessionContext(big) : path === "/health" ? '{"ok":true}' : "{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await work({
      dir,
      url: `http://127.0.0.1:${port}`,
      setBig: (b) => (big = b),
      closeDuringReview: (abort) => (abortDuringReview = abort),
      beforeAnswer: (callback) => (beforeAnswer = callback),
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    for (const [k, v] of prev)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function start(url: string, sessionId: string): Promise<string> {
  const out = await runSessionLane(
    { hook_event_name: "SessionStart", source: "startup", session_id: sessionId, cwd: "/tmp" },
    url,
    undefined,
    async () => null,
    () => takeDraftReview(VAULT, "en", now)
  );
  return (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
    .additionalContext;
}

const RECENCY = "<save-eval>" + "remember the amber database fixture rule ".repeat(20) + "</save-eval>";
const HARVEST = '<session-harvest from="fixture">\n- [fact] "a different amber fixture quote"\n</session-harvest>';
const TREND = "<taxonomy-drift>" + "seven memories share the tag amber ".repeat(20) + "</taxonomy-drift>";

function assertCut(text: string, name: string) {
  assert.ok(!text.includes(`<${name}`), `precondition: ${name} was cut`);
  assert.match(text, new RegExp(`Deferred session sections: .*${name}`), `precondition: ${name} is named`);
}

async function hookRows(dir: string) {
  return (await events(dir)).filter((e) => e.kind === "session_hook_call");
}

test("#1743 recency: a cut pending suggestion is not consumed and arrives at the next start with room", () =>
  fixture(async ({ dir, url, setBig }) => {
    await writePendingSuggestion(RECENCY);
    assertCut(await start(url, "s1743-r1"), "pending-save-suggestions");
    assert.equal(pendingRows().filter((r) => r.blocks === RECENCY).length, 1, "kept once after the cut");
    const [cutRow] = await hookRows(dir);
    assert.deepEqual(cutRow.deferred_sections, ["pending-save-suggestions"], "telemetry names the cut section");
    assert.equal((cutRow.hint_tokens_by_part as Record<string, number>).pending, 0);

    setBig(false);
    const fits = await start(url, "s1743-r2");
    assert.doesNotMatch(fits, /Deferred session sections/);
    assert.ok(fits.includes(RECENCY), "delivered once there is room");
    assert.equal(pendingRows().length, 0, "consumed once delivered");
    const [, fitRow] = await hookRows(dir);
    assert.equal(fitRow.deferred_sections, undefined);
    assert.ok((fitRow.hint_tokens_by_part as Record<string, number>).pending > 0);
    assert.ok(!(await start(url, "s1743-r3")).includes(RECENCY), "not offered a third time");
  }));

test("#1743 trends: a cut trend does not spend one of its starts and arrives at the next start with room", () =>
  fixture(async ({ url, setBig }) => {
    await writePendingSuggestion(TREND, { lane: "trends", key: "drift" });
    assertCut(await start(url, "s1743-t1"), "pending-trends");
    const kept = pendingRows().find((r) => r.key === "drift");
    assert.ok(kept, "kept after the cut");
    assert.equal(kept!.sessions, 0, "the cut start is not counted");
    assert.equal(kept!.last_session, undefined, "and its last counted session restored");

    setBig(false);
    assert.ok((await start(url, "s1743-t2")).includes(TREND), "delivered once there is room");
    assert.equal(pendingRows().find((r) => r.key === "drift")!.sessions, 1, "the delivering start is counted");
  }));

test("#1743 draft review: a cut review is not marked shown, writes no draft_review_shown and comes again", () =>
  fixture(async ({ dir, url, setBig }) => {
    const draftIds = await seedDrafts();
    assertCut(await start(url, "s1743-d1"), "draft-review");
    for (const d of await listDrafts(now)) assert.equal(d.review_shown_vaults, undefined, `${d.id} not shown`);
    assert.equal((await events(dir)).filter((e) => e.kind === "draft_review_shown").length, 0);
    const [cutRow] = await hookRows(dir);
    assert.deepEqual(cutRow.deferred_sections, ["draft-review"]);

    setBig(false);
    const fits = await start(url, "s1743-d2");
    assert.match(fits, /<draft-review>/);
    for (const id of draftIds) assert.ok(fits.includes(id), `${id} delivered once there is room`);
    for (const d of await listDrafts(now)) assert.deepEqual(d.review_shown_vaults, [VAULT]);
    const shown = (await events(dir)).filter((e) => e.kind === "draft_review_shown");
    assert.equal(shown.length, 1);
    assert.deepEqual([...(shown[0].draft_ids as string[])].sort(), [...draftIds].sort());
    assert.doesNotMatch(await start(url, "s1743-d3"), /<draft-review>/, "not offered a third time");
  }));

test("#1743: a start with room delivers and books all three exactly as before", () =>
  fixture(async ({ dir, url, setBig }) => {
    setBig(false);
    await writePendingSuggestion(RECENCY);
    await writePendingSuggestion(TREND, { lane: "trends", key: "drift" });
    const draftIds = await seedDrafts();
    const text = await start(url, "s1743-room");
    assert.doesNotMatch(text, /Deferred session sections/);
    assert.ok(text.includes(RECENCY) && text.includes(TREND));
    const rows = pendingRows();
    assert.equal(rows.filter((r) => r.lane !== "trends").length, 0);
    assert.equal(rows.find((r) => r.key === "drift")!.sessions, 1);
    for (const d of await listDrafts(now)) assert.deepEqual(d.review_shown_vaults, [VAULT]);
    const log = await events(dir);
    assert.equal(log.filter((e) => e.kind === "draft_review_shown").length, 1);
    assert.equal(log.find((e) => e.kind === "draft_review_shown")!.count, draftIds.length);
    assert.equal(log.find((e) => e.kind === "session_hook_call")!.deferred_sections, undefined);
  }));

async function responseContext(response: Response): Promise<string> {
  const body = (await response.json()) as { hookSpecificOutput: { additionalContext: string } };
  return body.hookSpecificOutput.additionalContext;
}

function startHttp(url: string, sessionId: string, signal?: AbortSignal, overrides: Partial<SessionPayload> = {}) {
  return fetch(url + "/hook/session", {
    method: "POST",
    signal,
    body: JSON.stringify({
      payload: { hook_event_name: "SessionStart", source: "startup", session_id: sessionId, cwd: "/tmp", ...overrides },
    }),
  });
}

async function eventually(check: () => void | Promise<void>) {
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(10);
    }
  }
}

test("#1743 HTTP: a capped response returns all three relay sections for the next start", () =>
  fixture(async ({ dir, url, setBig }) => {
    await writePendingSuggestion(RECENCY);
    await writePendingSuggestion(TREND, { lane: "trends", key: "drift" });
    await seedDrafts();
    const cut = await responseContext(await startHttp(url, "s1743-http-cut"));
    for (const name of ["pending-save-suggestions", "pending-trends", "draft-review"]) assertCut(cut, name);
    await eventually(async () => {
      assert.equal(pendingRows().find((r) => r.blocks === RECENCY)?.blocks, RECENCY);
      assert.equal(pendingRows().find((r) => r.key === "drift")?.sessions, 0);
      for (const d of await listDrafts(now)) assert.equal(d.review_shown_vaults, undefined);
    });
    const [cutRow] = await hookRows(dir);
    assert.deepEqual(
      new Set(cutRow.deferred_sections as string[]),
      new Set(["pending-save-suggestions", "pending-trends", "draft-review"])
    );
    assert.equal(cutRow.pending_harvest, undefined);
    assert.ok(!(await events(dir)).some((e) => e.kind === "draft_review_shown"));

    setBig(false);
    const text = await responseContext(await startHttp(url, "s1743-http-fit"));
    assert.ok(text.includes(RECENCY) && text.includes(TREND));
    assert.match(text, /<draft-review>/);
    await eventually(async () => {
      assert.equal((await events(dir)).filter((e) => e.kind === "draft_review_shown").length, 1);
      assert.equal(pendingRows().find((r) => r.key === "drift")?.sessions, 1);
    });
  }));

test("#1743 HTTP: a connection closed before rendering does not count as delivery", () =>
  fixture(async ({ dir, url, setBig, closeDuringReview }) => {
    setBig(false);
    await writePendingSuggestion(RECENCY);
    await writePendingSuggestion(HARVEST);
    await writePendingSuggestion(TREND, { lane: "trends", key: "drift" });
    await seedDrafts();
    const controller = new AbortController();
    closeDuringReview(() => controller.abort());
    await assert.rejects(startHttp(url, "s1743-http-abort", controller.signal), { name: "AbortError" });
    await eventually(async () => {
      const [row] = await hookRows(dir);
      assert.ok(row, "the server completed the lane");
      assert.equal(row.pending_harvest, undefined);
      assert.equal(pendingRows().find((r) => r.blocks === RECENCY)?.blocks, RECENCY);
      assert.equal(pendingRows().find((r) => r.key === "drift")?.sessions, 0);
      for (const d of await listDrafts(now)) assert.equal(d.review_shown_vaults, undefined);
    });
    assert.ok(!(await events(dir)).some((e) => e.kind === "draft_review_shown"));
  }));

test("#1743 overlapping starts: only the start that delivers the trend advances its counter", () =>
  fixture(async ({ url, setBig }) => {
    await writePendingSuggestion(TREND, { lane: "trends", key: "drift" });
    let reportClaim!: () => void;
    let resumeFirst!: () => void;
    const claimed = new Promise<void>((resolve) => (reportClaim = resolve));
    const otherFinished = new Promise<void>((resolve) => (resumeFirst = resolve));
    const capped = runSessionLane(
      { hook_event_name: "SessionStart", source: "startup", session_id: "s1743-first", cwd: "/tmp" },
      url,
      undefined,
      async () => null,
      async () => {
        reportClaim();
        await otherFinished;
        return { block: "", fingerprints: [] };
      }
    );
    await claimed;
    try {
      setBig(false);
      assert.ok((await start(url, "s1743-second")).includes(TREND));
    } finally {
      resumeFirst();
    }
    assertCut(JSON.parse(await capped).hookSpecificOutput.additionalContext, "pending-trends");
    const trend = pendingRows().find((r) => r.key === "drift");
    assert.equal(trend?.sessions, 1);
    assert.equal(trend?.last_session, "s1743-second");
  }));

test("#1743 HTTP: brief store contention after a capped response does not drop the relay", () =>
  fixture(async ({ url, beforeAnswer }) => {
    await writePendingSuggestion(RECENCY);
    await seedDrafts();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const holders: Promise<unknown>[] = [];
    beforeAnswer(() =>
      Promise.all([
        new Promise<void>((ready) => {
          holders.push(
            withPathLock(process.env.BASTRA_PENDING_SUGGESTIONS_PATH!, async () => {
              ready();
              await held;
            })
          );
        }),
        new Promise<void>((ready) => {
          holders.push(
            transactDrafts(async () => {
              ready();
              await held;
            }, now)
          );
        }),
      ]).then(() => {})
    );
    try {
      const cut = await responseContext(await startHttp(url, "s1743-http-busy", AbortSignal.timeout(2000)));
      assertCut(cut, "pending-save-suggestions");
      assertCut(cut, "draft-review");
      // The HTTP response has arrived while both stores are still busy.
      await delay(50);
    } finally {
      release();
      await Promise.all(holders);
    }
    await eventually(async () => {
      assert.equal(pendingRows().find((r) => r.blocks === RECENCY)?.blocks, RECENCY);
      for (const d of await listDrafts(now)) assert.equal(d.review_shown_vaults, undefined);
    });
  }));

test("#1743 HTTP: a subagent leaves the relay alone and Codex compaction does not advance a trend", () =>
  fixture(async ({ url, setBig }) => {
    setBig(false);
    await writePendingSuggestion(RECENCY);
    await writePendingSuggestion(TREND, { lane: "trends", key: "drift" });
    await seedDrafts();
    const subagent = await startHttp(url, "s1743-subagent", undefined, { hook_event_name: "SubagentStart" });
    assert.doesNotMatch(await subagent.text(), /pending-save-suggestions|pending-trends|draft-review/);
    assert.equal(pendingRows().find((r) => r.blocks === RECENCY)?.blocks, RECENCY);
    for (const d of await listDrafts(now)) assert.equal(d.review_shown_vaults, undefined);

    const compact = await responseContext(
      await startHttp(url, "s1743-compact", undefined, {
        source: "compact",
        bastra_client: "codex",
      })
    );
    assert.ok(compact.includes(RECENCY) && compact.includes(TREND));
    assert.match(compact, /<draft-review>/);
    assert.equal(pendingRows().find((r) => r.key === "drift")?.sessions, 0);

    const startup = await responseContext(await startHttp(url, "s1743-codex", undefined, { bastra_client: "codex" }));
    assert.ok(startup.includes(TREND));
    assert.doesNotMatch(startup, /pending-save-suggestions|draft-review/);
    await eventually(() => assert.equal(pendingRows().find((r) => r.key === "drift")?.sessions, 1));
  }));
