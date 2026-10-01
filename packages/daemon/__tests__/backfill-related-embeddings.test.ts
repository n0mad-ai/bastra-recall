/**
 * scripts/backfill-related.ts, Pass B.
 *
 * Two defects, one script:
 *
 *  1. `pickEmbeddingProvider` fell back to OpenAI whenever OPENAI_API_KEY was
 *     set — the fallback #520 removed from the daemon — so a stray credential
 *     sent every memory's text to api.openai.com. Cloud embeddings need
 *     BASTRA_EMBEDDING_PROVIDER=openai.
 *  2. Pass B waited only on `pendingSize()`, which is 0 as soon as start() takes
 *     the batch out of the queue. It printed "alle backfilled" and let
 *     RelatedEnricher drop related_via edges to neighbours whose vector had not
 *     landed. It now waits until every memory carries a vector and aborts with
 *     exit 1 when they do not.
 *
 * The script is spawned with a throwaway vault. The OpenAI case replaces fetch
 * with a recorder so a regression cannot reach the network.
 *
 * Run: npx tsx --test packages/daemon/__tests__/backfill-related-embeddings.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "backfill-related.ts");

function memory(id: string, title: string, related: string[] = []): string {
  return [
    "---",
    `id: ${id}`,
    `title: "${title}"`,
    "type: lesson",
    `summary: "${title} summary"`,
    "topic_path: [backfill]",
    "tags: [backfill]",
    "scope: all-projects",
    "recall_when:",
    `  - ${title}`,
    "related: []",
    `related_via: [${related.join(", ")}]`,
    "sensitivity: public",
    'source: "backfill test"',
    "confidence: 0.8",
    "created: 2026-01-01",
    "updated: 2026-01-01",
    "---",
    "",
    `${title} body`,
    "",
  ].join("\n");
}

function makeVault(files: Record<string, string>): string {
  const vault = mkdtempSync(join(tmpdir(), "bastra-backfill-"));
  mkdirSync(join(vault, "memories"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(vault, "memories", name), body);
  return vault;
}

interface Run { code: number | null; stderr: string }

function runScript(vault: string, env: Record<string, string | undefined>, preload?: string): Promise<Run> {
  return new Promise((done, fail) => {
    const base: Record<string, string | undefined> = {
      ...process.env,
      BASTRA_VAULT_PATH: vault,
      BASTRA_TELEMETRY: "off",
      BACKFILL_SKIP_WIKILINKS: "1",
      BASTRA_EMBEDDING_PROVIDER: undefined,
      OPENAI_API_KEY: undefined,
      BASTRA_EMBEDDING_KEY: undefined,
    };
    const args = ["--import", "tsx", ...(preload ? ["--import", preload] : []), SCRIPT];
    const child = spawn(process.execPath, args, { env: { ...base, ...env } as NodeJS.ProcessEnv });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error(`backfill-related timed out\n${stderr}`)); }, 90_000);
    child.on("close", (code) => { clearTimeout(timer); done({ code, stderr }); });
  });
}

// Replaces fetch before the script loads: any attempt to reach a network host
// is printed as `FETCH <url>` and refused.
const FETCH_RECORDER =
  "data:text/javascript," + encodeURIComponent('globalThis.fetch = async (u) => { console.error("FETCH " + u); throw new Error("blocked"); };');

test("a bare OPENAI_API_KEY is not consent to send vault text to OpenAI", async () => {
  const vault = makeVault({ "a.md": memory("a", "alpha lesson") });
  try {
    const res = await runScript(vault, { OPENAI_API_KEY: "sk-test-not-real" }, FETCH_RECORDER);
    assert.doesNotMatch(res.stderr, /FETCH https:\/\/api\.openai\.com/, `the script reached for OpenAI:\n${res.stderr}`);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /kein EmbeddingProvider verfügbar/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

async function withStubOllama<T>(refuse: string, body: (url: string) => Promise<T>): Promise<T> {
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const asked = (JSON.parse(raw || "{}") as { input?: string | string[] }).input ?? [];
      const input = Array.isArray(asked) ? asked : [asked];
      if (input.some((t) => t.includes(refuse))) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "refused" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ embeddings: input.map(() => [1, 0, 0, 0]) }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    return await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test("Pass B aborts and writes nothing when a memory never receives a vector", async () => {
  const vault = makeVault({
    "keep.md": memory("keep", "kept lesson", ["ghost"]),
    "poison.md": memory("poison", "POISONED lesson"),
  });
  const before = readFileSync(join(vault, "memories", "keep.md"), "utf8");
  try {
    await withStubOllama("POISONED", async (url) => {
      const res = await runScript(vault, {
        BASTRA_EMBEDDING_PROVIDER: "ollama",
        BASTRA_OLLAMA_URL: url,
        BASTRA_EMBEDDING_DIM: "4",
        BACKFILL_EMBED_WAIT_MS: "1500",
      });
      assert.equal(res.code, 1, `Pass B went on with a partial index:\n${res.stderr}`);
      assert.match(res.stderr, /Pass B: nur \d+\/2 Memories tragen einen Vektor/);
      assert.doesNotMatch(res.stderr, /alle backfilled/);
    });
    assert.equal(readFileSync(join(vault, "memories", "keep.md"), "utf8"), before, "an aborted Pass B rewrote a memory");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
