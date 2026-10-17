import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { mergeBatchResults, projectRecallResult } from "../src/recall-batch.js";
import { assembleHookRecallPayload } from "../src/hook-recall-payload.js";
import { recallHandler } from "../src/recall-handler.js";
import { Telemetry } from "../src/telemetry.js";

for (const mixed of [false, true]) {
  test(`batch preserves supersession after ${mixed ? "query-rank fusion" : "score merge"}, before top-k`, () => {
    const old = { id: "old", score: 150, superseded_by: "new" };
    const fresh = { id: "new", score: 100 };
    const subs = [
      { hits: [old], score_kind: "rrf" as const },
      { hits: [fresh, { ...old, score: 99.999 }], score_kind: mixed ? "bm25" as const : "rrf" as const },
    ];
    const merged = mergeBatchResults(["old anchor", "current question"], subs, 2);
    assert.deepEqual(merged.hits.map(h => h.id), ["new", "old"]);
    assert.equal(merged.hits[0].score, 100);
    assert.equal(merged.hits[1].score, 150, "keep the actual selected single-query score");
    assert.equal(mergeBatchResults(["old", "current"], subs, 1).hits[0].id, "new");
    assert.deepEqual(subs[0].hits, [old], "do not mutate sub-results");
  });
}

test("batch chains, absent successors and cycles", () => {
  const merge = (hits: { id: string; score: number; superseded_by?: string }[]) =>
    mergeBatchResults(["q"], [{ hits }], 10).hits.map(h => h.id);
  assert.deepEqual(merge([{ id: "a", score: 30, superseded_by: "b" }, { id: "b", score: 20, superseded_by: "c" }, { id: "c", score: 10 }]), ["c", "b", "a"]);
  assert.deepEqual(merge([{ id: "a", score: 30, superseded_by: "missing" }, { id: "b", score: 20 }]), ["a", "b"]);
  assert.deepEqual(merge([{ id: "a", score: 30, superseded_by: "b" }, { id: "b", score: 20, superseded_by: "a" }]), ["a", "b"]);
});

test("direct MCP and hook-to-forwarder projections carry supersession into batch merge", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "superseded-batch-"));
  for (const id of ["old", "new"]) {
    await writeFile(join(dir, `${id}.md`), `---\nid: ${id}\ntitle: Zebra migration\ntype: reference\nsummary: Zebra migration\nscope: test\ntopic_path: [test]\ntags: []\nrecall_when: []\ncreated: 2026-01-01\nupdated: 2026-01-01\n${id === "old" ? "superseded_by: new\n" : ""}---\n\n${id === "old" ? "quartzlegacy" : "current"}\n`);
  }
  const vault = new Vault(dir); await vault.init();
  const search = new SearchIndex(vault); search.start();
  t.after(async () => { search.stop(); await rm(dir, { recursive: true, force: true }); });
  const deps = { vault, search, telemetry: new Telemetry(), vaultPath: dir };
  const queries = ["quartzlegacy", "zebra migration"];
  const direct = await recallHandler(deps, { queries, min_score: 0, k: 2 });
  assert.deepEqual((direct.hits as { id: string }[]).map(h => h.id), ["new", "old"]);
  for (const verbosity of ["lean", "full"]) {
    const result = await recallHandler(deps, { query: "quartzlegacy", min_score: 0, verbosity });
    assert.equal((result.hits[0] as { superseded_by?: string }).superseded_by, "new");
  }
  const subs = queries.map(query => {
    const result = assembleHookRecallPayload({ hits: search.recall(query, { k: 2 }), candidatePool: [], vault,
      maxTokens: 0, totalLatencyMs: 0, recallId: query, weakResult: false, noHome: false,
      hookProject: null, hybridActiveAtRecall: false, degradedReason: undefined }).payload;
    return projectRecallResult(query, { ...result, reflex_hits: result.reflex_hits?.map(hit => ({ ...hit })) });
  });
  const merged = mergeBatchResults(queries, subs, 2);
  assert.deepEqual(merged.hits.map(h => h.id), ["new", "old"]);
});

test("batch promotes a weak successor ahead of the strong predecessor and fillers", () => {
  const hits = [{ id: "old", score: 170, superseded_by: "new" },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, score: 15 })), { id: "new", score: 0.074 }];
  assert.deepEqual(mergeBatchResults(["q"], [{ hits }], 2).hits.map(h => h.id), ["new", "old"]);
});
