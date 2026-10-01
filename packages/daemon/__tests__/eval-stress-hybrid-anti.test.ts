/**
 * The anti-hallucination slice under --hybrid.
 *
 * core/src/search.ts: a one-armed rank-1 hit scores RRF_SCALE/(RRF_K+1)
 * (~81.97) by construction, and the dense arm has no similarity floor — so
 * under --hybrid every query returns a hit at or above that score. The default
 * cutoff (80) is in BM25 units, `median < cutoff` is unreachable, and a
 * --hybrid run always ended FAIL on this slice alone. With a cutoff at or below
 * the floor the slice is reported as not evaluable and does not gate the verdict.
 *
 * A stub Ollama serves the dense leg, so no model is needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RRF_K, RRF_SCALE } from "@bastra-recall/core";
import { RRF_ONE_ARMED_FLOOR, antiNotEvaluableUnderHybrid } from "../scripts/stress-arm.js";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "eval-stress.ts");
const FIXTURE_VAULT = resolve(import.meta.dirname, "..", "..", "eval", "fixtures", "eval-vault");

test("the floor is the one-armed RRF score, and only hybrid runs at or below it are not evaluable", () => {
  assert.equal(RRF_ONE_ARMED_FLOOR, RRF_SCALE / (RRF_K + 1));
  assert.equal(antiNotEvaluableUnderHybrid(true, 80), true, "the default cutoff sits below the floor");
  assert.equal(antiNotEvaluableUnderHybrid(true, Math.ceil(RRF_ONE_ARMED_FLOOR) + 1), false);
  assert.equal(antiNotEvaluableUnderHybrid(false, 80), false, "BM25-only keeps gating on the slice");
});

async function runHybridAnti(args: string[]): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const input = (JSON.parse(body) as { input: string[] }).input;
      // Deterministic 8-d vectors from the text; every query gets a neighbour.
      const vec = (t: string): number[] =>
        Array.from({ length: 8 }, (_, i) => 1 + ((t.length * (i + 3) + t.charCodeAt(i % Math.max(1, t.length))) % 7));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ embeddings: input.map(vec) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const runsDir = mkdtempSync(join(tmpdir(), "bastra-stress-hybrid-runs-"));
  try {
    const port = (server.address() as AddressInfo).port;
    return await new Promise<string>((resolveOut, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, "--slice", "anti", "--hybrid", ...args], {
        env: {
          ...process.env,
          BASTRA_VAULT_PATH: FIXTURE_VAULT,
          BASTRA_EVAL_RUNS_DIR: runsDir,
          BASTRA_OLLAMA_URL: `http://127.0.0.1:${port}`,
          BASTRA_EMBEDDING_DIM: "8",
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
  } finally {
    server.close();
    rmSync(runsDir, { recursive: true, force: true });
  }
}

test("a --hybrid anti run at the default cutoff says it is not evaluable instead of FAIL on a number it cannot beat", async () => {
  const out = await runHybridAnti([]);
  assert.match(out, /Provider: \*\*[^*]*\*\*/, out);
  assert.doesNotMatch(out, /Provider: \*\*BM25-only\*\*/, "the hybrid arm must really be built for this test to mean anything");
  assert.match(out, /not evaluable under --hybrid/, out);
  assert.match(out, /Verdict: \*\*NOT EVALUABLE\*\*/, out);
  assert.doesNotMatch(out, /Verdict: \*\*FAIL\*\*/, out);
});
