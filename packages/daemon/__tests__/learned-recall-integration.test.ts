/**
 * End-to-end: the shared learned-recall bridge layer (#120) wired through the real
 * recallHandler. Proves the product-visible behavior:
 *   1. a far-worded (different vocabulary) query that finds nothing on its own
 *      DOES find the memory once a language-matched bridge widens it;
 *   2. with the layer off (no pool), the same query finds nothing — so the lift
 *      is attributable to the bridge, not the index;
 *   3. #707: the language folder is not a gate — a bridge filed under another
 *      folder ("und") lifts the query too; only a configured language override
 *      restricts the pool, and that restriction holds through the handler;
 *   4. owner decision 2026-09-29: a pool that is not live (the default) leaves
 *      the ranking untouched and still writes the `bridge_expansion` row.
 *      The lift tests above load their pool live.
 *
 * Run: npx tsx --test packages/daemon/__tests__/learned-recall-integration.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { recallHandler, type ToolDeps } from "../src/tool-handlers.js";
import { BridgePool, bridgeId, type Bridge } from "../src/learned-recall/bridges.js";

// A memory whose recall trigger uses ONLY near, technical/English vocabulary —
// deliberately sharing no terms with the German far query below.
function nearMemory(): string {
  const ts = new Date().toISOString();
  return [
    "---",
    "id: panel-dismiss",
    "title: NSPanel resignKey dismissal",
    "type: lesson",
    "summary: panel dismissal on resignKey",
    "topic_path:",
    "  - swift",
    "tags:",
    "  - swift",
    "scope: personal",
    "recall_when:",
    "  - macOS window dismiss observer resignKey attachedSheet",
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    "Hold the panel; respect attachedSheet on resignKey.",
    "",
  ].join("\n");
}

function bridge(lang: string, trigger: string[], expansion: string[]): Bridge {
  return { id: bridgeId(lang, trigger, expansion), lang, trigger_terms: trigger, expansion_terms: expansion, evidence: 3 };
}

async function poolWith(bridges: Bridge[], live = true): Promise<BridgePool> {
  const root = await mkdtemp(join(tmpdir(), "bastra-bridge-pool-"));
  for (const b of bridges) {
    const dir = join(root, "bridges", b.lang);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${b.id}.json`), JSON.stringify(b), "utf8");
  }
  return BridgePool.load(root, undefined, { live });
}

// A German query that shares no vocabulary with the memory's English trigger.
const FAR_DE_QUERY = "warum schließt sich mein Fenster wieder von allein";

/** Score of a given memory in a recall result, or 0 if it did not surface.
 *  #542: RecallResult.hits is `unknown[]` (the shape varies by recall mode) —
 *  cast once here rather than at every call site. */
function scoreFor(res: { hits: unknown[] }, id: string): number {
  const hits = res.hits as Array<{ id: string; score: number }>;
  return hits.find((h) => h.id === id)?.score ?? 0;
}

async function withVault(fn: (mkDeps: (extra?: Partial<ToolDeps>) => ToolDeps) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-lr-vault-"));
  try {
    await writeFile(join(dir, "panel.md"), nearMemory(), "utf8");
    const vault = new Vault(dir);
    await vault.init();
    const search = new SearchIndex(vault);
    search.start();
    await fn((extra = {}) => ({ vault, search, telemetry: new Telemetry(), vaultPath: dir, ...extra }));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("a German bridge lifts the far query's score for the near-worded memory", async () => {
  await withVault(async (mkDeps) => {
    const off = scoreFor(await recallHandler(mkDeps(), { query: FAR_DE_QUERY, k: 5, min_score: 0 }), "panel-dismiss");
    const pool = await poolWith([
      bridge("de", ["fenster", "schließt"], ["resignkey", "observer", "attachedsheet", "dismiss"]),
    ]);
    const on = scoreFor(
      await recallHandler(mkDeps({ learnedBridges: pool }), { query: FAR_DE_QUERY, k: 5, min_score: 0 }),
      "panel-dismiss",
    );
    assert.ok(on > off, `German bridge must raise recall score (off=${off}, on=${on})`);
  });
});

test("#707: a bridge in another language folder lifts the query; a configured override still isolates", async () => {
  await withVault(async (mkDeps) => {
    const off = scoreFor(await recallHandler(mkDeps(), { query: FAR_DE_QUERY, k: 5, min_score: 0 }), "panel-dismiss");
    // Same trigger/expansion terms, filed under "und". The query detects as
    // German; without an override every folder is consulted.
    const pool = await poolWith([
      bridge("und", ["fenster", "schließt"], ["resignkey", "observer", "attachedsheet", "dismiss"]),
    ]);
    const auto = scoreFor(
      await recallHandler(mkDeps({ learnedBridges: pool }), { query: FAR_DE_QUERY, k: 5, min_score: 0 }),
      "panel-dismiss",
    );
    assert.ok(auto > off, `the filing folder must not block the bridge (off=${off}, auto=${auto})`);
    const pinned = scoreFor(
      await recallHandler(mkDeps({ learnedBridges: pool, sharedRecallLang: "de" }), { query: FAR_DE_QUERY, k: 5, min_score: 0 }),
      "panel-dismiss",
    );
    assert.equal(pinned, off, "with the override pinned to de, a bridge outside bridges/de/ does not change recall");
  });
});

test("OFF contract: with no bridge pool wired into the handler, recall applies zero expansion", async () => {
  await withVault(async (mkDeps) => {
    // A German bridge that WOULD lift this query if the layer were on.
    const matching = await poolWith([
      bridge("de", ["fenster", "schließt"], ["resignkey", "observer", "attachedsheet"]),
    ]);
    const offNull = scoreFor(
      await recallHandler(mkDeps({ learnedBridges: null }), { query: FAR_DE_QUERY, k: 5, min_score: 0 }),
      "panel-dismiss",
    );
    const offAbsent = scoreFor(
      await recallHandler(mkDeps(), { query: FAR_DE_QUERY, k: 5, min_score: 0 }),
      "panel-dismiss",
    );
    const on = scoreFor(
      await recallHandler(mkDeps({ learnedBridges: matching }), { query: FAR_DE_QUERY, k: 5, min_score: 0 }),
      "panel-dismiss",
    );
    assert.equal(offNull, offAbsent, "learnedBridges null and absent must behave identically (off)");
    assert.ok(on > offNull, "and a matching pool WOULD lift — so off is provably inert, not merely empty");
  });
});

test("configured language override routes a code-shaped (abstaining) query into a pool", async () => {
  await withVault(async (mkDeps) => {
    const pool = await poolWith([
      bridge("de", ["panel", "fenster"], ["resignkey", "observer", "attachedsheet"]),
    ]);
    // A code-shaped query the detector would abstain on; the override forces 'de'.
    const res = await recallHandler(
      mkDeps({ learnedBridges: pool, sharedRecallLang: "de" }),
      { query: "Panel Fenster", k: 5, min_score: 0 },
    );
    assert.ok(
      (res.hits as Array<{ id: string }>).some((h) => h.id === "panel-dismiss"),
      "override pool must widen the query",
    );
  });
});

test("default shadow: a firing bridge does not change the ranking, the bridge_expansion row is still written", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-lr-logs-"));
  const prev = process.env.BASTRA_LOG_PATH;
  process.env.BASTRA_LOG_PATH = logDir;
  const telemetry = new Telemetry();
  if (prev === undefined) delete process.env.BASTRA_LOG_PATH;
  else process.env.BASTRA_LOG_PATH = prev;
  try {
    await withVault(async (mkDeps) => {
      const b = bridge("de", ["fenster", "schließt"], ["resignkey", "observer", "attachedsheet", "dismiss"]);
      const off = await recallHandler(mkDeps(), { query: FAR_DE_QUERY, k: 5, min_score: 0 });
      const shadowPool = BridgePool.load(join(logDir, "missing"));
      assert.equal(shadowPool.live, false, "a pool is shadow unless loaded live");
      const shadow = await recallHandler(
        mkDeps({ learnedBridges: await poolWith([b], false), telemetry }),
        { query: FAR_DE_QUERY, k: 5, min_score: 0 },
      );
      const ids = (r: { hits: unknown[] }) => (r.hits as Array<{ id: string; score: number }>).map((h) => `${h.id}:${h.score}`);
      assert.deepEqual(ids(shadow), ids(off), "shadow must leave the ranking exactly as without bridges");

      let row: Record<string, unknown> | undefined;
      for (let i = 0; i < 40 && !row; i++) {
        await new Promise((r) => setTimeout(r, 40));
        for (const f of (await readdir(logDir)).filter((n) => n.startsWith("events-"))) {
          for (const line of (await readFile(join(logDir, f), "utf8")).split("\n")) {
            if (!line.trim()) continue;
            const ev = JSON.parse(line) as Record<string, unknown>;
            if (ev.kind === "recall" && ev.bridge_expansion) row = ev;
          }
        }
      }
      assert.ok(row, "the fire is logged");
      assert.deepEqual(row!.bridge_expansion, {
        lang: "de",
        added: ["resignkey", "observer", "attachedsheet", "dismiss"],
        applied: false,
      });
    });
  } finally {
    await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
