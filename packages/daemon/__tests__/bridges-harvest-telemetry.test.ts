/**
 * #705 — `bastra bridges harvest` records its run as a `bridges_mint` event.
 *
 * Before, only the in-band mint (`runInBandMint`) emitted the event, and the
 * doctor's bridge note reads nothing else — a pool filled by the far harvest
 * reported "written 0". This drives the real CLI path against a fake Ollama
 * that picks the second candidate (a far rescue), so one bridge is written,
 * and checks both the event row and the doctor note built from it.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/bridges-harvest-telemetry.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { cmdBridges } from "../src/cli/bridges.js";
import { bridgeLearningLines, readMintRuns } from "../src/cli/bridges-note.js";

/** An Ollama with one chat model that always answers "2". */
async function pickingOllama(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url?.startsWith("/api/tags")) {
      res.end(JSON.stringify({ models: [{ name: "judge:1b" }] }));
      return;
    }
    req.resume();
    req.on("end", () => res.end(JSON.stringify({ message: { content: "2" } })));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function memory(id: string, title: string, summary: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: lesson",
    `summary: ${summary}`,
    "topic_path:",
    "  - ops",
    "tags:",
    "  - ops",
    "scope: personal",
    "recall_when:",
    `  - ${summary}`,
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    summary,
    "",
  ].join("\n");
}

test("harvest with a written bridge emits one bridges_mint event, and the doctor note counts it", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bht-logs-"));
  const vaultDir = await mkdtemp(join(tmpdir(), "bht-vault-"));
  const bridgesDir = await mkdtemp(join(tmpdir(), "bht-bridges-"));
  const ollama = await pickingOllama();
  const keys = ["BASTRA_LOG_PATH", "BASTRA_VAULT_PATH", "BASTRA_OLLAMA_URL", "BASTRA_BRIDGES_PATH", "BASTRA_EXPAND_MODEL"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    BASTRA_LOG_PATH: logDir,
    BASTRA_VAULT_PATH: vaultDir,
    BASTRA_OLLAMA_URL: ollama.url,
    BASTRA_BRIDGES_PATH: bridgesDir,
    BASTRA_EXPAND_MODEL: "judge:1b",
  });
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  try {
    await writeFile(join(vaultDir, "a.md"), memory("launchagent-modus", "LaunchAgent mode", "launchctl plist keepalive"), "utf8");
    await writeFile(join(vaultDir, "b.md"), memory("daemon-neustart", "Restart the service", "kickstart launchctl bootout reload"), "utf8");
    const today = new Date().toISOString().slice(0, 10);
    const poolEvent = {
      ts: new Date().toISOString(),
      kind: "recall",
      query: "wie starte ich den daemon neu",
      top_score: 12,
      candidate_pool: [
        { id: "launchagent-modus", score: 12 },
        { id: "daemon-neustart", score: 9 },
      ],
    };
    await writeFile(join(logDir, `events-${today}.jsonl`), JSON.stringify(poolEvent) + "\n", "utf8");

    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const rc = await cmdBridges({ sub: "harvest", positional: [] });
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    assert.equal(rc, 0);

    const langDirs = await readdir(join(bridgesDir, "bridges"));
    assert.ok(langDirs.length > 0, "the harvest wrote a bridge");

    const rows = (await readFile(join(logDir, `events-${today}.jsonl`), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.kind === "bridges_mint");
    assert.equal(rows.length, 1, "exactly one bridges_mint row per harvest run");
    assert.equal(rows[0].trigger, "cli-harvest", "the trigger tells the far harvest apart from the in-band mint");
    assert.equal(rows[0].written, 1);
    assert.equal(rows[0].minted, 1);
    assert.equal(rows[0].reaches, 1, "reaches = far cases judged");

    const now = new Date();
    const lines = bridgeLearningLines({ enabled: true, runs: await readMintRuns(logDir, null, now), now });
    assert.match(lines[0], /✓ ok: bridges learned .*last: 1 written/);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await ollama.close();
    await rm(logDir, { recursive: true, force: true });
    await rm(vaultDir, { recursive: true, force: true });
    await rm(bridgesDir, { recursive: true, force: true });
  }
});
