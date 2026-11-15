import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Vault } from "../src/vault.js";
import { EmbeddingIndex, type EmbeddingProvider } from "../src/embeddings.js";

function memoryMd(id: string): string {
  return `---
id: ${id}
title: ${id}
type: lesson
summary: s
topic_path: [t]
tags: [t]
scope: t
recall_when: ["w"]
created: 2026-05-01
updated: 2026-05-01
---

body ${id}
`;
}

class SlowMockProvider implements EmbeddingProvider {
  readonly id = "mock-slow";
  readonly dim = 4;
  public calls = 0;
  public peakInFlight = 0;
  public inFlight = 0;
  constructor(private readonly latencyMs: number) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    this.inFlight++;
    if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
    try {
      await new Promise((r) => setTimeout(r, this.latencyMs));
      return texts.map((_, i) => new Float32Array([i, i, i, i]));
    } finally {
      this.inFlight--;
    }
  }
}

async function vaultWith(count: number): Promise<{ dir: string; vault: Vault }> {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-embed-bp-"));
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const id = `m${String(i).padStart(5, "0")}`;
    await writeFile(path.join(dir, `${id}.md`), memoryMd(id));
  }
  const vault = new Vault(dir);
  await vault.init();
  return { dir, vault };
}

test("flushQueue respects MAX_CONCURRENT_BATCHES (default 2)", async () => {
  // 200 Memories, 50 pro batch → 4 batches, sollte 2 parallel laufen lassen
  const { dir, vault } = await vaultWith(200);
  try {
    const provider = new SlowMockProvider(50);
    const persistPath = path.join(dir, ".bastra", "embeddings.json");
    const idx = new EmbeddingIndex(vault, provider, persistPath);
    await idx.start();
    // start() triggert flushQueue async; warten bis alle vectors da sind
    const deadline = Date.now() + 10_000;
    while (idx.size() < 200 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(idx.size(), 200, "all memories should be embedded");
    assert.ok(provider.peakInFlight <= 2, `peakInFlight = ${provider.peakInFlight}, must be <= 2`);
    await idx.stop();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("enqueue() applies backpressure when queue grows beyond limit", async () => {
  // backpressure-limit auf 20 setzen via env-override
  const prevLimit = process.env.BASTRA_EMBED_BACKPRESSURE_LIMIT;
  const prevStall = process.env.BASTRA_EMBED_BACKPRESSURE_STALL_MS;
  process.env.BASTRA_EMBED_BACKPRESSURE_LIMIT = "20";
  process.env.BASTRA_EMBED_BACKPRESSURE_STALL_MS = "30";
  // enqueue() liest die env zur Laufzeit → kein Modul-Reimport nötig.

  try {
    const { dir, vault } = await vaultWith(0);
    const provider = new SlowMockProvider(20);
    const persistPath = path.join(dir, ".bastra", "embeddings.json");
    const idx = new EmbeddingIndex(vault, provider, persistPath);
    await idx.start();

    // 100 dummy-IDs in den Vault stopfen (file + reindex), dann enqueue alle.
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = `bp${String(i).padStart(4, "0")}`;
      ids.push(id);
      await writeFile(path.join(dir, `${id}.md`), memoryMd(id));
      await vault.reindexFile(path.join(dir, `${id}.md`));
    }

    // Den Mechanismus prüfen, nicht seine Dauer (#331): die Wanduhr-Untergrenze
    // hielt nur solange der Stall das Langsamste im Burst war — unter voller
    // Suite-Last ist die umgebende Scheduling-Zeit nicht kontrolliert.
    await Promise.all(ids.map((id) => idx.enqueue(id)));

    // mit limit=20 stallt jeder enqueue ab dem 21. — der Burst startet alle
    // Callbacks synchron, also wächst die Queue über das Limit hinaus.
    assert.ok(
      idx.stallCount() > 0,
      `enqueue burst must stall once the queue exceeds the limit, stalls=${idx.stallCount()}`
    );

    await idx.stop();
    // Drain in-flight provider calls before rm(), else a late embed-write
    // into .bastra races the cleanup (ENOTEMPTY on the dir).
    while (idx.inFlightCount() > 0) await new Promise((r) => setTimeout(r, 10));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } finally {
    if (prevLimit === undefined) delete process.env.BASTRA_EMBED_BACKPRESSURE_LIMIT;
    else process.env.BASTRA_EMBED_BACKPRESSURE_LIMIT = prevLimit;
    if (prevStall === undefined) delete process.env.BASTRA_EMBED_BACKPRESSURE_STALL_MS;
    else process.env.BASTRA_EMBED_BACKPRESSURE_STALL_MS = prevStall;
  }
});

test("enqueue() does not stall while the queue stays under the limit", async () => {
  // Gegenrichtung zum Test oben: ohne diesen Fall wäre `stallCount > 0` auch
  // von einem enqueue erfüllt, das immer stallt.
  const prevLimit = process.env.BASTRA_EMBED_BACKPRESSURE_LIMIT;
  process.env.BASTRA_EMBED_BACKPRESSURE_LIMIT = "500";

  try {
    const { dir, vault } = await vaultWith(0);
    const provider = new SlowMockProvider(20);
    const persistPath = path.join(dir, ".bastra", "embeddings.json");
    const idx = new EmbeddingIndex(vault, provider, persistPath);
    await idx.start();

    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = `nb${String(i).padStart(4, "0")}`;
      ids.push(id);
      await writeFile(path.join(dir, `${id}.md`), memoryMd(id));
      await vault.reindexFile(path.join(dir, `${id}.md`));
    }

    await Promise.all(ids.map((id) => idx.enqueue(id)));

    assert.equal(idx.stallCount(), 0, "100 enqueues under a limit of 500 must never hit backpressure");

    await idx.stop();
    while (idx.inFlightCount() > 0) await new Promise((r) => setTimeout(r, 10));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } finally {
    if (prevLimit === undefined) delete process.env.BASTRA_EMBED_BACKPRESSURE_LIMIT;
    else process.env.BASTRA_EMBED_BACKPRESSURE_LIMIT = prevLimit;
  }
});

// Gates its FIRST batch open so a second add can slip into the drain-end
// window; every later batch resolves immediately.
class DrainRaceProvider implements EmbeddingProvider {
  readonly id = "mock-drain-race";
  readonly dim = 4;
  public calls: string[][] = [];
  readonly firstInFlight: Promise<void>;
  private signalFirst!: () => void;
  private openGate!: () => void;
  private readonly gate: Promise<void>;
  constructor() {
    this.firstInFlight = new Promise((r) => (this.signalFirst = r));
    this.gate = new Promise((r) => (this.openGate = r));
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push(texts);
    if (this.calls.length === 1) {
      this.signalFirst(); // first batch is in flight → queue already drained
      await this.gate; // hold it open until the test injects the second add
    }
    return texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4]));
  }
  release(): void {
    this.openGate();
  }
}

test("flushQueue re-checks the queue after a drain-window race (#233)", async () => {
  const { dir, vault } = await vaultWith(0);
  const provider = new DrainRaceProvider();
  const persistPath = path.join(dir, ".bastra", "embeddings.json");
  const idx = new EmbeddingIndex(vault, provider, persistPath);
  try {
    await idx.start(); // empty vault → no backfill

    // A: add → handle() enqueues + flushQueue(); the provider gates the first
    // batch, so flushQueue parks at `await Promise.all` with the queue drained
    // and `processing` still true.
    await writeFile(path.join(dir, "a.md"), memoryMd("a"));
    await vault.reindexFile(path.join(dir, "a.md"));
    await provider.firstInFlight;

    // B arrives INSIDE that window: pendingQueue={b}, but the guarded
    // flushQueue() no-ops because processing is still true.
    await writeFile(path.join(dir, "b.md"), memoryMd("b"));
    await vault.reindexFile(path.join(dir, "b.md"));

    // release A → the finally must re-trigger and drain B with NO further vault
    // event. Before #233's fix, B stranded here until the next event.
    provider.release();

    const deadline = Date.now() + 2000;
    while (idx.size() < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.equal(idx.size(), 2, "B must embed via the self re-trigger, not strand until the next event");
  } finally {
    await idx.stop();
    while (idx.inFlightCount() > 0) await new Promise((r) => setTimeout(r, 10));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
