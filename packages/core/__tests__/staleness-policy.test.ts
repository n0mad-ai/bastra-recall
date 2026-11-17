/**
 * #1567 (owner decision 16.11.2026): age alone demotes only mildly, rules never
 * age in search, strong demotion stays for an explicit deadline.
 * #1568: a measurement pins the clock the staleness step reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "../src/index.js";
import { applyStalenessMultiplier, computeStaleness } from "../src/search.js";
import type { RecallHit } from "../src/search-types.js";

const NOW = new Date("2026-11-16T00:00:00Z");
const daysAgo = (d: number): string => new Date(NOW.getTime() - d * 86_400_000).toISOString().slice(0, 10);

/** Score a single 100-point hit for `fm` at `NOW`. */
function scoreOf(fm: Record<string, unknown>): number {
  const hits = [{ id: "m", score: 100 } as RecallHit];
  return applyStalenessMultiplier(hits, () => fm, NOW)[0].score;
}

test("type-default ageing demotes mildly: stale and expired keep 70 %", () => {
  // project-fact: 90 days. 100 days = stale, 140 days = expired (ratio ≥ 1.5).
  const stale = { type: "project-fact", updated: daysAgo(100) };
  const expired = { type: "project-fact", updated: daysAgo(140) };
  assert.equal(computeStaleness(stale, NOW), "stale");
  assert.equal(computeStaleness(expired, NOW), "expired");
  assert.equal(scoreOf(stale), 70);
  assert.equal(scoreOf(expired), 70);
  assert.equal(scoreOf({ type: "project-fact", updated: daysAgo(70) }), 85, "aging is unchanged");
  assert.equal(scoreOf({ type: "project-fact", updated: daysAgo(10) }), 100, "fresh is unchanged");
});

test("an explicit deadline keeps the strong demotion", () => {
  assert.equal(scoreOf({ type: "lesson", updated: daysAgo(30), valid_until: daysAgo(1) }), 20);
  // expires_after_days: 10 → 30 days is ratio 3 → expired, 12 days → stale.
  assert.equal(scoreOf({ type: "lesson", updated: daysAgo(30), expires_after_days: 10 }), 20);
  assert.equal(scoreOf({ type: "lesson", updated: daysAgo(12), expires_after_days: 10 }), 50);
});

test("a rule never ages in search, but its explicit deadline still counts", () => {
  for (const rulebook of ["always", "on-demand"]) {
    assert.equal(scoreOf({ type: "lesson", updated: daysAgo(400), rulebook }), 100, rulebook);
    assert.equal(scoreOf({ type: "workflow", updated: daysAgo(200), rulebook }), 100, rulebook);
  }
  assert.equal(scoreOf({ type: "lesson", updated: daysAgo(30), rulebook: "always", valid_until: daysAgo(1) }), 20);
  // An unknown rulebook value is not a declaration.
  assert.equal(scoreOf({ type: "lesson", updated: daysAgo(400), rulebook: "maybe" }), 70);
});

test("the staleness status itself is unchanged: rules still report their age", () => {
  assert.equal(computeStaleness({ type: "lesson", updated: daysAgo(400), rulebook: "always" }, NOW), "expired");
});

function memoryMarkdown(id: string, title: string, type: string, updated: string): string {
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    `type: ${type}`,
    `summary: ${title}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: test-scope",
    "recall_when:",
    `  - ${title}`,
    `created: ${updated}`,
    `updated: ${updated}`,
    "---",
    "",
    `Body for ${title}.`,
    "",
  ].join("\n");
}

test("reference_time pins the staleness clock and bypasses the cache (#1568)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-staleness-policy-"));
  const updated = "2026-01-01";
  await writeFile(join(dir, "pf.md"), memoryMarkdown("pf", "kalender notiz", "project-fact", updated), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const idx = new SearchIndex(vault);
  idx.start();
  try {
    const at = (iso: string): number => idx.recall("kalender", { k: 5, reference_time: new Date(iso) })[0].score;
    const fresh = at("2026-01-10T00:00:00Z");
    const aging = at("2026-03-20T00:00:00Z"); // 78 days of 90 → aging
    const stale = at("2026-04-15T00:00:00Z"); // 104 days → stale
    assert.ok(fresh > 0);
    assert.equal(aging, Math.round(fresh * 0.85 * 1000) / 1000);
    assert.equal(stale, Math.round(fresh * 0.7 * 1000) / 1000);
    // Earlier again after a later time: no status leaks through the cache.
    assert.equal(at("2026-01-10T00:00:00Z"), fresh);
    const cache = (idx as unknown as { stalenessCache: Map<string, unknown> }).stalenessCache;
    assert.equal(cache.size, 0, "a pinned call neither reads nor fills the wall-clock cache");
  } finally {
    await idx.stop();
    await vault.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
