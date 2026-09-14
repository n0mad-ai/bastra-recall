/**
 * #520: cloud embeddings need an EXPLICIT Bastra choice — a generic
 * OPENAI_API_KEY in the environment is a credential, not consent.
 *
 * The proof is deliberately end-of-chain rather than a comparison of resolver
 * return values: the two steps that decide whether vault text goes on the wire
 * are `resolveEmbeddingChoice` (settings.ts) and `cloudEmbeddingProvider`
 * (embedding-cloud.ts, the ONE place index.ts and bridge.ts build the OpenAI
 * provider). Both run here against a stubbed global fetch, so "no request was
 * made" is an observation, not an assumption — and the positive case shows the
 * same wiring still POSTs when the user asked for it.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/embedding-cloud-consent.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveEmbeddingChoice, setEmbeddingProvider } from "../src/settings.js";
import { cloudEmbeddingProvider } from "../src/embedding-cloud.js";
import { cloudConsentNotice } from "../src/embedding-status.js";

async function withTempFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-cloud-consent-"));
  try {
    return await fn(join(dir, "cli-settings.json"));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

interface Captured {
  url: string;
  body: { model: string; input: string[] };
}

/** Runs `fn` with global fetch replaced by a recorder that answers like the
 *  embeddings endpoint — a real network call would fail the assertions here
 *  anyway, but the stub keeps the test hermetic. */
async function withFetchRecorder<T>(fn: (calls: Captured[]) => Promise<T>): Promise<T> {
  const calls: Captured[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Captured["body"];
    calls.push({ url: String(input), body });
    return new Response(
      JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: new Array(1536).fill(0) })) }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const VAULT_TEXT = "PRIVATE VAULT MEMORY — must never reach a third party";

test("#520: a generic OPENAI_API_KEY alone produces no embedding provider and no outbound request", async () => {
  await withTempFile(async (path) => {
    await withFetchRecorder(async (calls) => {
      for (const env of [
        { OPENAI_API_KEY: "sk-generic-from-another-devtool" },
        { BASTRA_EMBEDDING_KEY: "sk-generic-from-another-devtool" },
      ]) {
        const choice = await resolveEmbeddingChoice({ path, env });
        assert.equal(choice.provider, "none", "a bare key must leave recall on BM25");

        // The daemon's own construction step, not a re-implementation of it.
        const provider = cloudEmbeddingProvider(choice, env);
        assert.equal(provider, null, "no cloud provider may be built without an explicit choice");
      }
      assert.deepEqual(calls, [], "negative egress: not a single request left the process");
    });
  });
});

test("#520: the explicit provider choice still enables cloud embeddings and still sends the text", async () => {
  await withTempFile(async (path) => {
    await withFetchRecorder(async (calls) => {
      // (a) via the env var
      const viaEnv = await resolveEmbeddingChoice({
        path,
        env: { BASTRA_EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "sk-test" },
      });
      assert.deepEqual(viaEnv, { provider: "openai", source: "env" });

      // (b) via the persisted setting
      await setEmbeddingProvider("openai", path);
      const viaFile = await resolveEmbeddingChoice({ path, env: { OPENAI_API_KEY: "sk-test" } });
      assert.deepEqual(viaFile, { provider: "openai", source: "cli-settings" });

      const provider = cloudEmbeddingProvider(viaFile, { OPENAI_API_KEY: "sk-test" });
      assert.ok(provider, "an explicit choice must still build the OpenAI provider");
      await provider.embed([VAULT_TEXT]);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://api.openai.com/v1/embeddings");
      assert.deepEqual(calls[0].body.input, [VAULT_TEXT]);
    });
  });
});

test("#520: an existing key-fallback install gets a migration notice instead of a silent downgrade", async () => {
  const notice = cloudConsentNotice({ on: false, providerId: null, source: "api-key" });
  assert.ok(notice, "source 'api-key' must produce a visible notice");
  assert.match(notice, /#520/);
  assert.match(notice, /bastra config set embedding\.provider openai/, "it must name the explicit opt-in");
  assert.match(notice, /bastra embeddings on/, "and the local alternative");

  // Every other source is an actual decision — no notice, no noise.
  for (const source of ["env", "cli-settings", "none"] as const) {
    assert.equal(cloudConsentNotice({ on: false, providerId: null, source }), null);
  }
});
