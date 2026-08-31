/**
 * Die beiden Recall-Arme überlappen (#370).
 *
 * BM25 ist CPU-Arbeit in-process, der Dense-Arm ein Netzwerk-Roundtrip zu
 * Ollama, und zwischen beiden besteht keine Datenabhängigkeit — `fuseRRF`
 * konsumiert ohnehin erst beide Rank-Listen. Trotzdem lief `this.mini.search()`
 * vollständig durch, bevor der Embed überhaupt dispatched wurde: gemessen über
 * n=1545 `hook_recall` (19.–24.08.) war `latency_ms_recall − (bm25 + vector)`
 * p50 1 ms / p90 2 ms — die Stages addierten sich exakt zum Total, es
 * überlappte nichts. Die Wanduhr zahlte die Summe (p50 157 ms) statt des
 * Maximums (p50 137 ms), in der Prompt-Lane 200 gegen 144 ms.
 *
 * Was diese Tests festnageln:
 *   1. der Dense-Arm ist bereits unterwegs, wenn der lexikalische Arm anfängt
 *      — der Beweis läuft über eine synchrone Flagge im Provider, nicht über
 *      eine Stoppuhr, damit er nicht unter Last kippt
 *   2. die Wanduhr ist `max(bm25, dense)`, nicht die Summe
 *   3. die Dense-Deadline ist ab dem ABFEUERN armiert, nicht ab dem `await` —
 *      sonst bekäme der Arm sein Budget plus die BM25-Zeit, und genau das
 *      Budget, das #305 senken will, würde sich lautlos weiten
 *   4. die Stop-Events kommen weiter in kanonischer Reihenfolge, damit der
 *      MCP-Progress nicht zurückspringt, und `vector.search` markiert die
 *      Überlappung, weil die Stages jetzt keine Partition des Totals mehr sind
 *
 * Runner: node --import tsx --test packages/core/__tests__/search-arms-overlap.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Vault } from "../src/vault.js";
import { SearchIndex } from "../src/search.js";
import { EmbeddingIndex, type EmbeddingProvider } from "../src/embeddings.js";
import type { RecallStage } from "../src/recall-stages.js";
import { progressIndexFor } from "../src/recall-stages.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Blockiert den Event-Loop. Steht für „BM25 rechnet" — und nur eine echte
 *  Blockade beweist die Überlappung, weil ein `await` hier nichts über die
 *  Reihenfolge der Dispatches sagen würde. */
function burnCpu(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin */
  }
}

function memoryMd(id: string, marker = "ANCHORWORD"): string {
  return `---
id: ${id}
title: ${id} ${marker}
type: lesson
summary: ${marker} summary
topic_path: [t]
tags: [t]
scope: t
recall_when: ["${marker}"]
created: 2020-01-01
updated: 2026-07-01
---

Body ${marker} ${id}.
`;
}

/** Provider, der seinen Eintritt SYNCHRON quittiert und danach verzögert. */
class TracingProvider implements EmbeddingProvider {
  readonly id = "tracing-mock";
  readonly dim = 3;
  public delayMs = 0;
  /** Wurde `embed` betreten? Wird gesetzt, bevor irgendein `await` läuft. */
  public dispatched = false;
  public dispatchedAt = 0;

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.dispatched = true;
    this.dispatchedAt = Date.now();
    if (this.delayMs > 0) await sleep(this.delayMs);
    return texts.map(() => new Float32Array([1, 0, 0]));
  }
}

async function hybridFixture(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-arms-"));
  await writeFile(path.join(dir, "a.md"), memoryMd("alpha"), "utf8");
  await writeFile(path.join(dir, "b.md"), memoryMd("beta"), "utf8");

  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();

  const provider = new TracingProvider();
  const emb = new EmbeddingIndex(vault, provider, path.join(dir, ".bastra", "embeddings.json"));
  await emb.start();
  await emb.flushQueue?.();
  search.useEmbeddings(emb);

  t.after(async () => {
    await emb.stop();
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  return { search, provider, emb };
}

// ─── 1. Reihenfolge der Dispatches ──────────────────────────────────────────

test("#370: the dense arm is already in flight when the lexical arm starts", async (t) => {
  const { search, provider } = await hybridFixture(t);
  provider.delayMs = 30;

  let dispatchedAtBm25Start: boolean | null = null;
  await search.recallHybrid("ANCHORWORD", {
    k: 5,
    onStage: (s: RecallStage) => {
      // Start-Event: `durationMs` fehlt noch.
      if (s.name === "bm25.search" && s.durationMs === undefined) {
        dispatchedAtBm25Start = provider.dispatched;
      }
    },
  });

  assert.equal(
    dispatchedAtBm25Start,
    true,
    "the embed must be dispatched before BM25 begins — otherwise the arms cannot overlap",
  );
});

// ─── 2. Wanduhr ─────────────────────────────────────────────────────────────

test("#370: the wall clock pays max(bm25, dense), not their sum", async (t) => {
  const { search, provider } = await hybridFixture(t);
  provider.delayMs = 200;

  // 150 ms echte CPU-Arbeit zwischen Dispatch und `await`, eingehängt am
  // bm25-Stop — genau das Fenster, in dem der Dense-Arm mitlaufen soll.
  const started = Date.now();
  await search.recallHybrid("ANCHORWORD", {
    k: 5,
    onStage: (s: RecallStage) => {
      if (s.name === "bm25.search" && s.durationMs !== undefined) burnCpu(150);
    },
  });
  const elapsed = Date.now() - started;

  assert.ok(
    elapsed < 300,
    `expected ≈ max(150, 200) ms, sequential would be ≈ 350 ms — measured ${elapsed} ms`,
  );
  assert.ok(
    provider.dispatchedAt - started < 100,
    `the embed was dispatched ${provider.dispatchedAt - started} ms in, so it did not wait for BM25`,
  );
});

// ─── 3. Deadline ab Abfeuern ────────────────────────────────────────────────

test("#370: the dense deadline is armed at dispatch, not at the await", async (t) => {
  const { search, provider } = await hybridFixture(t);
  // Dense-Arm 200 ms, Deadline 100 ms, 150 ms Arbeit zwischen Dispatch und
  // `await`. Ab Abfeuern armiert läuft die Deadline während dieser Arbeit ab
  // ⇒ Degradation. Erst am `await` armiert hätte der Arm 250 ms und würde mit
  // 200 ms durchkommen — dieselbe Zeile, ein stillschweigend geweitetes
  // Budget und eine nicht mehr messbare Timeout-Rate.
  provider.delayMs = 200;

  let degraded: unknown = "no done event";
  const started = Date.now();
  const hits = await search.recallHybrid("ANCHORWORD", {
    k: 5,
    vector_deadline_ms: 100,
    onStage: (s: RecallStage) => {
      if (s.name === "bm25.search" && s.durationMs !== undefined) burnCpu(150);
      if (s.name === "done") degraded = s.meta?.degraded;
    },
  });
  const elapsed = Date.now() - started;

  assert.equal(
    degraded,
    "vector-arm-timeout",
    "a 100 ms deadline armed at dispatch must have expired during the 150 ms of work",
  );
  assert.ok(hits.length > 0, "the cheap arm's answer is still served");
  assert.ok(elapsed < 200, `must not wait for the 200 ms arm — took ${elapsed} ms`);
});

// ─── 4. Telemetrie und Progress ─────────────────────────────────────────────

test("#370: stop events keep the canonical order and vector.search declares the overlap", async (t) => {
  const { search, provider } = await hybridFixture(t);
  provider.delayMs = 0;

  const stops: RecallStage[] = [];
  const hits = await search.recallHybrid("ANCHORWORD", {
    k: 5,
    onStage: (s: RecallStage) => {
      if (s.durationMs !== undefined) stops.push(s);
    },
  });
  assert.ok(hits.length > 0);

  const names = stops.map((s) => s.name);
  assert.ok(
    names.indexOf("bm25.search") < names.indexOf("vector.search"),
    `bm25 must still STOP first — got ${names.join(" → ")}`,
  );
  const idx = names.map(progressIndexFor);
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i] >= idx[i - 1], `progress went backwards: ${names.join(" → ")}`);
  }

  const vec = stops.find((s) => s.name === "vector.search");
  assert.equal(
    vec?.meta?.overlapped,
    true,
    "the stage timers no longer partition the total — that has to be readable from the event",
  );
});
