/**
 * #1128-capture — the text-free additions to the event log: note state and
 * per-arm rank on the candidate pool, the recall that served a load, the
 * measurement-run flag, and the reranker's verdict.
 *
 * Invented data in temp directories and stub models only. Remove this file
 * together with src/training-signal.ts.
 *
 * Runner: `node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/training-signal.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, EmbeddingIndex, type EmbeddingProvider, type RecallHit } from "@bastra-recall/core";
import { recallHandler, loadMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";
import { Telemetry } from "../src/telemetry.js";
import { writeDraftEvent } from "../src/draft-events.js";
import { harvestFarBridges, type MemoryInfo } from "../src/learned-recall/harvest.js";
import { evalRunMark, noteContentHash, recordRerankVerdicts, telemetryCandidatePool, type RerankVerdict } from "../src/training-signal.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const BODY = "Synthetic body about the flux compensator calibration bench.";

function memoryMd(id: string, trigger: string, body: string, sensitivity = "team"): string {
  return ["---", `id: ${id}`, `title: ${id} ${trigger}`, "type: lesson", `summary: ${trigger} summary`, "topic_path:", "  - test", "tags:", "  - test",
    "scope: test", "recall_when:", `  - ${trigger}`, `sensitivity: ${sensitivity}`, "created: 2026-10-01", "updated: 2026-10-01", "---", "", body, ""].join("\n");
}
async function withEnv(env: Record<string, string | undefined>, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-training-signal-"));
  const all: Record<string, string | undefined> = { BASTRA_LOG_PATH: join(dir, "logs"), BASTRA_TELEMETRY: "1", BASTRA_EVAL_RUN: undefined, ...env };
  const previous = new Map(Object.keys(all).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(all)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { await fn(dir); } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
async function rows(dir: string): Promise<Record<string, any>[]> {
  const names = (await readdir(join(dir, "logs")).catch(() => [] as string[])).filter((name) => name.startsWith("events-"));
  const out: Record<string, any>[] = [];
  for (const name of names) for (const line of (await readFile(join(dir, "logs", name), "utf8")).split("\n")) if (line) out.push(JSON.parse(line));
  return out;
}
async function fixtureVault(dir: string): Promise<{ vault: Vault; search: SearchIndex; root: string }> {
  const root = join(dir, "vault");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root);
  await writeFile(join(root, "flux.md"), memoryMd("flux-note", "flux compensator drift tuning", BODY));
  await writeFile(join(root, "garden.md"), memoryMd("garden-note", "tomato bed watering plan", "Synthetic body about the vegetable garden."));
  const vault = new Vault(root); await vault.init();
  const search = new SearchIndex(vault); search.start();
  return { vault, search, root };
}

// ─── D: candidate pool ───────────────────────────────────────────────────────

test("D — a recall's candidate pool names the note's content hash, and still no text", () => withEnv({}, async (dir) => {
  const { vault, search, root } = await fixtureVault(dir);
  try {
    const telemetry = new Telemetry();
    const deps: ToolDeps = { vault, search, telemetry, vaultPath: root };
    await recallHandler(deps, { query: "flux compensator drift tuning", k: 5 });
    await sleep(30);
    const recall = (await rows(dir)).find((row) => row.kind === "recall")!;
    const candidate = recall.candidate_pool.find((c: { id: string }) => c.id === "flux-note");
    assert.match(candidate.content_hash, /^[a-f0-9]{16}$/);
    assert.equal(candidate.content_hash, noteContentHash(vault.get("flux-note")!));
    assert.equal(typeof candidate.score, "number");
    assert.ok(!("rank_bm25" in candidate), "no per-arm rank on a recall that did not run the hybrid path");
    assert.doesNotMatch(JSON.stringify(recall.candidate_pool), /calibration bench|summary/);
  } finally { search.stop(); await vault.stop(); }
}));

test("D — on the hybrid path each candidate carries its rank in the keyword and the vector arm", () => withEnv({ BASTRA_QUERY_ROUTER: "shadow" }, async (dir) => {
  const { vault, search, root } = await fixtureVault(dir);
  const provider: EmbeddingProvider = { id: "ollama-fixture", dim: 2, async embed(texts) { return texts.map((text) => new Float32Array(/garden|tomato/.test(text) ? [0, 1] : [1, 0])); } };
  const emb = new EmbeddingIndex(vault, provider, join(root, ".bastra", "embeddings.json"));
  try {
    await emb.start();
    search.useEmbeddings(emb);
    const telemetry = new Telemetry();
    await recallHandler({ vault, search, telemetry, vaultPath: root }, { query: "flux compensator drift tuning", k: 5 });
    await sleep(30);
    const recall = (await rows(dir)).find((row) => row.kind === "recall")!;
    assert.equal(recall.candidate_pool_score_kind, "rrf");
    const flux = recall.candidate_pool.find((c: { id: string }) => c.id === "flux-note");
    assert.equal(flux.rank_bm25, 1); assert.equal(flux.rank_vector, 1);
    const gardenHit = recall.candidate_pool.find((c: { id: string }) => c.id === "garden-note");
    assert.ok(gardenHit, "the vector arm alone put it in the pool"); assert.equal(gardenHit.rank_bm25, null, "the keyword arm did not carry it"); assert.equal(gardenHit.rank_vector, 2);
  } finally { await emb.stop(); search.stop(); await vault.stop(); }
}));

test("D — the hash follows the note's content, and a private note gets none", () => withEnv({}, async (dir) => {
  const { vault, search, root } = await fixtureVault(dir);
  try {
    const before = noteContentHash(vault.get("flux-note")!);
    await writeFile(join(root, "flux.md"), memoryMd("flux-note", "flux compensator drift tuning", BODY + " Revised."));
    await writeFile(join(root, "secret.md"), memoryMd("secret-note", "payroll ledger", "Synthetic private body.", "private"));
    await vault.reconcile();
    assert.notEqual(noteContentHash(vault.get("flux-note")!), before);
    const hit = (id: string, rrf?: RecallHit["rrf"]): RecallHit => ({ id, title: "", type: "lesson", scope: "test", summary: "", topic_path: [], score: 7, matched_terms: [], ...(rrf ? { rrf } : {}) });
    const pool = telemetryCandidatePool([hit("flux-note", { rank_bm25: 3, rank_vector: null, raw: 0.1 }), hit("secret-note"), hit("gone")], vault);
    assert.deepEqual(pool[0], { id: "flux-note", score: 7, rank_bm25: 3, rank_vector: null, content_hash: noteContentHash(vault.get("flux-note")!) });
    assert.deepEqual(pool[1], { id: "secret-note", score: 7 });
    assert.deepEqual(pool[2], { id: "gone", score: 7 });
  } finally { search.stop(); await vault.stop(); }
}));

// ─── E: the recall that served a load ────────────────────────────────────────

test("E — load_memory names the recall that served the note; the time window stays as the fallback", () => withEnv({}, async (dir) => {
  const { vault, search, root } = await fixtureVault(dir);
  try {
    const telemetry = new Telemetry();
    const deps: ToolDeps = { vault, search, telemetry, vaultPath: root };
    const first = (await recallHandler(deps, { query: "flux compensator drift tuning", k: 5 })) as unknown as { recall_id: string; hits: { id: string }[] };
    assert.equal(first.hits[0].id, "flux-note");
    // A second, newer recall that does NOT return the flux note.
    const second = (await recallHandler(deps, { query: "tomato bed watering plan", k: 5 })) as unknown as { recall_id: string; hits: { id: string }[] };
    assert.ok(!second.hits.some((h) => h.id === "flux-note"));
    await loadMemoryHandler(deps, { id: "flux-note" });
    await sleep(30);
    const load = (await rows(dir)).find((row) => row.kind === "load_memory")!;
    assert.equal(load.from_recall, first.recall_id, "the recall that actually returned the note");
    assert.equal(load.recall_rank, 1);
    assert.equal(load.follows_recall, second.recall_id, "the window link still names the newest recall");
    assert.equal(load.origin, "recall", "the existing origin column is unchanged");
  } finally { search.stop(); await vault.stop(); }
}));

test("E — a load no recent recall served carries no recall link", () => withEnv({}, async (dir) => {
  const { vault, search, root } = await fixtureVault(dir);
  try {
    const telemetry = new Telemetry();
    const deps: ToolDeps = { vault, search, telemetry, vaultPath: root };
    await recallHandler(deps, { query: "tomato bed watering plan", k: 1 });
    await loadMemoryHandler(deps, { id: "flux-note" });
    await sleep(30);
    const load = (await rows(dir)).find((row) => row.kind === "load_memory")!;
    assert.equal(load.from_recall, null); assert.equal(load.recall_rank, null);
    assert.equal(typeof load.follows_recall, "string");
    assert.equal(telemetry.findRecallFor("never-served"), null);
  } finally { search.stop(); await vault.stop(); }
}));

// ─── F: measurement runs ─────────────────────────────────────────────────────

const recallRow = { recall_id: "r", query: "q", k: 5, scope: null, type: null, vault_size: 1, hit_count: 0, top_score: null, hits: [], latency_ms: 1 };
const loadRow = { id: "m1", found: true, follows_recall: null, from_hook_recall: null, hook_hint_rank: null };

test("F — a call that declares client eval is flagged; real traffic carries no flag", () => withEnv({}, async (dir) => {
  const telemetry = new Telemetry();
  await telemetry.logRecall({ ...recallRow, recall_id: "measured", client: "eval" });
  await telemetry.logRecall({ ...recallRow, recall_id: "real", client: "claude-code" });
  await telemetry.logLoadMemory(loadRow);
  const written = await rows(dir);
  assert.equal(written.find((row) => row.recall_id === "measured")!.eval_run, true);
  assert.ok(!("eval_run" in written.find((row) => row.recall_id === "real")!));
  assert.ok(!("eval_run" in written.find((row) => row.kind === "load_memory")!));
  assert.deepEqual(evalRunMark({ dimensions: { client: "unknown" } }), {});
}));

test("F — a process started as a measurement run flags every row, also those without a dimensions column", () => withEnv({ BASTRA_EVAL_RUN: "1" }, async (dir) => {
  const telemetry = new Telemetry();
  await telemetry.logRecall({ ...recallRow, client: "claude-code" });
  await telemetry.logLoadMemory(loadRow);
  await writeDraftEvent({ kind: "draft_notice", count: 1 });
  await recordRerankVerdicts([{ recall_id: "r", candidate_ids: ["a"], chosen_id: null, chosen_rank: null }], "fixture-chat");
  const written = await rows(dir);
  assert.equal(written.length, 4);
  assert.ok(written.every((row) => row.eval_run === true), JSON.stringify(written.map((row) => [row.kind, row.eval_run])));
}));

// ─── G: reranker verdict ─────────────────────────────────────────────────────

const info: Record<string, MemoryInfo> = {
  wrong: { text: "Unrelated note about invoices", terms: ["invoice"] },
  right: { text: "NSPanel closes on dialog — resignKey lesson", terms: ["resignkey", "nspanel"] },
};
const QUERY = "warum schließt sich mein Panel beim Dialog";

test("G — every reranker judgement is reported: recall id, candidates, the pick and its rank", async () => {
  const verdicts: RerankVerdict[] = [];
  const pools = [
    { query: QUERY, pool: [{ id: "wrong", score: 80 }, { id: "right", score: 12 }], topScore: 80, scoreKind: null, recallId: "rec-far" },
    { query: "another weak fixture question", pool: [{ id: "wrong", score: 40 }, { id: "right", score: 9 }], topScore: 40, scoreKind: null },
  ];
  const answers = ["2", "0"];
  const result = await harvestFarBridges(pools, (id) => info[id] ?? null, async () => answers.shift()!, { maxScore: 100, onVerdict: (verdict) => verdicts.push(verdict) });
  assert.equal(result.judged, 2);
  assert.deepEqual(verdicts, [
    { recall_id: "rec-far", candidate_ids: ["wrong", "right"], chosen_id: "right", chosen_rank: 2 },
    { recall_id: null, candidate_ids: ["wrong", "right"], chosen_id: null, chosen_rank: null },
  ]);
});

test("G — the verdict row is written with the model and without any text; telemetry off writes nothing", async () => {
  const verdicts: RerankVerdict[] = [{ recall_id: "rec-far", candidate_ids: ["wrong", "right"], chosen_id: "right", chosen_rank: 2 }];
  await withEnv({}, async (dir) => {
    await recordRerankVerdicts(verdicts, "fixture-chat");
    const written = await rows(dir);
    assert.equal(written.length, 1);
    const { ts, ...row } = written[0];
    assert.ok(!Number.isNaN(Date.parse(ts)));
    assert.deepEqual(row, { kind: "rerank_verdict", session_id: null, recall_id: "rec-far", candidate_ids: ["wrong", "right"], chosen_id: "right", chosen_rank: 2, model: "fixture-chat" });
  });
  await withEnv({ BASTRA_TELEMETRY: "0" }, async (dir) => {
    await recordRerankVerdicts(verdicts, "fixture-chat");
    assert.deepEqual(await rows(dir), []);
  });
});
