/**
 * #1592: a full draft store (500 rows) must still take in a new first capture.
 * Owner decision: fixed places for new captures (B) and, in addition, the
 * oldest confirmed draft leaves when the store is full (C). Rejections and
 * promotions (tombstones) outlive every open draft.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/draft-store-full.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureDrafts,
  draftFingerprint,
  draftId,
  listDrafts,
  DRAFT_FIRST_CAPTURE_SLOTS,
  DRAFT_MAX_ROWS,
  type Draft,
} from "../src/draft-store.js";

const now = 1_800_000_000_000;
type Kind = "first" | "confirmed" | "rejected";
function row(i: number, kind: Kind, touched = now - 1_000_000 + i): Draft {
  const quote = `Keep the staging database ${kind} number ${i} separate from production`;
  const fp = draftFingerprint(quote);
  return {
    id: draftId(`s-${kind}-${i}`, 1, fp),
    fp,
    kind: "typed",
    quote,
    situation: { before: [], after: [], reads: [], lits: [] },
    evidence: Array.from({ length: kind === "confirmed" ? 2 : 1 }, (_, k) => ({
      session_id: `s-${kind}-${i}-${k}`,
      turn: 1,
      ts: touched,
    })),
    created: touched,
    last_touched: touched,
    surfaced: [],
    state: kind === "rejected" ? "rejected" : "open",
  };
}

async function seeded(rows: Draft[], fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-1592-"));
  const previous = process.env.BASTRA_DRAFTS_PATH;
  process.env.BASTRA_DRAFTS_PATH = join(dir, "drafts.json");
  try {
    await writeFile(process.env.BASTRA_DRAFTS_PATH, JSON.stringify({ version: 1, rows }));
    await fn();
  } finally {
    if (previous === undefined) delete process.env.BASTRA_DRAFTS_PATH;
    else process.env.BASTRA_DRAFTS_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const fresh = () => ({ ...row(9001, "first", now), quote: "A completely new instruction about tabs in yaml" });

test("#1592: 500 confirmed drafts — a new capture stays and the oldest confirmed one leaves", () =>
  seeded(
    Array.from({ length: DRAFT_MAX_ROWS }, (_, i) => row(i, "confirmed")),
    async () => {
      const result = await captureDrafts([fresh()], now);
      // Before: { count: 0, evicted: 1 } — the capture was dropped in its own write.
      assert.equal(result.count, 1);
      assert.equal(result.evicted, 0);
      assert.equal(result.evictedExisting, 1);
      const kept = await listDrafts(now);
      assert.equal(kept.length, DRAFT_MAX_ROWS);
      assert.ok(kept.some((d) => d.quote === fresh().quote));
      assert.ok(!kept.some((d) => d.id === row(0, "confirmed").id), "the oldest confirmed draft leaves");
      assert.ok(kept.some((d) => d.id === row(1, "confirmed").id));
    }
  ));

test("#1592: first captures beyond the fixed places leave before any confirmed draft", () =>
  seeded(
    [
      ...Array.from({ length: 300 }, (_, i) => row(i, "confirmed")),
      ...Array.from({ length: 200 }, (_, i) => row(i, "first")),
    ],
    async () => {
      const result = await captureDrafts([fresh()], now);
      assert.equal(result.count, 1);
      const kept = await listDrafts(now);
      assert.equal(kept.length, DRAFT_MAX_ROWS);
      assert.equal(kept.filter((d) => d.evidence.length === 2).length, 300);
      assert.ok(!kept.some((d) => d.id === row(0, "first").id), "the oldest first capture leaves");
      assert.ok(kept.some((d) => d.quote === fresh().quote));
    }
  ));

test("#1592: first captures inside the fixed places stay even when older than every confirmed draft", () =>
  seeded(
    [
      ...Array.from({ length: 450 }, (_, i) => row(i, "confirmed", now - 10_000 + i)),
      ...Array.from({ length: 50 }, (_, i) => row(i, "first", now - 2_000_000 + i)),
    ],
    async () => {
      assert.ok(50 < DRAFT_FIRST_CAPTURE_SLOTS);
      await captureDrafts([fresh()], now);
      const kept = await listDrafts(now);
      // Before: the oldest first capture left, whatever its class's share.
      assert.equal(kept.filter((d) => d.evidence.length === 1).length, 51);
      assert.equal(kept.filter((d) => d.evidence.length === 2).length, 449);
      assert.ok(!kept.some((d) => d.id === row(0, "confirmed").id));
    }
  ));

test("#1592: rejections outlive confirmed drafts when the store is full", () =>
  seeded(
    [
      ...Array.from({ length: 250 }, (_, i) => row(i, "rejected", now - 2_000_000 + i)),
      ...Array.from({ length: 250 }, (_, i) => row(i, "confirmed")),
    ],
    async () => {
      await captureDrafts([fresh()], now);
      const kept = await listDrafts(now);
      assert.equal(kept.filter((d) => d.state === "rejected").length, 250);
      assert.ok(!kept.some((d) => d.id === row(0, "confirmed").id));
      assert.ok(kept.some((d) => d.quote === fresh().quote));
    }
  ));

test("#1693: a confirmation written at the same time as new rows keeps its new evidence", () =>
  seeded(
    [row(0, "first", now - 1), ...Array.from({ length: DRAFT_MAX_ROWS - 1 }, (_, i) => row(i + 1, "confirmed", now))],
    async () => {
      const first = row(0, "first", now);
      const result = await captureDrafts(
        [{ ...first, evidence: [{ session_id: "confirming", turn: 0, ts: now }] }, fresh()],
        now
      );
      const kept = await listDrafts(now);
      assert.equal(result.appended, 1);
      assert.equal(result.evictedExisting, 1);
      assert.equal(kept.find((d) => d.id === first.id)?.evidence.length, 2);
      assert.ok(!kept.some((d) => d.id === row(1, "confirmed").id));
    }
  ));
