/**
 * Arm B's memory and document stubs answer in the PRODUCT's shapes (#595).
 *
 * The arm is offered the product's whole MCP surface so that a missing tool
 * cannot itself become the difference between the arms. That claim holds only
 * while the stubbed half is indistinguishable from a real, empty vault: a
 * hand-built `recall` answer omitted `query` and the score space, and an agent
 * that had seen bastra-recall before could tell. These tests hold the stub
 * against the daemon's own payload assembly over a real empty vault.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, isNoHome, isWeakResult } from "@bastra-recall/core";

// @ts-expect-error — plain .mjs script, no declarations (#542).
const { emptyVaultAnswer } = await import("../code-roi/v2/empty-vault.mjs");
const { assembleHookRecallPayload } = await import("../../daemon/src/hook-recall-payload.js");
const { projectRecallResult } = await import("../../daemon/src/recall-batch.js");

/** What the MCP forwarder returns for `recall` against an empty vault: the daemon's payload, projected. */
async function productEmptyRecall(query: string): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), "code-roi-empty-vault-"));
  try {
    const vault = new Vault(root);
    await vault.init();
    const hybridActiveAtRecall = true;
    const { payload } = assembleHookRecallPayload({
      hits: [],
      candidatePool: [],
      vault,
      maxTokens: 0,
      totalLatencyMs: 0,
      recallId: "r1",
      weakResult: isWeakResult([], hybridActiveAtRecall),
      noHome: isNoHome([], hybridActiveAtRecall),
      hookProject: null,
      hybridActiveAtRecall,
      degradedReason: undefined,
    });
    // The forwarder hands the wire payload to the projection untyped (it
    // arrives as JSON); the cast says the same here.
    return projectRecallResult(query, payload as Parameters<typeof projectRecallResult>[1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the empty-vault recall stub is the product's answer (#595)", () => {
  test("its key set and key order equal the daemon's projection over an empty vault", async () => {
    const product = await productEmptyRecall("where is the config parsed");
    const stub = emptyVaultAnswer("recall", { query: "where is the config parsed" });
    assert.deepEqual(Object.keys(stub), Object.keys(product));
    const { recall_id: _s, ...stubRest } = stub;
    const { recall_id: _p, ...productRest } = product;
    assert.deepEqual(stubRest, productRest, "every field but the per-call id is identical");
  });

  test("the fields the hand-built stub lacked are present", () => {
    const stub = emptyVaultAnswer("recall", { query: "q" });
    assert.equal(stub.query, "q", "the product leads with the query");
    assert.equal(stub.score_kind, "rrf");
    assert.deepEqual(stub.score_arms, ["bm25", "vector"]);
    assert.equal(typeof stub.score_version, "string");
    assert.equal(stub.vault_size, 0);
    assert.deepEqual(stub.hits, []);
    assert.equal("weak_result" in stub, false, "no hits, so no honesty flag — as the product");
    assert.equal("status" in stub, false);
    assert.equal("note" in stub, false);
  });

  test("the lookups and writes keep their product wording", () => {
    assert.deepEqual(emptyVaultAnswer("load_memory", { id: "m1" }), { error: "memory not found: m1" });
    assert.deepEqual(emptyVaultAnswer("read_document", { id: "d1" }), { error: "document not found: d1" });
    assert.deepEqual(emptyVaultAnswer("find_document", { query: "x" }), { query: "x", docs_indexed: 0, hits: [] });
    assert.match(String(emptyVaultAnswer("save_memory", {}).error), /save_memory/);
  });
});
