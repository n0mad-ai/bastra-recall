/**
 * Tests for src/learned-recall/reranker.ts — prompt build + answer parse (no live model).
 *
 * Run: npx tsx --test packages/daemon/__tests__/learned-recall-reranker.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { assertLocalOrOptIn, buildRerankPrompt, DEFAULT_NUM_CTX, ollamaChat, parseRerankAnswer, rerank, resolveRerankModel, type RerankCandidate } from "../src/learned-recall/reranker.js";

const CANDS: RerankCandidate[] = [
  { id: "a", text: "css flexbox note" },
  { id: "b", text: "NSPanel resignKey observer" },
  { id: "c", text: "ollama cpu load" },
];

test("buildRerankPrompt numbers candidates and includes the query", () => {
  const p = buildRerankPrompt("warum schließt das Panel", CANDS);
  assert.ok(p.includes('"warum schließt das Panel"'));
  assert.ok(p.includes("1. css flexbox note"));
  assert.ok(p.includes("2. NSPanel resignKey observer"));
  assert.ok(p.includes("3. ollama cpu load"));
  assert.ok(/number \(1-3\)/.test(p));
});

test("parseRerankAnswer extracts a valid 1-based index", () => {
  assert.equal(parseRerankAnswer("2", 3), 2);
  assert.equal(parseRerankAnswer("The best is 3.", 3), 3);
  assert.equal(parseRerankAnswer("Answer: 1", 3), 1);
});

test("parseRerankAnswer returns null for 0, out-of-range, or no number", () => {
  assert.equal(parseRerankAnswer("0", 3), null);
  assert.equal(parseRerankAnswer("none fit", 3), null);
  assert.equal(parseRerankAnswer("5", 3), null);
  assert.equal(parseRerankAnswer("", 3), null);
});

test("rerank returns the chosen id and its 1-based rank", async () => {
  const r = await rerank("q", CANDS, async () => "2");
  assert.equal(r.bestId, "b");
  assert.equal(r.chosenRank, 2);
});

test("rerank returns null bestId when the model picks none", async () => {
  const r = await rerank("q", CANDS, async () => "0");
  assert.equal(r.bestId, null);
  assert.equal(r.chosenRank, null);
});

test("rerank handles an empty candidate list without calling the model", async () => {
  let called = 0;
  const r = await rerank("q", [], async () => { called++; return "1"; });
  assert.equal(called, 0);
  assert.equal(r.bestId, null);
});

test("resolveRerankModel: exact tag installed → used, no fallback", () => {
  const c = resolveRerankModel(["gemma3:4b", "qwen2.5:7b"], "gemma3:4b");
  assert.equal(c.model, "gemma3:4b");
  assert.equal(c.fellBack, false);
});

test("resolveRerankModel: same family, different tag → that tag, fellBack", () => {
  const c = resolveRerankModel(["gemma3:12b", "nomic-embed-text:latest"], "gemma3:4b");
  assert.equal(c.model, "gemma3:12b");
  assert.equal(c.fellBack, true);
});

test("resolveRerankModel: preferred absent → first non-embedding chat model, fellBack", () => {
  const c = resolveRerankModel(["nomic-embed-text:latest", "qwen2.5:7b"], "gemma3:4b");
  assert.equal(c.model, "qwen2.5:7b");
  assert.equal(c.fellBack, true);
});

test("resolveRerankModel: only embedding models installed → null (tell user to pull)", () => {
  const c = resolveRerankModel(["nomic-embed-text:latest", "mxbai-embed-large:latest"], "gemma3:4b");
  assert.equal(c.model, null);
  assert.equal(c.fellBack, false);
});

test("resolveRerankModel: nothing installed → null", () => {
  const c = resolveRerankModel([], "gemma3:4b");
  assert.equal(c.model, null);
  assert.equal(c.fellBack, false);
});

test("assertLocalOrOptIn allows loopback endpoints", () => {
  for (const u of ["http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434"]) {
    assert.doesNotThrow(() => assertLocalOrOptIn(u), `${u} should be allowed`);
  }
});

test("assertLocalOrOptIn refuses a non-loopback endpoint unless opted in", () => {
  const prev = process.env.BASTRA_ALLOW_REMOTE_OLLAMA;
  delete process.env.BASTRA_ALLOW_REMOTE_OLLAMA;
  try {
    assert.throws(() => assertLocalOrOptIn("http://10.0.0.5:11434"), /non-loopback/);
    process.env.BASTRA_ALLOW_REMOTE_OLLAMA = "1";
    assert.doesNotThrow(() => assertLocalOrOptIn("http://10.0.0.5:11434"));
  } finally {
    if (prev === undefined) delete process.env.BASTRA_ALLOW_REMOTE_OLLAMA;
    else process.env.BASTRA_ALLOW_REMOTE_OLLAMA = prev;
  }
});

test("assertLocalOrOptIn lets a malformed URL through (fetch reports it, behaviour unchanged)", () => {
  assert.doesNotThrow(() => assertLocalOrOptIn("not a url"));
});

/** Capture the request body ollamaChat sends, without a live Ollama. */
async function captureChatBody(
  opts: Parameters<typeof ollamaChat>[0],
): Promise<Record<string, unknown>> {
  const real = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    body = JSON.parse(init.body) as Record<string, unknown>;
    return { ok: true, json: async () => ({ message: { content: "1" } }) };
  }) as unknown as typeof fetch;
  try {
    await ollamaChat(opts)("prompt");
  } finally {
    globalThis.fetch = real;
  }
  return body;
}

test("ollamaChat sends think:false and an explicit num_ctx (#366, #367)", async () => {
  // think:false — a thinking model otherwise answers into `message.thinking`
  // and returns empty content. num_ctx — without it Ollama sizes the context
  // from the model and a stock tag loads at its full training context.
  const body = await captureChatBody({});
  assert.equal(body.think, false);
  assert.deepEqual(body.options, { temperature: 0, num_ctx: DEFAULT_NUM_CTX });
  assert.equal(DEFAULT_NUM_CTX, 4096);
});

test("ollamaChat: numCtx is overridable per call (the /ui/chat copilot needs 8192)", async () => {
  const body = await captureChatBody({ numCtx: 8192 });
  assert.deepEqual(body.options, { temperature: 0, num_ctx: 8192 });
});

test("ollamaChat: BASTRA_OLLAMA_NUM_CTX overrides the default but not an explicit numCtx", async () => {
  const prev = process.env.BASTRA_OLLAMA_NUM_CTX;
  process.env.BASTRA_OLLAMA_NUM_CTX = "2048";
  try {
    assert.deepEqual((await captureChatBody({})).options, { temperature: 0, num_ctx: 2048 });
    assert.deepEqual((await captureChatBody({ numCtx: 8192 })).options, { temperature: 0, num_ctx: 8192 });
    process.env.BASTRA_OLLAMA_NUM_CTX = "nonsense";
    assert.deepEqual((await captureChatBody({})).options, { temperature: 0, num_ctx: DEFAULT_NUM_CTX });
  } finally {
    if (prev === undefined) delete process.env.BASTRA_OLLAMA_NUM_CTX;
    else process.env.BASTRA_OLLAMA_NUM_CTX = prev;
  }
});

test("ollamaChat: a non-positive BASTRA_OLLAMA_NUM_CTX falls back to the default", async () => {
  const prev = process.env.BASTRA_OLLAMA_NUM_CTX;
  try {
    for (const bad of ["0", "-1", ""]) {
      process.env.BASTRA_OLLAMA_NUM_CTX = bad;
      assert.deepEqual(
        (await captureChatBody({})).options,
        { temperature: 0, num_ctx: DEFAULT_NUM_CTX },
        `"${bad}" must not become the context size`,
      );
    }
  } finally {
    if (prev === undefined) delete process.env.BASTRA_OLLAMA_NUM_CTX;
    else process.env.BASTRA_OLLAMA_NUM_CTX = prev;
  }
});

test("ollamaChat returns \"\" for a thinking model's wire shape (#367)", async () => {
  // The exact response gemma4:12b produced: the whole answer in `thinking`,
  // `content` empty. The client must surface that as "" so the expander's
  // empty-generation guard sees it — not throw, and not dig the thinking out.
  const real = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      message: { role: "assistant", thinking: "*   Topic: A cat.\n    *   Constraint 1:", content: "" },
      done_reason: "length",
    }),
  })) as unknown as typeof fetch;
  try {
    assert.equal(await ollamaChat({})("prompt"), "");
  } finally {
    globalThis.fetch = real;
  }
});
