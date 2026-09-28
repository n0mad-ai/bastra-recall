/**
 * Tests for src/learned-recall/demotion.ts (#129) — a bridge whose fires never
 * lead to a load or an acted-on episode is demoted, then archived; an outcome
 * restores it. All events are synthetic.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/bridge-demotion.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgePool, type Bridge } from "../src/learned-recall/bridges.js";
import { writeBridges, type TelemetryEvent } from "../src/learned-recall/harvest.js";
import { bridgeFireStats, demoteIdleBridges, DEMOTION_MIN_FIRES, DEMOTION_WINDOW_DAYS } from "../src/learned-recall/demotion.js";

const DAY = 86_400_000;
const NOW = new Date("2026-09-28T12:00:00.000Z");
const at = (daysAgo: number): string => new Date(NOW.getTime() - daysAgo * DAY).toISOString();

const BRIDGE: Bridge = {
  id: "b-panel",
  lang: "en",
  trigger_terms: ["panel", "dismiss", "window"],
  expansion_terms: ["nspanel", "resignkey", "observer", "attachedsheet", "sheet"],
  evidence: 3,
};
const QUERY = "why does the panel dismiss when the window closes";

/** `n` recalls on which BRIDGE fired, `daysAgo` old. */
function fires(n: number, daysAgo: number, prefix = "f"): TelemetryEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: "hook_recall",
    ts: at(daysAgo),
    recall_id: `${prefix}${i}`,
    query: QUERY,
    bridge_expansion: { lang: "en", added: ["nspanel", "resignkey"] },
  }));
}

async function withRoot(fn: (root: string, dir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "bastra-demotion-"));
  const dir = join(root, "bridges", "en");
  await mkdir(dir, { recursive: true });
  try {
    await fn(root, dir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function put(dir: string, b: Bridge): Promise<void> {
  await writeFile(join(dir, `${b.id}.json`), JSON.stringify(b), "utf8");
}

async function get(dir: string, id: string): Promise<Bridge> {
  return JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")) as Bridge;
}

test("#129 defaults: 30-day window, 20 fires", () => {
  assert.equal(DEMOTION_WINDOW_DAYS, 30);
  assert.equal(DEMOTION_MIN_FIRES, 20);
});

test("#129 bridgeFireStats: attributes fires by trigger + added terms, counts loads and acted-on episodes as outcomes", () => {
  const other: Bridge = { ...BRIDGE, id: "b-other", trigger_terms: ["invoice", "amount"], expansion_terms: ["billing"] };
  const events: TelemetryEvent[] = [
    ...fires(3, 1),
    { kind: "load_memory", ts: at(1), id: "m", found: true, follows_recall: "f0", from_hook_recall: null },
    { kind: "recall_episode", ts: at(1), recall_id: "f1", memory_id: "m", acted_on: true },
    { kind: "load_memory", ts: at(1), id: "gone", found: false, follows_recall: "f2", from_hook_recall: null }, // a failed load is no outcome
    // expanded, but by other terms: not a fire of BRIDGE
    { kind: "hook_recall", ts: at(1), recall_id: "x", query: QUERY, bridge_expansion: { lang: "en", added: ["billing"] } },
  ];
  const stats = bridgeFireStats([BRIDGE, other], events, new Date(NOW.getTime() - 30 * DAY), NOW);
  assert.deepEqual(stats.get("b-panel"), { fires: 3, outcomes: 2 });
  assert.deepEqual(stats.get("b-other"), { fires: 0, outcomes: 0 });
});

test("#129: a confirmed bridge with ≥20 fires and no outcome is demoted and then widens at unconfirmed weight", async () => {
  await withRoot(async (root, dir) => {
    await put(dir, BRIDGE);
    const before = BridgePool.load(root, NOW).expansionsFor(QUERY, "en");
    assert.equal(before.length, 5, "confirmed: full weight");

    const r = await demoteIdleBridges(root, fires(25, 3), NOW);
    assert.deepEqual(r, { demoted: 1, restored: 0, archived: 0 });
    const b = await get(dir, BRIDGE.id);
    assert.equal(b.demoted_at, NOW.toISOString());
    assert.equal(b.evidence, 3, "evidence untouched — demotion is its own field");

    const after = BridgePool.load(root, NOW).expansionsFor(QUERY, "en");
    assert.equal(after.length, 3, "demoted: at most 3 expansion terms");
    const log = (await readFile(join(root, "bridges", "archive", "log.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(log[0].action, "demote");
  });
});

test("#129: a bridge with an outcome, or too few fires, or fires outside the window, is untouched", async () => {
  await withRoot(async (root, dir) => {
    await put(dir, BRIDGE);
    const withLoad: TelemetryEvent[] = [
      ...fires(25, 3),
      { kind: "load_memory", ts: at(3), id: "m", found: true, follows_recall: null, from_hook_recall: "f7" },
    ];
    assert.equal((await demoteIdleBridges(root, withLoad, NOW)).demoted, 0);
    assert.equal((await demoteIdleBridges(root, fires(DEMOTION_MIN_FIRES - 1, 3), NOW)).demoted, 0);
    assert.equal((await demoteIdleBridges(root, fires(25, 31), NOW)).demoted, 0);
    assert.equal((await get(dir, BRIDGE.id)).demoted_at, undefined);
  });
});

test("#129: demoted for a full window, fired again without outcome → archived; a replay no longer expands", async () => {
  await withRoot(async (root, dir) => {
    await put(dir, { ...BRIDGE, demoted_at: at(31) });
    const r = await demoteIdleBridges(root, fires(4, 10), NOW);
    assert.deepEqual(r, { demoted: 0, restored: 0, archived: 1 });
    assert.ok(!existsSync(join(dir, `${BRIDGE.id}.json`)));
    assert.ok(existsSync(join(root, "bridges", "archive", "en", `${BRIDGE.id}.json`)), "moved, not deleted");
    assert.deepEqual(BridgePool.load(root, NOW).expansionsFor(QUERY, "en"), [], "the archived bridge no longer expands");

    // the reach that minted it may still be in the log: a rewrite must not resurrect it
    assert.equal(await writeBridges(root, [BRIDGE], NOW), 0);
    assert.ok(!existsSync(join(dir, `${BRIDGE.id}.json`)));
  });
});

test("#129: a demoted bridge that stopped firing stays demoted; inside the window nothing happens", async () => {
  await withRoot(async (root, dir) => {
    await put(dir, { ...BRIDGE, demoted_at: at(31) });
    assert.deepEqual(await demoteIdleBridges(root, [], NOW), { demoted: 0, restored: 0, archived: 0 });
    await put(dir, { ...BRIDGE, demoted_at: at(10) });
    assert.deepEqual(await demoteIdleBridges(root, fires(30, 5), NOW), { demoted: 0, restored: 0, archived: 0 });
    assert.equal((await get(dir, BRIDGE.id)).demoted_at, at(10));
  });
});

test("#129: an outcome after demotion restores full weight", async () => {
  await withRoot(async (root, dir) => {
    await put(dir, { ...BRIDGE, demoted_at: at(20) });
    const events: TelemetryEvent[] = [
      ...fires(2, 5),
      { kind: "recall_episode", ts: at(5), recall_id: "f1", memory_id: "m", acted_on: true },
    ];
    assert.deepEqual(await demoteIdleBridges(root, events, NOW), { demoted: 0, restored: 1, archived: 0 });
    assert.equal((await get(dir, BRIDGE.id)).demoted_at, undefined);
    assert.equal(BridgePool.load(root, NOW).expansionsFor(QUERY, "en").length, 5);
  });
});

test("#129: contributed bridges are never demoted; a mint rewrite keeps demoted_at", async () => {
  await withRoot(async (root, dir) => {
    await put(dir, { ...BRIDGE, id: "contrib", verifier: "v" });
    assert.equal((await demoteIdleBridges(root, fires(25, 3), NOW)).demoted, 0);

    await put(dir, { ...BRIDGE, demoted_at: at(5) });
    await writeBridges(root, [{ ...BRIDGE, evidence: 4 }], NOW);
    const b = await get(dir, BRIDGE.id);
    assert.equal(b.evidence, 4);
    assert.equal(b.demoted_at, at(5), "a recount is not an outcome");
  });
});
