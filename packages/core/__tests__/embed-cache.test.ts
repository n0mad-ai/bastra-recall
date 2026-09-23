import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Vault } from "../src/vault.js";
import { EmbeddingIndex, type EmbeddingProvider } from "../src/embeddings.js";
import { EmbedCache } from "../src/embed-cache.js";

/** rm mit einem Retry: der EmbedCache flusht asynchron — ein Write, der
 *  zwischen readdir und rmdir landet, macht das rekursive rm ENOTEMPTY
 *  (macOS-Race, flakte ~1/5 Läufe). Ein kurzer Settle + Retry genügt. */
async function rmSettled(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    await new Promise((r) => setTimeout(r, 150));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function memoryMd(id: string, title: string): string {
  return `---
id: ${id}
title: ${title}
type: lesson
summary: s
topic_path: [t]
tags: [t]
scope: t
recall_when: ["w"]
created: 2026-05-01
updated: 2026-05-01
---

body of ${id}
`;
}

class CountingMockProvider implements EmbeddingProvider {
  readonly id = "mock-counting";
  readonly dim = 4;
  public calls = 0;
  public totalTexts = 0;
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    this.totalTexts += texts.length;
    return texts.map(() => new Float32Array([1, 0, 0, 0]));
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!cond()) throw new Error(`waitFor timeout (${timeoutMs}ms)`);
}

test("embed-cache: identical content re-save does NOT trigger provider call", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-cache-1-"));
  try {
    const filePath = path.join(dir, "mem.md");
    await writeFile(filePath, memoryMd("mem", "Original Title"));
    const vault = new Vault(dir);
    await vault.init();

    const provider = new CountingMockProvider();
    const idx = new EmbeddingIndex(
      vault,
      provider,
      path.join(dir, ".bastra", "embeddings.json"),
    );
    await idx.start();
    await waitFor(() => idx.size() === 1);
    const baselineCalls = provider.totalTexts;
    assert.equal(baselineCalls, 1, "initial backfill must embed once");

    // Identischen Inhalt nochmal schreiben → vault emittiert change
    await writeFile(filePath, memoryMd("mem", "Original Title"));
    await vault.reindexFile(filePath);

    // Geben der Queue Zeit zu prozessieren
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(
      provider.totalTexts,
      baselineCalls,
      "no additional embed calls on identical content",
    );
    await idx.stop();
  } finally {
    await rmSettled(dir);
  }
});

test("embed-cache: title change invalidates cache and triggers re-embed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-cache-2-"));
  try {
    const filePath = path.join(dir, "mem.md");
    await writeFile(filePath, memoryMd("mem", "Original Title"));
    const vault = new Vault(dir);
    await vault.init();

    const provider = new CountingMockProvider();
    const idx = new EmbeddingIndex(
      vault,
      provider,
      path.join(dir, ".bastra", "embeddings.json"),
    );
    await idx.start();
    await waitFor(() => idx.size() === 1);
    assert.equal(provider.totalTexts, 1);

    // Title ändern → Hash ändert sich → re-embed
    await writeFile(filePath, memoryMd("mem", "Completely New Title"));
    await vault.reindexFile(filePath);

    await waitFor(() => provider.totalTexts >= 2, 3000);
    assert.equal(provider.totalTexts, 2, "title change must trigger re-embed");
    await idx.stop();
  } finally {
    await rmSettled(dir);
  }
});

test("embed-cache: cache persists across EmbeddingIndex instances", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-cache-3-"));
  try {
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "mem.md");
    await writeFile(filePath, memoryMd("mem", "Stable Title"));
    const vault = new Vault(dir);
    await vault.init();

    const persist = path.join(dir, ".bastra", "embeddings.json");

    // First run: warm cache + persisted vectors
    {
      const provider = new CountingMockProvider();
      const idx = new EmbeddingIndex(vault, provider, persist);
      await idx.start();
      await waitFor(() => idx.size() === 1);
      assert.equal(provider.totalTexts, 1);
      // schedulePersist hat ~1s debounce — wir warten kurz drauf
      await new Promise((r) => setTimeout(r, 1300));
      await idx.stop();
    }

    // Second run: gleicher vault, frischer Index, soll cache + vectors finden
    // und NICHT erneut embedden.
    {
      const vault2 = new Vault(dir);
      await vault2.init();
      const provider2 = new CountingMockProvider();
      const idx2 = new EmbeddingIndex(vault2, provider2, persist);
      await idx2.start();
      // Backfill startet nur wenn Vectors fehlen — bei warmem Cache + persistierten
      // Vectors sollte gar nichts in der Queue landen.
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(
        provider2.totalTexts,
        0,
        "second start with warm persist + cache must not re-embed",
      );
      assert.equal(idx2.size(), 1);
      idx2.stop();
    }
  } finally {
    await rmSettled(dir);
  }
});

test("embed-cache: an incompatible cache (version / provider / dim) is dropped WITH a log line, not silently", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-cache-4-"));
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const entries = { m1: { hash: "h", dim: 4, vector: [1, 0, 0, 0] } };
    const cases: Array<[string, Record<string, unknown>]> = [
      ["version", { version: 2, provider: "mock-counting", dim: 4, entries }],
      ["provider", { version: 1, provider: "other-provider", dim: 4, entries }],
      ["dim", { version: 1, provider: "mock-counting", dim: 8, entries }],
    ];
    for (const [label, file] of cases) {
      const cachePath = path.join(dir, `${label}.json`);
      await writeFile(cachePath, JSON.stringify(file));
      lines.length = 0;
      const cache = new EmbedCache(cachePath, "mock-counting", 4);
      await cache.load();
      assert.equal(cache.size(), 0, `${label}: incompatible cache must not be used`);
      // Filtered, not counted raw: an unrelated console.error in the same window must not flake this.
      const ignored = lines.filter((l) => /embed-cache ignored/.test(l));
      assert.equal(ignored.length, 1, `${label}: exactly one "embed-cache ignored" line expected, got ${ignored.length}`);
      assert.match(ignored[0], new RegExp(cachePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${label}: line names the file`);
    }
    // control: a compatible file loads silently
    const okPath = path.join(dir, "ok.json");
    await writeFile(okPath, JSON.stringify({ version: 1, provider: "mock-counting", dim: 4, entries }));
    lines.length = 0;
    const ok = new EmbedCache(okPath, "mock-counting", 4);
    await ok.load();
    assert.equal(ok.size(), 1);
    assert.deepEqual(lines.filter((l) => /embed-cache/.test(l)), [], "compatible cache must not log");
  } finally {
    console.error = orig;
    await rmSettled(dir);
  }
});
