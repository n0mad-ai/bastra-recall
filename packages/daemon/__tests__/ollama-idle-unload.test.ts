/**
 * #701: the idle unload must not load a cold model.
 *
 * `unloadOllamaModel` posted `/api/embed` with an empty input and
 * `keep_alive: 0`. Ollama's embed handler schedules the runner before it looks
 * at the input, so on a model Ollama had already evicted the "unload" loaded
 * it (14–18 s in the report) and the 10 s abort left that load running.
 *
 * The stub is an Ollama that records every request; no real Ollama is asked.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/ollama-idle-unload.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { unloadOllamaModel } from "../src/ollama-lifecycle.js";

interface Seen {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

/** An Ollama with `running` in memory; `psStatus` other than 200 breaks /api/ps. */
async function stubOllama(running: string[], psStatus = 200): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url: req.url ?? "", body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/api/ps") {
        res.writeHead(psStatus).end(JSON.stringify({ models: running.map((name) => ({ name, model: name })) }));
      } else if (req.method === "POST" && req.url === "/api/generate") {
        res.writeHead(200).end(JSON.stringify({ model: "m", response: "", done: true, done_reason: "unload" }));
      } else {
        res.writeHead(404).end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const posts = (seen: Seen[]): Seen[] => seen.filter((s) => s.method === "POST");

test("a model Ollama already evicted counts as unloaded — and gets no request that would load it", async () => {
  const ollama = await stubOllama(["llama3.2:latest"]);
  try {
    assert.equal(await unloadOllamaModel(ollama.url, "bge-m3"), true);
    assert.deepEqual(posts(ollama.seen), [], "nothing is posted for a model that is not in memory");
    assert.deepEqual(ollama.seen.map((s) => `${s.method} ${s.url}`), ["GET /api/ps"]);
  } finally {
    await ollama.close();
  }
});

test("a loaded model is unloaded the documented way: /api/generate with keep_alive 0 and no prompt", async () => {
  const ollama = await stubOllama(["bge-m3:latest"]);
  try {
    // The configured name carries no tag; /api/ps always lists `model:tag`.
    assert.equal(await unloadOllamaModel(`${ollama.url}/`, "bge-m3"), true);
    assert.deepEqual(posts(ollama.seen), [{ method: "POST", url: "/api/generate", body: { model: "bge-m3", keep_alive: 0 } }]);
  } finally {
    await ollama.close();
  }
});

test("a tagged model matches its own tag only", async () => {
  const ollama = await stubOllama(["nomic-embed-text:v1.5"]);
  try {
    assert.equal(await unloadOllamaModel(ollama.url, "nomic-embed-text"), true);
    assert.deepEqual(posts(ollama.seen), [], "`nomic-embed-text` is `:latest`, which is not loaded");
    assert.equal(await unloadOllamaModel(ollama.url, "Nomic-Embed-Text:v1.5"), true);
    assert.equal(posts(ollama.seen).length, 1);
  } finally {
    await ollama.close();
  }
});

test("when /api/ps cannot say what is loaded, nothing is posted and the unload reports failure", async () => {
  const ollama = await stubOllama(["bge-m3:latest"], 500);
  try {
    assert.equal(await unloadOllamaModel(ollama.url, "bge-m3"), false);
    assert.deepEqual(posts(ollama.seen), []);
  } finally {
    await ollama.close();
  }
  // Ollama not running at all: the port above is closed now.
  assert.equal(await unloadOllamaModel(ollama.url, "bge-m3"), false);
});
