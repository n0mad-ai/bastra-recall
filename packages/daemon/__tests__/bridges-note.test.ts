/**
 * Tests for src/cli/bridges-note.ts (#672) — the doctor note that reports when
 * learned bridges stop learning.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/bridges-note.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_STALL_WINDOW_DAYS, bridgeLearningLines, readMintRuns, type MintRun } from "../src/cli/bridges-note.js";

const NOW = new Date("2026-09-26T12:00:00.000Z");
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const run = (ts: string, minted: number, written: number, reaches = minted): MintRun => ({ ts, minted, written, reaches });

test("bridge note: silent when shared recall is off", () => {
  assert.deepEqual(bridgeLearningLines({ enabled: false, runs: [], now: NOW }), []);
});

test("bridge note: warns when no mint ran inside the window", () => {
  const lines = bridgeLearningLines({ enabled: true, runs: [run(daysAgo(BRIDGE_STALL_WINDOW_DAYS + 1), 5, 5)], now: NOW });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^⚠ no bridge mint ran in the last 30 days/);
  assert.match(lines[0], /bastra bridges mint/);
});

test("bridge note: minted but never written is reported as stalled (the zzallirog month)", () => {
  const lines = bridgeLearningLines({ enabled: true, runs: [run(daysAgo(10), 20, 0), run(daysAgo(1), 23, 0)], now: NOW });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^⚠ bridge learning stalled: 2 mint run\(s\)/);
  assert.match(lines[0], /last: 23 minted, 0 written/);
});

test("bridge note: runs without any acted-on reach point at telemetry", () => {
  const lines = bridgeLearningLines({ enabled: true, runs: [run(daysAgo(2), 0, 0, 0)], now: NOW });
  assert.match(lines[0], /^⚠ no bridge learned in 30 days/);
  assert.match(lines[0], /BASTRA_TELEMETRY/);
});

test("bridge note: any written bridge in the window is ok", () => {
  const lines = bridgeLearningLines({ enabled: true, runs: [run(daysAgo(20), 3, 3), run(daysAgo(1), 4, 0)], now: NOW });
  assert.match(lines[0], /^✓ ok: bridges learned/);
});

test("bridge note: reaches that needed no bridge are not a fault", () => {
  const lines = bridgeLearningLines({ enabled: true, runs: [run(daysAgo(1), 0, 0, 7)], now: NOW });
  assert.match(lines[0], /^✓ ok: 1 mint run\(s\)/);
});

test("readMintRuns: reads bridges_mint events inside the window and falls back to last-mint.json", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-bridges-note-"));
  try {
    const inWindow = daysAgo(3);
    const outside = daysAgo(40);
    await writeFile(
      join(logDir, `events-${inWindow.slice(0, 10)}.jsonl`),
      [
        JSON.stringify({ kind: "hook_recall", ts: inWindow, query: "bridges_mint in a query is not a run" }),
        JSON.stringify({ kind: "bridges_mint", ts: inWindow, minted: 9, reaches: 9, written: 0 }),
        "{ malformed bridges_mint",
      ].join("\n") + "\n",
      "utf8",
    );
    await writeFile(
      join(logDir, `events-${outside.slice(0, 10)}.jsonl`),
      JSON.stringify({ kind: "bridges_mint", ts: outside, minted: 1, reaches: 1, written: 1 }) + "\n",
      "utf8",
    );
    const lastMint = { ts: daysAgo(1), host: "h", trigger: "cli" as const, minted: 2, reaches: 2, written: 2, pruned: 0 };
    const runs = await readMintRuns(logDir, lastMint, NOW);
    assert.deepEqual(runs, [
      { ts: inWindow, minted: 9, reaches: 9, written: 0 },
      { ts: lastMint.ts, minted: 2, reaches: 2, written: 2 },
    ]);
    // the fallback is not double-counted when the log already has that run
    const again = await readMintRuns(logDir, { ...lastMint, ts: inWindow }, NOW);
    assert.equal(again.length, 1);
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});

test("readMintRuns: a missing log dir leaves only last-mint.json", async () => {
  const runs = await readMintRuns(join(tmpdir(), "bastra-no-such-dir-672"), null, NOW);
  assert.deepEqual(runs, []);
});
