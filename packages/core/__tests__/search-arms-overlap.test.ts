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
 *   2. die Wanduhr ist `max(bm25, dense)`, nicht die Summe — ebenfalls ohne
 *      Stoppuhr (#1019): ein Arm, der genau im BM25-Fenster fertig wird,
 *      kostet den Aufrufer danach keinen Timer-Tick mehr
 *   3. die Dense-Deadline ist ab dem `await` armiert, nicht ab dem Abfeuern
 *      (#466, kehrt #370 um): Der Request geht erst auf die Leitung, wenn der
 *      Loop frei ist — ein Timer ab Abfeuern misst deshalb die BM25-Dauer,
 *      nicht den Arm, und schnitt ihn bei jeder langen Query ab. Ein Arm, der
 *      nach dem Warten wirklich zu langsam ist, läuft weiterhin in den Timeout
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
  /** `Infinity`: antwortet nie — der einzige „zu langsame" Arm, der nicht von
   *  der Geschwindigkeit des Runners abhängt (#466, CI-Flake 03.09.). */
  /** Wurde `embed` betreten? Wird gesetzt, bevor irgendein `await` läuft. */
  public dispatched = false;
  /** #1019: `embed` wartet auf `release()` statt auf eine Uhr. */
  public gated = false;
  private open: (() => void) | null = null;

  /** Gibt den Arm frei, der GERADE unterwegs ist. Ist noch keiner abgefeuert,
   *  bleibt der spätere zu und antwortet nie — `false` sagt das. */
  release(): boolean {
    if (!this.open) return false;
    this.open();
    this.open = null;
    return true;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.dispatched = true;
    if (this.gated) await new Promise<void>((r) => (this.open = r));
    if (this.delayMs === Infinity) await new Promise<never>(() => {});
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
  // #542: white-box access to the private queue-drain — see ranking-order.test.ts.
  await (emb as unknown as { flushQueue(): Promise<void> }).flushQueue();
  // Der Backfill hat `embed` schon betreten; ohne Reset stünde die Flagge aus
  // Test 1 auch bei einem erst nach BM25 abgefeuerten Arm auf `true` (#1019).
  provider.dispatched = false;
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
  provider.gated = true;

  // #1019: Hier stand eine Stoppuhr — 150 ms CPU, 200 ms Provider, Schranke
  // 300 ms —, und unter Last (parallele Suites) riss sie, ohne dass etwas
  // falsch war. Jetzt entscheidet die Reihenfolge, nicht die Dauer:
  //   - Der Arm wird am bm25-Stop freigegeben, also im Fenster, in dem BM25
  //     den Loop noch hält. Das geht nur, wenn er da schon unterwegs ist;
  //     sequentiell abgefeuert wäre `release()` ins Leere gegangen und der
  //     Arm hätte nie geantwortet.
  //   - Ab dort bis zum Fusionsergebnis laufen nur noch Microtasks. Eine
  //     Frist von 1 ms kann deshalb nicht vorher fallen — ein Timer läuft
  //     frühestens im nächsten Durchlauf des Loops. Der Aufrufer zahlt nach
  //     BM25 also nichts mehr für den dichten Arm: max, nicht Summe. Wer ihn
  //     erst nach BM25 abfeuerte, liefe hier in `vector-arm-timeout`.
  let releasedDuringBm25 = false;
  let vectorHits: unknown;
  let degraded: unknown = "no done event";
  await search.recallHybrid("ANCHORWORD", {
    k: 5,
    vector_deadline_ms: 1,
    onStage: (s: RecallStage) => {
      if (s.name === "bm25.search" && s.durationMs !== undefined) releasedDuringBm25 = provider.release();
      if (s.name === "vector.search" && s.durationMs !== undefined) vectorHits = s.meta?.vector_hit_count;
      if (s.name === "done") degraded = s.meta?.degraded;
    },
  });

  assert.equal(releasedDuringBm25, true, "the dense arm must be in flight while BM25 still holds the loop");
  assert.equal(degraded, undefined, "an arm that finished inside the BM25 window must not cost the caller a timer tick");
  assert.ok(typeof vectorHits === "number" && vectorHits > 0, `the dense arm's hits are fused — got ${String(vectorHits)}`);
});

// ─── 3. Deadline ab dem Warten ─────────────────────────────────────────────

test("#466: work between dispatch and await does not consume the dense arm's budget", async (t) => {
  const { search, provider } = await hybridFixture(t);
  // Dense-Arm 200 ms, Deadline 100 ms, 150 ms Arbeit zwischen Dispatch und
  // `await`. Ab Abfeuern armiert (#370) lief die Deadline während dieser
  // Arbeit ab — in Produktion bei jeder langen Query, weil der Request auf
  // einem kalten Socket ohnehin erst nach der Arbeit rausging (02.09.: 27 von
  // 49 Prompt-Lane-Recalls unfused). Ab dem `await` armiert kommt der Arm
  // ~50 ms nach Beginn des Wartens an und fusioniert.
  provider.delayMs = 200;

  // #1019: Die Schranke `elapsed < 300` ist weg — sie prüfte max statt Summe
  // ein zweites Mal, per Stoppuhr; das macht jetzt Test 2 ohne Uhr.
  let degraded: unknown;
  const hits = await search.recallHybrid("ANCHORWORD", {
    k: 5,
    vector_deadline_ms: 100,
    onStage: (s: RecallStage) => {
      if (s.name === "bm25.search" && s.durationMs !== undefined) burnCpu(150);
      if (s.name === "done") degraded = s.meta?.degraded;
    },
  });

  assert.equal(degraded, undefined, "the arm arrived inside its budget measured from the await — no degradation");
  assert.ok(hits.length > 0);
});

test("#466: an arm still slower than its budget after the await keeps timing out", async (t) => {
  const { search, provider } = await hybridFixture(t);
  // 150 ms Arbeit, dann 100 ms Frist: ein Arm, der nie antwortet, ist auch
  // ab dem `await` gemessen zu langsam — die Frist ist verschoben, nicht weg.
  // „Nie" statt einer festen Verzögerung, damit ein langsamer Runner die
  // Antwort nicht doch noch vor die Frist schiebt.
  provider.delayMs = Infinity;

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

  assert.equal(degraded, "vector-arm-timeout");
  assert.ok(hits.length > 0, "the cheap arm's answer is still served");
  assert.ok(elapsed < 1000, `≈ 150 + 100 ms expected, must not wait for an arm that never answers — took ${elapsed} ms`);
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
