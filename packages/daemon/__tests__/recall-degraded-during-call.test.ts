/**
 * P0 (docs/recall-performance-handoff.md §8): Der Handler bestimmte
 * `hybridActive` aus dem Breaker-Zustand VOR dem Recall. Fällt der Vector-Arm
 * WÄHREND des Calls aus — Deadline gerissen, Provider-Fehler —, dann degradiert
 * `recallHybrid` still auf rohes BM25, der Breaker bleibt aber zu. Der Handler
 * nannte dasselbe Ergebnis weiterhin hybrid und rechnete `weak_result` /
 * `no_home` auf einer Skala aus, die gar nicht lief.
 *
 * Diese Suite nagelt fest, dass die Antwort ihren eigenen Score-Raum benennt.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/recall-degraded-during-call.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, EmbeddingIndex, type EmbeddingProvider } from "@bastra-recall/core";
import { recallHandler, type ToolDeps } from "../src/tool-handlers.js";
import { Telemetry } from "../src/telemetry.js";

/**
 * Embedded den Bestand normal, verweigert aber ab `breakNow` jede weitere
 * Anfrage — also genau die Query-Embeds. Das ist die Form, die der Breaker
 * nicht rechtzeitig sieht: Beim Betreten des Calls war noch alles gesund.
 */
class BreakingProvider implements EmbeddingProvider {
  readonly id = "fake-breaking";
  readonly dim = 4;
  breakNow = false;
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.breakNow) throw new Error("provider is down");
    return texts.map((t) => {
      const v = new Float32Array(4);
      for (let i = 0; i < t.length; i++) v[i % 4] += t.charCodeAt(i) / 1000;
      return v;
    });
  }
}

function memo(id: string, title: string, recallWhen: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: lesson",
    `summary: ${title} summary text`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: degraded-test",
    "recall_when:",
    `  - ${recallWhen}`,
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `Body for ${title}.`,
    "",
  ].join("\n");
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "bastra-degraded-"));
  await writeFile(join(dir, "alpha.md"), memo("alpha", "alpha bravo", "alpha bravo lesson"), "utf8");
  await writeFile(join(dir, "charlie.md"), memo("charlie", "charlie delta", "charlie delta lesson"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const provider = new BreakingProvider();
  const emb = new EmbeddingIndex(vault, provider, join(dir, ".bastra", "embeddings.json"));
  await emb.start();
  await waitFor(() => emb.size() === 2);
  search.useEmbeddings(emb);
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: dir };
  return {
    deps,
    provider,
    close: async () => {
      await emb.stop();
      search.stop();
      await vault.stop?.();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

test("a healthy hybrid call reports the fused score space", async (t) => {
  const h = await harness();
  t.after(h.close);

  const res = (await recallHandler(h.deps, { query: "alpha bravo", k: 3 })) as {
    score_kind?: string;
    unfused?: boolean;
    degraded?: string;
  };
  assert.equal(res.score_kind, "rrf", "both arms ran — the score is a fused rank sum");
  assert.equal(res.unfused, undefined, "absent means fused");
  assert.equal(res.degraded, undefined);
});

test("a provider that dies mid-call makes the answer say so", async (t) => {
  const h = await harness();
  t.after(h.close);

  // Gesund betreten, unterwegs kaputt: genau der Fall, den der Breaker-Zustand
  // vor dem Call nicht beantworten kann.
  h.provider.breakNow = true;

  const res = (await recallHandler(h.deps, { query: "alpha bravo", k: 3 })) as {
    score_kind?: string;
    unfused?: boolean;
    degraded?: string;
    hits: unknown[];
  };
  assert.equal(res.score_kind, "bm25", "no fusion ran — the score is raw and unbounded");
  assert.equal(res.unfused, true, "the caller must not have to infer this from the number");
  assert.equal(res.degraded, "vector-arm-error", "and it must say WHY, not just THAT");
  assert.ok(res.hits.length > 0, "degrading is not failing — the lexical answer still ships");
});

test("weak_result does not fire on a degraded call", async (t) => {
  const h = await harness();
  t.after(h.close);
  h.provider.breakNow = true;

  // `weak_result` ist für den fusionierten Pfad definiert („rank-1-of-nothing").
  // Auf der rohen Skala gibt es diese Aussage nicht — sie hier zu treffen wäre
  // eine Behauptung über eine Fusion, die nicht stattgefunden hat.
  const res = (await recallHandler(h.deps, { query: "voellig zusammenhangloser quatsch", k: 3 })) as {
    weak_result?: boolean;
    no_home?: boolean;
    unfused?: boolean;
  };
  assert.equal(res.unfused, true, "precondition: this call must be degraded");
  assert.equal(res.weak_result, undefined, "hybrid-only honesty flag stays out of the raw path");
  assert.equal(res.no_home, undefined, "same for its stricter sibling");
});
