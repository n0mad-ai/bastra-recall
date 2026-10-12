/** #1082, eval only. Local model runs must be serialized by the operator. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, EmbeddingIndex, OllamaEmbeddingProvider, fuseRRF, rrfVectorWeight } from "@bastra-recall/core";
import { normalizeQuery } from "../../core/dist/query-normalize.js";
import { loadLongMemEval, haystackMemories, longMemEvalDatasetHash, type SessionMemory } from "./longmemeval-dataset.js";
import { writeQuestionVault, awaitBackfill } from "./longmemeval-run.js";
import { sourceChunks, maxPerDocument } from "./chunk-maxsim.js";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i + 1]) throw new Error("flags require values");
  args.set(process.argv[i], process.argv[i + 1]);
}
for (const flag of args.keys()) if (!["--corpus", "--mode", "--out", "--limit", "--resume"].includes(flag)) throw new Error(`unknown flag ${flag}`);
const corpus = args.get("--corpus"), out = args.get("--out"), mode = args.get("--mode");
if (!corpus || !out || !["lexical", "dense"].includes(mode ?? "")) throw new Error("require --corpus, --mode lexical|dense, --out");
const limit = Number(args.get("--limit") ?? 0);
if (!Number.isInteger(limit) || limit < 0) throw new Error("invalid limit");
const loaded = loadLongMemEval(corpus).questions;
const questions = limit ? loaded.slice(0, limit) : loaded;
const hash = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const datasetHash = longMemEvalDatasetHash(questions, "all");
const code = createHash("sha256");
for (const name of ["chunk-maxsim-run.ts", "chunk-maxsim.ts", "longmemeval-run.ts", "longmemeval-dataset.ts"]) code.update(name).update(readFileSync(new URL(name, import.meta.url)));
const coreDir = new URL("../../core/src/", import.meta.url);
const coreHash = createHash("sha256");
for (const f of readdirSync(coreDir).filter(f => f.endsWith(".ts")).sort()) coreHash.update(f).update("\0").update(readFileSync(new URL(f, coreDir)));
const gitOpts = { cwd: import.meta.dirname, encoding: "utf8" as const };
const engine = { repo_commit: execFileSync("git", ["rev-parse", "HEAD"], gitOpts).trim(),
  repo_dirty: !!execFileSync("git", ["status", "--porcelain"], gitOpts).trim(), core_src_sha256: coreHash.digest("hex") };
const identity = { dataset_hash: datasetHash, code_hash: code.digest("hex"), core_src_sha256: engine.core_src_sha256, mode, vector_weight: rrfVectorWeight() };
const dense = mode === "dense";
const model = process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma";
const baseURL = process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434";
if (dense && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) throw new Error("this measurement permits only a local Ollama endpoint");
let modelDigest: string | null = null;
if (dense) {
  const tags = await fetch(`${baseURL}/api/tags`).then(r => r.json()) as { models: { name: string; digest: string }[] };
  modelDigest = tags.models.find(m => m.name === model || m.name === `${model}:latest`)?.digest ?? null;
  if (!modelDigest) throw new Error("model digest unavailable; refuse unidentified model");
}
const provider = dense ? new OllamaEmbeddingProvider({ baseURL, model, keepAlive: "10m" }) : null;
type Row = { question_id: string; question_type: string; gold: string[]; ranked: Record<string, string[]>;
  sessions: number; chunks: number; multi_chunk_sessions: number; backfill_ms: number; query_ms: number; persisted_bytes: number };
let rows: Row[] = [];
if (args.get("--resume") === "yes") {
  const prior = JSON.parse(readFileSync(out, "utf8"));
  if (JSON.stringify(prior.identity) !== JSON.stringify(identity) || prior.embedding_model_digest !== modelDigest) throw new Error("checkpoint identity differs");
  rows = prior.questions;
  if (rows.some((r, i) => r.question_id !== questions[i]?.question_id)) throw new Error("checkpoint question order differs");
}
const started = Date.now();
const summarize = (xs: Row[]): Record<string, Record<string, number>> => {
  const result: Record<string, Record<string, number>> = {};
  for (const arm of Object.keys(xs[0]?.ranked ?? {})) {
    const sums: Record<string, number> = { "r@1": 0, "r@3": 0, "r@5": 0, "r@10": 0, "r@20": 0, mrr: 0 };
    for (const r of xs) {
      const found = r.ranked[arm].findIndex(id => r.gold.includes(id));
      if (found >= 0) { sums.mrr += 1 / (found + 1); for (const k of [1, 3, 5, 10, 20]) if (found < k) sums[`r@${k}`]++; }
    }
    for (const key of Object.keys(sums)) sums[key] /= xs.length || 1;
    result[arm] = sums;
  }
  return result;
};
const quantile = (xs: number[], q: number): number | null => xs.length ? xs.slice().sort((a, b) => a - b)[Math.ceil(q * xs.length) - 1] : null;
const save = async (): Promise<void> => {
  const sessions = rows.reduce((s, r) => s + r.sessions, 0), chunks = rows.reduce((s, r) => s + r.chunks, 0);
  await writeFile(out, JSON.stringify({ schema_version: 1, issue: 1082, harness: "chunk-maxsim-run", identity, engine,
    registration_sha256: hash(readFileSync(new URL("../registrations/chunk-maxsim.json", import.meta.url))),
    n_questions: rows.length, expected_questions: questions.length, complete: rows.length === questions.length,
    embedding_model: dense ? model : null, embedding_model_digest: modelDigest, summary: summarize(rows),
    by_type: Object.fromEntries([...new Set(rows.map(r => r.question_type))].map(type => {
      const xs = rows.filter(r => r.question_type === type); return [type, { n: xs.length, summary: summarize(xs) }];
    })),
    cost: { sessions, chunks, vectors_per_session: sessions ? chunks / sessions : null,
      multi_chunk_sessions: rows.reduce((s, r) => s + r.multi_chunk_sessions, 0),
      raw_vector_bytes: dense ? chunks * 768 * 4 : 0,
      persisted_bytes: rows.reduce((s, r) => s + r.persisted_bytes, 0),
      backfill_ms: rows.reduce((s, r) => s + r.backfill_ms, 0),
      query_ms_p50: quantile(rows.map(r => r.query_ms), 0.5), query_ms_p95: quantile(rows.map(r => r.query_ms), 0.95),
      current_invocation_wall_ms: Date.now() - started }, questions: rows }, null, 2) + "\n");
};
const work = await mkdtemp(join(tmpdir(), "chunk-maxsim-"));
try {
  for (let qi = rows.length; qi < questions.length; qi++) {
    const q = questions[qi], { memories } = haystackMemories(q, "all");
    const owners = new Map<string, string>();
    const chunks: SessionMemory[] = [];
    let multi = 0;
    for (const [mi, m] of memories.entries()) {
      const parts = sourceChunks(m.body); if (parts.length > 1) multi++;
      for (const [ci, c] of parts.entries()) {
        const id = `chunk-${String(mi).padStart(4, "0")}-${String(ci).padStart(4, "0")}`;
        owners.set(id, m.id); chunks.push({ ...m, id, body: c.text });
      }
    }
    const root = join(work, `q${qi}`), wholeRoot = join(root, "whole"), chunkRoot = join(root, "chunks");
    await writeQuestionVault(wholeRoot, memories); await writeQuestionVault(chunkRoot, chunks);
    const wholeVault = new Vault(wholeRoot), chunkVault = new Vault(chunkRoot);
    for (const [v, wanted] of [[wholeVault, memories.length], [chunkVault, chunks.length]] as const) {
      const info = await v.init(); if (info.loaded !== wanted || info.skipped.length) throw new Error("incomplete question index");
    }
    const whole = new SearchIndex(wholeVault), chunkLex = new SearchIndex(chunkVault); whole.start(); chunkLex.start();
    let emb: EmbeddingIndex | null = null, backfill = 0, persisted = 0;
    try {
      if (provider) {
        const before = Date.now(); emb = new EmbeddingIndex(chunkVault, provider, join(chunkRoot, ".bastra", "chunk-vectors.json"));
        await emb.start(); await awaitBackfill(emb, chunks.length, q.question_id); backfill = Date.now() - before;
      }
      const beforeQuery = Date.now();
      const wholeIds = whole.recall(q.question, { k: 50 }).map(h => h.id);
      const chunkIds = maxPerDocument(chunkLex.recall(q.question, { k: chunks.length }), owners).slice(0, 50).map(h => h.id);
      const ranked: Record<string, string[]> = { whole_bm25: wholeIds.slice(0, 20), chunk_bm25: chunkIds.slice(0, 20) };
      if (emb) {
        const outcome = await emb.searchDetailed(normalizeQuery(q.question), chunks.length);
        if (outcome.outcome !== "hits" || outcome.hits.length !== chunks.length) throw new Error("incomplete dense arm");
        const maxIds = maxPerDocument(outcome.hits, owners).slice(0, 50).map(h => h.id);
        const fusion = (lex: string[]): string[] => [...fuseRRF(lex, maxIds)].sort((a, b) => b[1].score - a[1].score).slice(0, 20).map(([id]) => id);
        ranked.maxsim_dense = maxIds.slice(0, 20); ranked.whole_bm25_maxsim = fusion(wholeIds); ranked.chunk_bm25_maxsim = fusion(chunkIds);
      }
      const queryMs = Date.now() - beforeQuery;
      if (emb) { await emb.stop(); emb = null; persisted = (await stat(join(chunkRoot, ".bastra", "chunk-vectors.json"))).size; }
      rows.push({ question_id: q.question_id, question_type: q.question_type,
        gold: q.answer_session_ids.map(s => { const m = memories.find(m => m.session_id === s); if (!m) throw new Error("missing gold mapping"); return m.id; }),
        ranked, sessions: memories.length, chunks: chunks.length, multi_chunk_sessions: multi,
        backfill_ms: backfill, query_ms: queryMs, persisted_bytes: persisted });
    } finally { if (emb) await emb.stop(); whole.stop(); chunkLex.stop(); await rm(root, { recursive: true, force: true }); }
    await save();
    console.error(`${mode}: ${rows.length}/${questions.length}; chunks ${chunks.length}; elapsed ${Math.round((Date.now() - started) / 1000)}s`);
  }
} finally { await rm(work, { recursive: true, force: true }); }
console.log(JSON.stringify({ summary: summarize(rows), n_questions: rows.length, engine }, null, 2));
