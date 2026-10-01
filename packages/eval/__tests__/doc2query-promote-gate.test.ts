import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Doc2query-lift must not print PROMOTE under its own DATA-STARVED
 * warning.
 *
 * The vault is built so that, with n=1 on both the NEAR and the OOP slice,
 * the three lift conditions (own shows lift, near-regression within the null,
 * own beats foreign) all hold by construction. Before the fix `promote` was
 * built from those alone and printed ">>> PROMOTE <<<" directly under
 * "DATA-STARVED ... treat the number as noise". A stub Ollama serves
 * hand-made 4-d vectors so no model is needed:
 *   - the dense leg ranks the gold of the far query LAST (it is out of pool
 *     in the off arm) and only the paraphrase field (BM25) can lift it;
 *   - the second memory is a NEAR case in every arm via its title.
 *
 * Runner: `tsx --test __tests__/doc2query-promote-gate.test.ts`
 */
const SCRIPT = resolve(import.meta.dirname, "..", "src", "doc2query-lift.ts");

const mem = (id: string, title: string, phrases: string[], expanded: string[]): string =>
  [
    "---",
    `id: ${id}`,
    `title: "${title}"`,
    "type: lesson",
    `summary: "a note about ${id}"`,
    "topic_path: [t]",
    "tags: [x]",
    "scope: all-projects",
    "recall_when:",
    ...phrases.map((p) => `  - ${p}`),
    ...(expanded.length ? ["recall_when_expanded:", ...expanded.map((p) => `  - ${p}`)] : []),
    "related: []",
    "related_via: []",
    "sensitivity: public",
    'source: "test"',
    "confidence: 0.8",
    "---",
    "",
    `body of ${id}`,
    "",
  ].join("\n");

// 4-d: [zebrafish, marmalade, bias, alpha-doc]
const vec = (text: string): number[] => {
  const t = text.toLowerCase();
  if (t.includes("alpha-note")) return [0, 0, 0, 1]; // far gold: orthogonal to the far query
  return [t.includes("zebrafish") ? 1 : 0, t.includes("marmalade") ? 1 : 0, 1, 0];
};

test("a run with DATA-STARVED slices prints DO NOT PROMOTE even when the lift conditions hold", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bastra-d2q-gate-"));
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const input = (JSON.parse(body) as { input: string[] }).input;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ embeddings: input.map(vec) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const vault = join(dir, "vault");
    mkdirSync(join(vault, "memories"), { recursive: true });
    const put = (id: string, text: string): void => writeFileSync(join(vault, "memories", `${id}.md`), text);
    put("alpha-note", mem("alpha-note", "Alpha-note", ["alpha first trigger", "zebrafish"], ["zebrafish migration paraphrase"]));
    put("bravo-note", mem("bravo-note", "Marmalade bravo-note", ["bravo first trigger", "marmalade"], ["bravo paraphrase"]));
    for (let i = 0; i < 30; i++) put(`filler-${String(i).padStart(2, "0")}`, mem(`filler-${String(i).padStart(2, "0")}`, `Filler ${i}`, [], []));

    const port = (server.address() as AddressInfo).port;
    const out = await new Promise<string>((resolveOut, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, "--full"], {
        env: {
          ...process.env,
          BASTRA_VAULT_PATH: vault,
          BASTRA_OLLAMA_URL: `http://127.0.0.1:${port}`,
          BASTRA_EMBEDDING_DIM: "4",
          HOME: dir,
        },
      });
      let buf = "";
      child.stdout.on("data", (c) => (buf += c));
      child.stderr.on("data", (c) => (buf += c));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`timeout; output so far:\n${buf}`));
      }, 100_000);
      child.on("close", () => {
        clearTimeout(timer);
        resolveOut(buf);
      });
    });
    assert.match(out, /DATA-STARVED/, out);
    assert.match(out, /own shows OOP lift\s*: yes/, out);
    assert.match(out, /DO NOT PROMOTE/, out);
    assert.doesNotMatch(out, />>> PROMOTE <<</, out);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
