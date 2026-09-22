/**
 * End-to-end: the shared learned-recall bridge layer (#120) wired through the real
 * recallHandler. Proves the product-visible behavior:
 *   1. a far-worded (different vocabulary) query that finds nothing on its own
 *      DOES find the memory once a language-matched bridge widens it;
 *   2. with the layer off (no pool), the same query finds nothing — so the lift
 *      is attributable to the bridge, not the index;
 *   3. a bridge in the WRONG language pool does not fire — language isolation
 *      holds through the handler, not just in the unit test.
 *
 * Run: npx tsx --test packages/daemon/__tests__/learned-recall-integration.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { recallHandler, type ToolDeps } from "../src/tool-handlers.js";
import { BridgePool, bridgeId, type Bridge } from "../src/learned-recall/bridges.js";
import type { SupportedLanguage } from "../src/learned-recall/language.js";

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

function bridge(lang: SupportedLanguage, trigger: string[], expansion: string[]): Bridge {
  return { id: bridgeId(lang, trigger, expansion), lang, trigger_terms: trigger, expansion_terms: expansion, evidence: 3 };
}

async function poolWith(bridges: Bridge[]): Promise<BridgePool> {
  const root = await mkdtemp(join(tmpdir(), "bastra-bridge-pool-"));
  for (const b of bridges) {
    const dir = join(root, "bridges", b.lang);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${b.id}.json`), JSON.stringify(b), "utf8");
  }
  return BridgePool.load(root);
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

test("language isolation: an English-pool bridge with the same triggers leaves a German query unchanged", async () => {
  await withVault(async (mkDeps) => {
    const off = scoreFor(await recallHandler(mkDeps(), { query: FAR_DE_QUERY, k: 5, min_score: 0 }), "panel-dismiss");
    // Same trigger/expansion terms, but filed under the English pool. The query
    // detects as German, so only the (empty) German pool is consulted.
    const pool = await poolWith([
      bridge("en", ["fenster", "schließt"], ["resignkey", "observer", "attachedsheet", "dismiss"]),
    ]);
    const en = scoreFor(
      await recallHandler(mkDeps({ learnedBridges: pool }), { query: FAR_DE_QUERY, k: 5, min_score: 0 }),
      "panel-dismiss",
    );
    assert.equal(en, off, "a wrong-language bridge must not change recall at all");
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
