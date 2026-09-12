/**
 * Tests for resolveEmbeddingChoice (src/settings.ts) — the ONE shared
 * embedding-provider resolution used by index.ts, bridge.ts and the CLI (#79).
 *
 * Precedence under test: env BASTRA_EMBEDDING_PROVIDER > cli-settings.json
 * embedding.provider > none. Env + file are both injectable, so this never
 * reads the real environment or ~/.bastra.
 *
 * #520: a bare OPENAI_API_KEY is NOT a fourth tier. It never selects a cloud
 * provider on its own; it only colours the source so the CLI can explain why.
 *
 * Run: npx tsx --test packages/daemon/__tests__/embedding-resolve.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveEmbeddingChoice, setEmbeddingProvider, type EmbeddingProviderName } from "../src/settings.js";

async function withTempFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-embed-resolve-"));
  try {
    return await fn(join(dir, "cli-settings.json"));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("default: nothing configured anywhere → none via 'none'", async () => {
  await withTempFile(async (path) => {
    const c = await resolveEmbeddingChoice({ path, env: {} });
    assert.deepEqual(c, { provider: "none", source: "none" });
  });
});

test("cli-settings wins over the default (the #79 activation path)", async () => {
  await withTempFile(async (path) => {
    await setEmbeddingProvider("ollama", path);
    const c = await resolveEmbeddingChoice({ path, env: {} });
    assert.deepEqual(c, { provider: "ollama", source: "cli-settings" });
  });
});

test("env wins over cli-settings — both directions", async () => {
  await withTempFile(async (path) => {
    await setEmbeddingProvider("ollama", path);
    const off = await resolveEmbeddingChoice({ path, env: { BASTRA_EMBEDDING_PROVIDER: "none" } });
    assert.deepEqual(off, { provider: "none", source: "env" });

    await setEmbeddingProvider("none", path);
    const on = await resolveEmbeddingChoice({ path, env: { BASTRA_EMBEDDING_PROVIDER: "ollama" } });
    assert.deepEqual(on, { provider: "ollama", source: "env" });
  });
});

test("env value is case-insensitive", async () => {
  await withTempFile(async (path) => {
    const c = await resolveEmbeddingChoice({ path, env: { BASTRA_EMBEDDING_PROVIDER: "OLLAMA" } });
    assert.deepEqual(c, { provider: "ollama", source: "env" });
  });
});

test("invalid env value falls through to cli-settings and surfaces the typo", async () => {
  await withTempFile(async (path) => {
    await setEmbeddingProvider("ollama", path);
    let warned: string | null = null;
    const c = await resolveEmbeddingChoice({
      path,
      env: { BASTRA_EMBEDDING_PROVIDER: "olama" },
      onInvalidEnv: (raw) => (warned = raw),
    });
    // A typo must NOT silently disable embeddings and shadow a valid file choice.
    assert.deepEqual(c, { provider: "ollama", source: "cli-settings" });
    assert.equal(warned, "olama");
  });
});

test("openai via env: honoured with a key, degraded-but-explained without", async () => {
  await withTempFile(async (path) => {
    const withKey = await resolveEmbeddingChoice({
      path,
      env: { BASTRA_EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "sk-test" },
    });
    assert.deepEqual(withKey, { provider: "openai", source: "env" });

    const withoutKey = await resolveEmbeddingChoice({ path, env: { BASTRA_EMBEDDING_PROVIDER: "openai" } });
    // provider none, but `requested` keeps WHY, so status/doctor can explain.
    assert.deepEqual(withoutKey, { provider: "none", source: "env", requested: "openai" });
  });
});

test("openai via cli-settings without a key → none, requested preserved", async () => {
  await withTempFile(async (path) => {
    await setEmbeddingProvider("openai", path);
    const c = await resolveEmbeddingChoice({ path, env: {} });
    assert.deepEqual(c, { provider: "none", source: "cli-settings", requested: "openai" });
  });
});

test("#520: a bare API key with no explicit choice stays local (none), with the reason kept", async () => {
  await withTempFile(async (path) => {
    for (const env of [{ OPENAI_API_KEY: "sk-test" }, { BASTRA_EMBEDDING_KEY: "sk-test" }]) {
      const c = await resolveEmbeddingChoice({ path, env });
      // Was { provider: "openai", source: "api-key" } until #520: a credential
      // another tool exported is not consent to ship vault text to OpenAI.
      assert.deepEqual(c, { provider: "none", source: "api-key", requested: "openai" });
    }
  });
});

test("explicit file 'none' is reported as the file's own choice, not the key's", async () => {
  await withTempFile(async (path) => {
    await setEmbeddingProvider("none", path);
    const c = await resolveEmbeddingChoice({ path, env: { OPENAI_API_KEY: "sk-test" } });
    assert.deepEqual(c, { provider: "none", source: "cli-settings" });
  });
});

test("every stored provider name round-trips through the resolver", async () => {
  await withTempFile(async (path) => {
    const cases: [EmbeddingProviderName, EmbeddingProviderName][] = [
      ["ollama", "ollama"],
      ["none", "none"],
    ];
    for (const [stored, effective] of cases) {
      await setEmbeddingProvider(stored, path);
      const c = await resolveEmbeddingChoice({ path, env: {} });
      assert.equal(c.provider, effective);
      assert.equal(c.source, "cli-settings");
    }
  });
});
