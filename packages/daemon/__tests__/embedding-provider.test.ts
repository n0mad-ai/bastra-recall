/**
 * #1520 D7: the daemon and the app bridge build their embedding provider in one
 * place. Provider choice, Ollama parameters and status per environment case, for
 * both callers (the daemon sends keep_alive, the bridge does not).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveEmbedding } from "../src/embedding-provider.js";

async function withSettings<T>(settings: object | null, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-embedding-provider-"));
  try {
    const path = join(dir, "cli-settings.json");
    if (settings) await writeFile(path, JSON.stringify(settings));
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const fields = (p: unknown) => p as Record<string, unknown>;

for (const keepAlive of [true, false]) {
  const who = keepAlive ? "daemon" : "bridge";

  test(`${who}: Ollama from env with URL, model and dim`, async () => {
    await withSettings(null, async (path) => {
      const invalid: string[] = [];
      const r = await resolveEmbedding({
        keepAlive,
        onInvalidEnv: (raw) => invalid.push(raw),
        path,
        env: {
          BASTRA_EMBEDDING_PROVIDER: "OLLAMA",
          BASTRA_OLLAMA_URL: "http://127.0.0.1:9999",
          BASTRA_EMBEDDING_MODEL: "bge-m3",
          BASTRA_EMBEDDING_DIM: "1024",
          BASTRA_OLLAMA_KEEP_ALIVE: "1h",
        },
      });
      assert.deepEqual(invalid, []);
      assert.equal(r.status.on, true);
      assert.equal(r.status.source, "env");
      assert.equal(r.status.providerId, r.provider!.id);
      assert.equal(r.provider!.dim, 1024);
      assert.equal(fields(r.provider).model, "bge-m3");
      assert.equal(fields(r.provider).keepAlive, keepAlive ? "1h" : undefined);
      assert.deepEqual(
        r.ollama,
        keepAlive ? { baseURL: "http://127.0.0.1:9999", model: "bge-m3", keepAlive: "1h" } : undefined
      );
    });
  });

  test(`${who}: Ollama defaults, a non-numeric dim falls back to the provider default`, async () => {
    await withSettings({ embedding: { provider: "ollama" } }, async (path) => {
      const r = await resolveEmbedding({
        keepAlive,
        onInvalidEnv: () => {},
        path,
        env: { BASTRA_EMBEDDING_DIM: "abc" },
      });
      assert.equal(r.status.source, "cli-settings");
      assert.ok(Number.isFinite(r.provider!.dim));
      assert.equal(fields(r.provider).model, "embeddinggemma");
      assert.equal(fields(r.provider).keepAlive, keepAlive ? "10m" : undefined);
      if (keepAlive)
        assert.deepEqual(r.ollama, { baseURL: "http://localhost:11434", model: "embeddinggemma", keepAlive: "10m" });
    });
  });

  test(`${who}: an invalid env provider is reported and the file decides`, async () => {
    await withSettings({ embedding: { provider: "none" } }, async (path) => {
      const invalid: string[] = [];
      const r = await resolveEmbedding({
        keepAlive,
        onInvalidEnv: (raw) => invalid.push(raw),
        path,
        env: { BASTRA_EMBEDDING_PROVIDER: "olama" },
      });
      assert.deepEqual(invalid, ["olama"]);
      assert.equal(r.provider, null);
      assert.deepEqual(r.status, { on: false, providerId: null, source: "cli-settings" });
    });
  });

  test(`${who}: OpenAI only with an explicit choice and a key; a bare key stays off`, async () => {
    await withSettings(null, async (path) => {
      const base = { keepAlive, onInvalidEnv: () => {}, path };
      const cloud = await resolveEmbedding({
        ...base,
        env: { BASTRA_EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "k" },
      });
      assert.equal(cloud.status.on, true);
      assert.equal(cloud.status.providerId, cloud.provider!.id);
      assert.equal(cloud.ollama, undefined);
      const noKey = await resolveEmbedding({ ...base, env: { BASTRA_EMBEDDING_PROVIDER: "openai" } });
      assert.equal(noKey.provider, null);
      assert.equal(noKey.status.on, false);
      const bareKey = await resolveEmbedding({ ...base, env: { OPENAI_API_KEY: "k" } });
      assert.equal(bareKey.provider, null);
      assert.equal(bareKey.status.on, false);
    });
  });
}
