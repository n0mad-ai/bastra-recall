/**
 * #230's honesty flag has to reach the HOOK path, not only the MCP path.
 *
 * `isNoHome` is thoroughly unit-tested in weak-result-hook-path.test.ts — the
 * predicate was never the bug. The bug was delivery: `no_home` was computed in
 * tool-handlers.ts (MCP `recall`) and nowhere in http.ts, so `/hook/recall`
 * neither returned it nor recorded it. That is the path that writes
 * `<recall-hints>` into the agent's context on every Write/Edit, which is where
 * a "this vault has no memory of it" signal is worth the most — and
 * `docs/openapi.yaml` advertised the field on `RecallResponse` regardless.
 *
 * The shape of the miss is worth naming: commit ee80a56 (#249) exists solely to
 * fix this exact class for `weak_result`, and left a comment in http.ts saying
 * the flag "has to reach THIS path above all". The very next commit (81041fa,
 * #230) added a second flag beside it and repeated the omission. So this file
 * tests the wire, not the predicate.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/no-home-hook-path.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

import { Vault, SearchIndex, type RecallHit } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { startHttpServer } from "../src/http.js";

function memoryMarkdown(id: string, title: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: reference",
    `summary: ${title}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: no-home-test",
    "recall_when:",
    `  - ${title}`,
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `Body for ${title}.`,
    "",
  ].join("\n");
}

function httpPost(port: number, path: string, payload: unknown): Promise<{ status: number; body: string }> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * A hit that anchors nowhere — no recall_when match, no title term — so
 * isWeakResult fires. `rrf` decides no_home: one null rank = present in one arm
 * only = rank-1-of-nothing.
 */
function unanchoredHit(id: string, score: number, rrf: { rank_bm25: number | null; rank_vector: number | null }): RecallHit {
  return {
    id,
    title: "zzz unrelated heading",
    type: "reference",
    scope: "no-home-test",
    summary: "nothing to do with the query",
    score,
    matched_terms: [],
    matched_recall_when: false,
    rrf,
  } as unknown as RecallHit;
}

interface Daemon {
  port: number;
  search: SearchIndex;
  logDir: string;
  close: () => Promise<void>;
}

async function makeDaemon(): Promise<Daemon> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-nohome-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-nohome-logs-"));
  await writeFile(join(dir, "alpha.md"), memoryMarkdown("alpha", "alpha bravo"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();

  const prevLog = process.env.BASTRA_LOG_PATH;
  process.env.BASTRA_LOG_PATH = logDir;
  const telemetry = new Telemetry();
  if (prevLog === undefined) delete process.env.BASTRA_LOG_PATH;
  else process.env.BASTRA_LOG_PATH = prevLog;

  // The full hybrid path is a precondition for both flags: in BM25-only mode the
  // score is a real BM25 quantity and neither predicate fires by design.
  search.hasEmbeddings = (() => true) as SearchIndex["hasEmbeddings"];

  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    // #542: "test" isn't a member of EmbeddingSource ("env"|"cli-settings"|
    // "api-key"|"none") — this harness has no real source, so "none" is the
    // honest value (providerId stays a free-form test label).
    embedding: { on: true, providerId: "test", source: "none" },
  });

  return {
    port: handle.port!,
    search,
    logDir,
    close: async () => {
      search.stop();
      await vault.stop?.();
      await handle.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

/** Poll the log dir for the hook_recall row — write() is fire-and-forget. */
async function readHookRecallRow(logDir: string): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 40));
    let files: string[];
    try {
      files = await readdir(logDir);
    } catch {
      continue;
    }
    for (const f of files.filter((n) => n.startsWith("events-"))) {
      const raw = await readFile(join(logDir, f), "utf8");
      const line = raw.split("\n").filter((l) => l.includes('"hook_recall"')).pop();
      if (line) return JSON.parse(line) as Record<string, unknown>;
    }
  }
  return null;
}

test("#230: /hook/recall returns no_home when the top hit lives in one arm only", async () => {
  const d = await makeDaemon();
  try {
    d.search.recall = (() => [
      unanchoredHit("alpha", 158.9, { rank_bm25: 1, rank_vector: null }),
      unanchoredHit("beta", 40.2, { rank_bm25: 2, rank_vector: 9 }),
    ]) as SearchIndex["recall"];

    const res = await httpPost(d.port, "/hook/recall", { query: "arch firewall nftables" });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body) as { weak_result?: boolean; no_home?: boolean; hits: unknown[] };

    assert.equal(body.weak_result, true, "nothing anchored — weak_result is the outer claim");
    assert.equal(body.no_home, true, "the hook path must carry the stricter claim too, not just MCP");

    const row = await readHookRecallRow(d.logDir);
    assert.ok(row, "a hook_recall telemetry row should exist");
    assert.equal(row!.no_home, true, "#249's lesson: recorded, not merely returned — else stats read zero forever");
  } finally {
    await d.close();
  }
});

test("#230: a both-arms top hit is weak but NOT no_home — rank-1-of-wrong stays distinct", async () => {
  const d = await makeDaemon();
  try {
    d.search.recall = (() => [
      unanchoredHit("alpha", 158.9, { rank_bm25: 1, rank_vector: 4 }),
    ]) as SearchIndex["recall"];

    const res = await httpPost(d.port, "/hook/recall", { query: "arch firewall nftables" });
    const body = JSON.parse(res.body) as { weak_result?: boolean; no_home?: boolean };

    assert.equal(body.weak_result, true);
    assert.equal(body.no_home, undefined, "collapsing the two confidence levels would lose the distinction");
  } finally {
    await d.close();
  }
});

test("#230: an anchored hit is neither weak nor no_home on the hook path", async () => {
  const d = await makeDaemon();
  try {
    d.search.recall = (() => [
      {
        ...unanchoredHit("alpha", 120, { rank_bm25: 1, rank_vector: null }),
        matched_recall_when: true,
      } as unknown as RecallHit,
    ]) as SearchIndex["recall"];

    const res = await httpPost(d.port, "/hook/recall", { query: "alpha bravo" });
    const body = JSON.parse(res.body) as { weak_result?: boolean; no_home?: boolean };

    assert.equal(body.weak_result, undefined, "the author declared this trigger — that is a real anchor");
    assert.equal(body.no_home, undefined, "no_home is a strict subset; it cannot fire where weak_result does not");
  } finally {
    await d.close();
  }
});
