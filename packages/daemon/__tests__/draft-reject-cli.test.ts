/**
 * #1222: `bastra drafts reject <id>...` closes named open drafts — also ones
 * never shown in <draft-review> — the same way a review rejection does, and
 * reports every id on its own.
 *
 * Run: npx tsx --test packages/daemon/__tests__/draft-reject-cli.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdDrafts } from "../src/cli/drafts-cmd.js";
import { parseArgs } from "../src/cli/commands.js";
import { captureDraft, draftFingerprint, draftId, listDrafts, upsertDraft, type Draft } from "../src/draft-store.js";

const now = Date.now();
function row(i: number, state: Draft["state"] = "open"): Draft {
  const quote = `Fixture rule ${i}: the amber staging database is reset before every release.`;
  const fp = draftFingerprint(quote);
  return { id: draftId("reject-" + i, 1, fp), fp, quote, kind: "typed", state, vault_id: "fixture-vault",
    situation: { project: "fixture", before: [], after: [], reads: [], lits: [] },
    evidence: [{ session_id: "reject-" + i, turn: 1, ts: now }], surfaced: [], created: now, last_touched: now };
}

async function fixture(t: test.TestContext, work: (dir: string, out: { stdout: string; stderr: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "draft-reject-"));
  const env = { BASTRA_DRAFTS_PATH: join(dir, "drafts.json"), BASTRA_LOG_PATH: join(dir, "logs"), BASTRA_TELEMETRY: "on" };
  const prev = new Map(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  const out = { stdout: "", stderr: "" };
  t.mock.method(process.stdout, "write", (chunk: unknown) => { out.stdout += String(chunk); return true; });
  t.mock.method(process.stderr, "write", (chunk: unknown) => { out.stderr += String(chunk); return true; });
  try { await work(dir, out); }
  finally {
    t.mock.restoreAll();
    for (const [k, v] of prev) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

test("reject closes an unshown open draft with tombstone, owner_review and a text-free event", t => fixture(t, async (dir, out) => {
  const open = row(1);
  await upsertDraft(open, now);
  assert.equal(await cmdDrafts(parseArgs(["drafts", "reject", open.id])), 0);
  assert.match(out.stdout, new RegExp(`Draft rejected: ${open.id}`));
  const [closed] = await listDrafts();
  assert.equal(closed.state, "rejected");
  assert.equal(closed.announce, false);
  assert.equal((closed.owner_review as { decision?: string }).decision, "reject");
  // The retained fingerprint blocks an identical recapture.
  await captureDraft({ ...row(1), id: draftId("reject-again", 1, open.fp), evidence: [{ session_id: "reject-again", turn: 1, ts: now }] }, now);
  const after = await listDrafts();
  assert.equal(after.length, 1);
  assert.equal(after[0].state, "rejected");
  const logs = join(dir, "logs");
  const events = (await Promise.all((await readdir(logs)).map(f => readFile(join(logs, f), "utf8")))).join("");
  const rejected = events.split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(e => e.kind === "draft_review_rejected");
  assert.equal(rejected.length, 1);
  assert.deepEqual(rejected[0].draft_ids, [open.id]);
  assert.ok(!events.includes(open.quote), "telemetry must not carry the quote");
  // Repeating the command is idempotent and still succeeds.
  assert.equal(await cmdDrafts(parseArgs(["drafts", "reject", open.id])), 0);
  assert.match(out.stdout, /Draft already rejected/);
}));

test("reject reports every id and fails when one is promoted or unknown", t => fixture(t, async (_dir, out) => {
  const open = row(2), promoted = row(3, "promoted"), rejected = row(4, "rejected");
  for (const d of [open, promoted, rejected]) await upsertDraft(d, now);
  const unknown = "d-000000000000";
  assert.equal(await cmdDrafts(parseArgs(["drafts", "reject", open.id, promoted.id, rejected.id, unknown, "--json"])), 1);
  assert.deepEqual(JSON.parse(out.stdout).results, [
    { id: open.id, outcome: "rejected" },
    { id: promoted.id, outcome: "promoted" },
    { id: rejected.id, outcome: "already_rejected" },
    { id: unknown, outcome: "unknown" },
  ]);
  const byId = new Map((await listDrafts()).map(d => [d.id, d.state]));
  assert.equal(byId.get(open.id), "rejected");
  assert.equal(byId.get(promoted.id), "promoted");
}));

test("reject without an id prints usage", t => fixture(t, async (_dir, out) => {
  assert.equal(await cmdDrafts(parseArgs(["drafts", "reject"])), 2);
  assert.match(out.stderr, /reject <id>\.\.\./);
}));
