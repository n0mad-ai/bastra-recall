/**
 * The hook path reports a deadline degradation honestly (#342, over #302).
 *
 * The core-side deadline is covered in packages/core/__tests__/vector-arm-deadline.test.ts.
 * What this pins is the wiring on the surface that actually has a budget — and
 * specifically the coupling that is easy to get wrong:
 *
 * `unfused` tells the formatter that no RRF ran, so the 30/100 bands describe
 * nothing and the wording must not claim strength (#302 measured raw BM25 top
 * hits into six digits). It was derived from the embedding breaker alone. A
 * deadline expiry produces exactly the same one-armed, unbounded score space
 * through a different door — so leaving `unfused` off would make every timed-out
 * recall label raw BM25 scores with fusion bands. That is the #302 defect
 * reappearing, and this test is where it should fail first.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/hook-vector-deadline.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Vault, SearchIndex, EmbeddingIndex, type EmbeddingProvider } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function memoryMarkdown(id: string): string {
  return [
    "---",
    `id: ${id}`,
    `title: ${id} ANCHORWORD`,
    "type: lesson",
    "summary: ANCHORWORD summary",
    "topic_path: [t]",
    "tags: [t]",
    "scope: t",
    'recall_when: ["ANCHORWORD"]',
    "created: 2026-01-01",
    "updated: 2026-07-01",
    "---",
    "",
    `Body ANCHORWORD ${id}.`,
    "",
  ].join("\n");
}

class SlowProvider implements EmbeddingProvider {
  readonly id = "slow-mock";
  readonly dim = 3;
  public delayMs = 0;
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.delayMs > 0) await sleep(this.delayMs);
    return texts.map(() => new Float32Array([1, 0, 0]));
  }
}

function hookRecall(
  port: number,
  query: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ query, k: 3, tool_name: "Write", session_id: "deadline-test", ...extra });
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/hook/recall",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body || "{}") }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function fixture(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-hook-deadline-"));
  const folder = join(dir, "memories");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "a1.md"), memoryMarkdown("a1"));
  await writeFile(join(folder, "a2.md"), memoryMarkdown("a2"));

  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const provider = new SlowProvider();
  const emb = new EmbeddingIndex(vault, provider, join(dir, ".bastra", "embeddings.json"));
  await emb.start();
  search.useEmbeddings(emb);
  const telemetry = new Telemetry();

  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: true, providerId: "slow-mock", source: "env" },
  });

  const previousDeadline = process.env.BASTRA_VECTOR_DEADLINE_MS;
  t.after(async () => {
    if (previousDeadline === undefined) delete process.env.BASTRA_VECTOR_DEADLINE_MS;
    else process.env.BASTRA_VECTOR_DEADLINE_MS = previousDeadline;
    await handle.close();
    await emb.stop();
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  return { port: handle.port!, provider };
}

test("#342: a dense arm past its deadline returns hits, names the reason, and marks them unfused", async (t) => {
  const { port, provider } = await fixture(t);
  provider.delayMs = 400;
  process.env.BASTRA_VECTOR_DEADLINE_MS = "40";

  const started = Date.now();
  const { status, body } = await hookRecall(port, "ANCHORWORD");
  const elapsed = Date.now() - started;

  assert.equal(status, 200);
  assert.ok(
    Array.isArray(body.hits) && (body.hits as unknown[]).length > 0,
    "the cheap arm's answer is served rather than the call expiring silently",
  );
  assert.ok(elapsed < 350, `returned on the deadline, not the dense arm (${elapsed}ms against a 400ms arm)`);
  assert.equal(body.degraded, "vector-arm-timeout", "the reason travels on the wire");
  assert.equal(
    body.unfused,
    true,
    "no RRF ran, so the bands do not apply — leaving this off revives the #302 defect",
  );
  // P0: `unfused` sagt es indirekt, über eine Abwesenheit. `score_kind` sagt es
  // direkt — ein Konsument soll den Score-Raum lesen können, statt ihn aus der
  // Höhe der Zahl zu erraten. Genau dieses Raten war der Incident.
  assert.equal(body.score_kind, "bm25", "the raw, unbounded scale must name itself");
});

test("#342: a warm dense arm reports neither flag", async (t) => {
  const { port, provider } = await fixture(t);
  provider.delayMs = 0;
  process.env.BASTRA_VECTOR_DEADLINE_MS = "400";

  const { status, body } = await hookRecall(port, "ANCHORWORD");

  assert.equal(status, 200);
  assert.ok(Array.isArray(body.hits) && (body.hits as unknown[]).length > 0);
  assert.equal(body.degraded, undefined, "nothing degraded, so nothing to report");
  assert.equal(body.unfused, undefined, "fusion ran; the bands mean what they say");
  assert.equal(body.score_kind, "rrf", "and the fused scale names itself too — always present");
});

test("#342: the deadline is read per call, so the kill switch needs no restart", async (t) => {
  const { port, provider } = await fixture(t);
  provider.delayMs = 150;

  process.env.BASTRA_VECTOR_DEADLINE_MS = "30";
  const cut = await hookRecall(port, "ANCHORWORD");
  assert.equal(cut.body.degraded, "vector-arm-timeout", "precondition: the deadline bites");

  // Same server, same slow arm — only the env changed.
  process.env.BASTRA_VECTOR_DEADLINE_MS = "0";
  const waited = await hookRecall(port, "ANCHORWORD");
  assert.equal(
    waited.body.degraded,
    undefined,
    "0 restores the pre-#342 wait without a daemon restart",
  );
});

test("20.08.: a caller's vector_deadline_ms widens the dense arm past the hook default", async (t) => {
  const { port, provider } = await fixture(t);
  provider.delayMs = 150;
  process.env.BASTRA_VECTOR_DEADLINE_MS = "30";

  const cut = await hookRecall(port, "ANCHORWORD");
  assert.equal(cut.body.degraded, "vector-arm-timeout", "precondition: the hook default bites");

  // The MCP forwarder's shape: a waiting model, not a 600ms hook budget.
  const waited = await hookRecall(port, "ANCHORWORD", { vector_deadline_ms: 1500 });
  assert.equal(waited.body.degraded, undefined, "the model-triggered recall gets the fused answer");
  assert.equal(waited.body.unfused, undefined, "fusion ran; the bands mean what they say");

  // Garbage in the body falls back to the env default — never disables the deadline.
  const junk = await hookRecall(port, "ANCHORWORD", { vector_deadline_ms: "forever" });
  assert.equal(junk.body.degraded, "vector-arm-timeout", "a non-number keeps the hook default");
});
