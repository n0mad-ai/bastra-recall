/**
 * #631: Der RelatedEnricher schreibt die Auto-Related-Section in den Body.
 * Ging die Section in Embed-Text und Content-Hash ein, hing der Vektor an der
 * eigenen Ausgabe — live tauschte ein Memory seinen fünften Nachbarn im
 * Sekundentakt und hielt Ollama dauerhaft unter Last.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Vault } from "../src/vault.js";
import { EmbeddingIndex, type EmbeddingProvider } from "../src/embeddings.js";
import { hashEmbedContent } from "../src/embed-cache.js";
import { RelatedEnricher } from "../src/related-enrich.js";
import { AUTO_RELATED_START, AUTO_RELATED_END } from "../src/save-text.js";
import type { Memory } from "../src/schema.js";

async function rmSettled(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    await new Promise((r) => setTimeout(r, 150));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!cond()) throw new Error(`waitFor timeout (${timeoutMs}ms)`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function section(ids: string[]): string {
  return [
    `## Auto-Related ${AUTO_RELATED_START}`,
    "",
    ...ids.map((id) => `- [[${id}]] (cosine 0.80)`),
    "",
    AUTO_RELATED_END,
    "",
  ].join("\n");
}

function memoryMd(id: string, body: string): string {
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

${body}`;
}

function mem(body: string): Memory {
  return {
    fm: { id: "m", title: "T", tags: ["a"], recall_when: ["w"], summary: "s" },
    body,
  } as unknown as Memory;
}

class CountingProvider implements EmbeddingProvider {
  readonly id = "mock-631";
  readonly dim = 3;
  public texts: string[] = [];
  constructor(private readonly vectorFor: (text: string) => number[] = () => [1, 0, 0]) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.texts.push(...texts);
    return texts.map((t) => new Float32Array(this.vectorFor(t)));
  }
}

test("#631: the content hash ignores the auto-related section, but not the authored body", () => {
  const authored = "authored text\n";
  const base = hashEmbedContent(mem(authored));
  assert.equal(hashEmbedContent(mem(`${authored}\n${section(["x"])}`)), base);
  assert.equal(hashEmbedContent(mem(`${authored}\n${section(["y", "z"])}`)), base);
  assert.notEqual(hashEmbedContent(mem("other authored text\n")), base);
});

test("#631: a long body keeps its authored text in the 4000-char window instead of the section", () => {
  const authored = "a".repeat(3990);
  // Beide Bodies haben identische erste 4000 Zeichen im Rohtext NICHT — erst
  // durch das Strippen fällt die Section heraus und der Text dahinter zählt.
  const withSection = `${authored}\n${section(["x"])}tail-written-by-a-human\n`;
  const without = `${authored}\ntail-written-by-a-human\n`;
  assert.equal(hashEmbedContent(mem(withSection)), hashEmbedContent(mem(without)));
});

test("#631: a memory whose only change is its auto-related section is not re-embedded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-631-a-"));
  try {
    const file = path.join(dir, "host.md");
    await writeFile(file, memoryMd("host", "authored\n"));
    const vault = new Vault(dir);
    await vault.init();
    const provider = new CountingProvider();
    const idx = new EmbeddingIndex(vault, provider, path.join(dir, ".bastra", "embeddings.json"));
    await idx.start();
    await waitFor(() => idx.size() === 1);
    assert.equal(provider.texts.length, 1);

    await writeFile(file, memoryMd("host", `authored\n\n${section(["x", "y"])}`));
    await vault.reindexFile(file);
    await sleep(300);
    assert.equal(provider.texts.length, 1, "a section-only change must not reach the provider");
    assert.ok(!provider.texts[0].includes(AUTO_RELATED_START), "the embed text never carries the section");
    await idx.stop();
  } finally {
    await rmSettled(dir);
  }
});

test("#631: boot re-embeds a vector whose cache entry carries a different hash, and only that", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-631-b-"));
  try {
    const file = path.join(dir, "host.md");
    await writeFile(file, memoryMd("host", "authored v1\n"));
    await writeFile(path.join(dir, "other.md"), memoryMd("other", "unchanged\n"));
    const persist = path.join(dir, ".bastra", "embeddings.json");
    {
      const vault = new Vault(dir);
      await vault.init();
      const idx = new EmbeddingIndex(vault, new CountingProvider(), persist);
      await idx.start();
      await waitFor(() => idx.size() === 2);
      await idx.stop();
      await sleep(100); // cache.save ist fire-and-forget
    }

    // Geändert, während kein Index lief (oder: Hash-Definition geändert).
    await writeFile(file, memoryMd("host", "authored v2\n"));
    {
      const vault = new Vault(dir);
      await vault.init();
      const provider = new CountingProvider();
      const idx = new EmbeddingIndex(vault, provider, persist);
      await idx.start();
      await waitFor(() => provider.texts.length === 1);
      await sleep(200);
      assert.equal(provider.texts.length, 1, "only the stale memory is re-embedded");
      assert.match(provider.texts[0], /authored v2/);
      await idx.stop();
      await sleep(100);
    }

    // Vektoren ohne Cache-Eintrag (z.B. von außen eingespielt) bleiben stehen.
    await unlink(path.join(dir, ".bastra", "embed-cache.json"));
    await writeFile(file, memoryMd("host", "authored v3\n"));
    {
      const vault = new Vault(dir);
      await vault.init();
      const provider = new CountingProvider();
      const idx = new EmbeddingIndex(vault, provider, persist);
      await idx.start();
      await sleep(200);
      assert.equal(provider.texts.length, 0, "no cache entry → no evidence of staleness → no re-embed");
      await idx.stop();
    }
  } finally {
    await rmSettled(dir);
  }
});

test("#631: enricher + index settle after one write even when listing a neighbour would flip the ranking", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bastra-631-c-"));
  try {
    const hostFile = path.join(dir, "host.md");
    await writeFile(hostFile, memoryMd("host", "authored\n"));
    await writeFile(path.join(dir, "x.md"), memoryMd("x", "x body\n"));
    await writeFile(path.join(dir, "y.md"), memoryMd("y", "y body\n"));
    const vault = new Vault(dir);
    await vault.init();
    // Der Nachbar, der in der Section steht, verliert klar (weit über ε) —
    // genau die Rückkopplung aus #631, nur deutlicher. Hinge der Vektor an der
    // Section, schriebe der Enricher x, y, x, y, …
    const provider = new CountingProvider((t) => {
      if (t.startsWith("x\n")) return [1, 0, 0];
      if (t.startsWith("y\n")) return [0, 1, 0];
      if (t.includes("[[x]]")) return [0.8, 1, 0.3];
      if (t.includes("[[y]]")) return [1, 0.8, 0.3];
      return [1, 0.99, 0.3];
    });
    const idx = new EmbeddingIndex(vault, provider, path.join(dir, ".bastra", "embeddings.json"));
    const enricher = new RelatedEnricher(vault, idx, { topN: 1, threshold: 0 });
    let hostWrites = 0;
    const origEnrich = enricher.enrich.bind(enricher);
    enricher.enrich = async (id: string) => {
      const r = await origEnrich(id);
      if (id === "host" && r) hostWrites++;
      return r;
    };
    enricher.start();
    await idx.start();
    await waitFor(() => idx.size() === 3);
    await sleep(800);
    const settled = await readFile(hostFile, "utf8");
    await sleep(500);
    assert.equal(await readFile(hostFile, "utf8"), settled, "the host file is stable");
    assert.ok(hostWrites <= 1, `host written ${hostWrites} times, expected at most once`);
    assert.match(settled, /\[\[x\]\]/);
    const hostEmbeds = provider.texts.filter((t) => t.startsWith("host\n")).length;
    assert.equal(hostEmbeds, 1, "the enricher's own write does not re-embed the host");
    enricher.stop();
    await idx.stop();
  } finally {
    await rmSettled(dir);
  }
});
