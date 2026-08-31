/**
 * #365/6 — `bastra bridges harvest` judges with the CONFIGURED generation model.
 *
 * The settings key covers both lanes by definition (settings.ts: "Generation
 * model … der Ollama chat model für doc2query + reranking"), and harvest reaches
 * the rerank lane through `harvestFarBridges` → `rerank()`. The daemon resolved
 * it correctly; this CLI did not — it read `BASTRA_RERANK_MODEL` and otherwise
 * fell back to `DEFAULT_RERANK_MODEL`, so a model persisted via
 * `bastra models set` was ignored. On a 24 GB box that persisted `gemma4:12b`,
 * harvest silently judged on `gemma3:4b` and, when that was not pulled, printed
 * `ollama pull gemma3:4b` — demanding a model the user had deliberately dropped.
 *
 * How this is pinned WITHOUT touching ~/.bastra: `resolveGenerationModel()` is
 * the only resolver that knows `BASTRA_EXPAND_MODEL`. The old code did not read
 * it, the fixed code does — so that env var is a faithful probe for "harvest
 * goes through the shared resolution", and no settings file has to be written.
 * The file arm of the precedence (generation.model) is already covered by
 * `generation-model.test.ts`.
 *
 * A fake Ollama on loopback advertises ZERO models, so `resolveRerankModel`
 * returns `model: null` and harvest reports which model it WANTED — the one
 * observable that carries `preferred`, reached without a single chat call.
 *
 * One honest caveat, pinned by the third case: this is NOT a strict superset of
 * the old behaviour. `BASTRA_RERANK_MODEL` alone still pins the judge exactly as
 * before, but when BOTH env vars are set, `BASTRA_EXPAND_MODEL` now outranks it
 * here (settings.ts precedence) where the old two-term expression never looked at
 * it at all. That collision is the one case that flips, and it flips towards
 * daemon parity — which is the whole point of the fix.
 *
 * Run: npx tsx --test packages/daemon/__tests__/bridges-harvest-model.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";

import { cmdBridges } from "../src/cli/bridges.js";

/** An Ollama that is up and has nothing pulled. */
async function emptyOllama(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith("/api/tags")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** One far case in the event log — enough for harvest to get past the empty-pool exit. */
async function seedPool(logDir: string): Promise<void> {
  const event = {
    ts: new Date().toISOString(),
    kind: "recall",
    query: "wie starte ich den daemon neu",
    top_score: 12,
    candidate_pool: [
      { id: "daemon-neustart", score: 12 },
      { id: "launchagent-modus", score: 9 },
    ],
  };
  await writeFile(join(logDir, "events-2026-08-23.jsonl"), JSON.stringify(event) + "\n", "utf8");
}

async function runHarvest(): Promise<{ rc: number; out: string }> {
  let captured = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => ((captured += c), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => ((captured += c), true)) as typeof process.stderr.write;
  try {
    const rc = await cmdBridges({ sub: "harvest", positional: [] });
    return { rc, out: captured };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

async function withHarvestEnv(
  env: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const logDir = await mkdtemp(join(tmpdir(), "bhm-logs-"));
  const vaultDir = await mkdtemp(join(tmpdir(), "bhm-vault-"));
  const ollama = await emptyOllama();
  await seedPool(logDir);
  const keys = [
    "BASTRA_LOG_PATH",
    "BASTRA_VAULT_PATH",
    "NEXUS_VAULT_PATH",
    "BASTRA_OLLAMA_URL",
    "BASTRA_EXPAND_MODEL",
    "BASTRA_RERANK_MODEL",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const applied: Record<string, string | undefined> = {
    BASTRA_LOG_PATH: logDir,
    BASTRA_VAULT_PATH: vaultDir,
    NEXUS_VAULT_PATH: undefined,
    BASTRA_OLLAMA_URL: ollama.url,
    BASTRA_EXPAND_MODEL: undefined,
    BASTRA_RERANK_MODEL: undefined,
    ...env,
  };
  for (const k of keys) {
    const v = applied[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const k of keys) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await ollama.close();
    await rm(logDir, { recursive: true, force: true });
    await rm(vaultDir, { recursive: true, force: true });
  }
}

test("harvest asks for the model the shared resolution picks, not the rerank default", async () => {
  await withHarvestEnv({ BASTRA_EXPAND_MODEL: "harvest-probe:12b" }, async () => {
    const { rc, out } = await runHarvest();
    assert.equal(rc, 1, "nothing usable installed → harvest reports failure instead of firing chat calls");
    assert.match(
      out,
      /harvest-probe:12b/,
      "harvest must resolve its judge through resolveGenerationModel() — the configured model, not DEFAULT_RERANK_MODEL",
    );
    assert.doesNotMatch(
      out,
      /gemma3:4b/,
      "the pull hint must never name a model the user configured away",
    );
  });
});

test("BASTRA_RERANK_MODEL on its own still pins the judge — no regress for existing users", async () => {
  await withHarvestEnv({ BASTRA_RERANK_MODEL: "pinned-by-env:7b" }, async () => {
    const { rc, out } = await runHarvest();
    assert.equal(rc, 1);
    assert.match(out, /pinned-by-env:7b/, "the existing env pin must keep working unchanged");
  });
});

test("both env vars set: BASTRA_EXPAND_MODEL outranks BASTRA_RERANK_MODEL, as it does in the daemon", async () => {
  await withHarvestEnv(
    { BASTRA_EXPAND_MODEL: "expand-wins:12b", BASTRA_RERANK_MODEL: "rerank-loses:7b" },
    async () => {
      const { rc, out } = await runHarvest();
      assert.equal(rc, 1);
      // The deliberate part of the change: the old expression read only
      // BASTRA_RERANK_MODEL, so this collision used to resolve the other way.
      assert.match(out, /expand-wins:12b/, "settings.ts precedence: BASTRA_EXPAND_MODEL first");
      assert.doesNotMatch(
        out,
        /rerank-loses:7b/,
        "the CLI must not diverge from the daemon on a collision the daemon already decides",
      );
    },
  );
});
