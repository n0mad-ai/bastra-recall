import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// The normal repository guard isolates all user-state fallbacks and refuses 6723.
const operatorHome = homedir(), scratchBase = tmpdir();
await import(new URL("../../scripts/test-env.mjs", import.meta.url).href);
export const core = await import("../../packages/core/src/index.ts");
export const { FIELD_BOOST } = await import("../../packages/core/src/search.ts");
export const generation = await import("../../packages/daemon/src/learned-recall/reranker.ts");
export const BASE_URL = "http://127.0.0.1:11434";
export function loopbackUrl(raw: unknown = BASE_URL): string {
  const url = new URL(String(raw));
  if (!["http:", "https:"].includes(url.protocol) || !core.isLoopbackHost(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash || url.port === "6723") throw Error("Only a plain loopback Ollama URL is allowed (never port 6723)");
  return url.href.replace(/\/+$/, "");
}
export const QUERY_TYPES = ["near", "far", "far_xlang"] as const;
export type QueryType = typeof QUERY_TYPES[number];
export interface Note {
  id: string; type: "lesson" | "decision" | "project-fact" | "preference" | "reference";
  scope: string; lang: "de" | "en"; title: string; summary: string; body: string;
  recall_when: string[]; queries: Record<QueryType, string>;
}
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function args(names: string[], flags: string[] = []) {
  const out: Record<string, string | boolean> = {};
  for (let i = 2; i < process.argv.length; i++) {
    const name = process.argv[i].replace(/^--/, "");
    if (process.argv[i] !== `--${name}` || !(names.includes(name) || flags.includes(name))) throw Error(`Unknown option ${process.argv[i]}`);
    if (out[name] !== undefined) throw Error(`Duplicate --${name}`);
    if (flags.includes(name)) out[name] = true;
    else {
      const value = process.argv[++i];
      if (!value || value.startsWith("--")) throw Error(`--${name} requires a value`);
      out[name] = value;
    }
  }
  return out;
}
export function required(a: Record<string, unknown>, key: string): string {
  if (typeof a[key] !== "string" || !a[key]) throw Error(`--${key} is required`);
  return a[key] as string;
}
export function positive(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw Error(`Expected positive integer, got ${value}`);
  return n;
}
export function validatePaths(outputs: Array<string | undefined>, inputs: Array<string | undefined>) {
  const targets = outputs.filter((p): p is string => p !== undefined).map(p => resolve(p));
  const sources = inputs.filter((p): p is string => p !== undefined).map(p => resolve(p));
  if (new Set(targets).size !== targets.length || targets.some(p => sources.includes(p))) throw Error("Result/cache outputs must be distinct and must not overwrite inputs");
  for (const p of targets) if (p === join(operatorHome, ".bastra") || p.startsWith(join(operatorHome, ".bastra") + "/")) throw Error("Output in the operator's .bastra is forbidden");
}
export async function jsonOut(file: string, value: unknown, corpus?: string) {
  const target = resolve(file);
  if (corpus && target === resolve(corpus)) throw Error("Output must not overwrite the corpus");
  if (target === join(operatorHome, ".bastra") || target.startsWith(join(operatorHome, ".bastra") + "/")) throw Error("Output in the operator's .bastra is forbidden");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2) + "\n");
}
export async function corpus(file: string, limit?: unknown) {
  const raw = await readFile(file, "utf8"), parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.notes) || !parsed.notes.length) throw Error("Corpus requires a nonempty notes array");
  const ids = new Set<string>(), types = new Set(["lesson", "decision", "project-fact", "preference", "reference"]);
  for (const n of parsed.notes) {
    if (!n || typeof n !== "object" || typeof n.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n.id) || ids.has(n.id)) throw Error(`Invalid/duplicate kebab id: ${n?.id}`);
    ids.add(n.id);
    for (const key of ["scope", "title", "summary", "body"]) if (typeof n[key] !== "string" || !n[key].trim()) throw Error(`${n.id}: missing ${key}`);
    if (!types.has(n.type) || !["de", "en"].includes(n.lang)) throw Error(`${n.id}: invalid type/lang`);
    if (!Array.isArray(n.recall_when) || !n.recall_when.length || n.recall_when.some((s: unknown) => typeof s !== "string" || !s.trim())) throw Error(`${n.id}: invalid recall_when`);
    for (const q of QUERY_TYPES) if (typeof n.queries?.[q] !== "string" || !n.queries[q].trim()) throw Error(`${n.id}: missing queries.${q}`);
  }
  return { notes: parsed.notes.slice(0, positive(limit, parsed.notes.length)) as Note[], total: parsed.notes.length, sha256: digest(raw) };
}
export function timing(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const quantile = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null;
  return { n: sorted.length, total_ms: values.reduce((a, b) => a + b, 0), median_ms: quantile(.5), p95_ms: quantile(.95), first_ms: values[0] ?? null };
}
export function forecast(values: number[], work: number) {
  const warm = values.length > 1 ? values.slice(1) : values;
  const mean = warm.length ? warm.reduce((a, b) => a + b, 0) / warm.length : null;
  return { assumed_work_items: work, warm_sample_n: warm.length, warm_mean_ms: mean,
    linear_estimate_ms: mean === null ? null : (values[0] ?? 0) + Math.max(0, work - 1) * mean,
    caveat: "Mini-sample extrapolation, not a full-run measurement; larger pools/self-tests can be slower" };
}
export function metrics(ranks: Array<number | null>) {
  const n = ranks.length;
  return { n, r_at_1: ranks.filter(r => r !== null && r <= 1).length / n, r_at_3: ranks.filter(r => r !== null && r <= 3).length / n,
    r_at_5: ranks.filter(r => r !== null && r <= 5).length / n, mrr: ranks.reduce<number>((s, r) => s + (r === null ? 0 : 1 / r), 0) / n };
}
export async function modelInfo(model: string, baseURL = BASE_URL) {
  try {
    const opts = { signal: AbortSignal.timeout(5000), redirect: "error" as const };
    const [show, tags, version] = await Promise.all([
      fetch(`${baseURL}/api/show`, { ...opts, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) }),
      fetch(`${baseURL}/api/tags`, opts),
      fetch(`${baseURL}/api/version`, opts),
    ]);
    if (!show.ok) throw Error(`Ollama show HTTP ${show.status}`);
    const s = await show.json() as any, t = await tags.json() as any, v = await version.json() as any;
    const tag = t.models?.find((x: any) => x.name === model || x.name === `${model}:latest`);
    return { requested: model, server_version: v.version ?? null, installed_name: tag?.name ?? null, digest: tag?.digest ?? null, capabilities: s.capabilities,
      details: s.details, parameters: s.parameters ?? "", template: s.template ?? "",
      model_info: Object.fromEntries(Object.entries(s.model_info ?? {}).filter(([k]) => /embedding_length|context_length|architecture|general\.name/.test(k))) };
  } catch (e) { return { requested: model, metadata_error: errorText(e) }; }
}

// Only one inference request at a time, including index backfill and self-tests.
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn); this.tail = next.catch(() => {}); return next;
  }
  async idle() { await this.tail; }
}
export async function fixture(notes: Note[], model: string, specifiedDim?: unknown, baseURL = BASE_URL) {
  const serial = new Serial(), root = await mkdtemp(join(scratchBase, "bastra-model-compare-"));
  const vault = new core.Vault(root), search = new core.SearchIndex(vault);
  let embeddings: InstanceType<typeof core.EmbeddingIndex> | undefined;
  let embeddingInfo: any = null, calls = 0, dimensionProbe: any = null;
  const embedTimes: number[] = [];
  const close = async () => { await serial.idle(); if (embeddings) await embeddings.stop(); search.stop(); await vault.stop(); await rm(root, { recursive: true, force: true }); };
  const drain = async () => {
    if (!embeddings) return;
    const until = Date.now() + 10 * 60_000;
    for (;;) {
      const health = embeddings.runtimeHealth();
      if (!health.ok) throw Error(`Embedding backfill failed: ${health.lastError}`);
      if (!embeddings.pendingSize() && !embeddings.inFlightCount() && embeddings.currentSnapshot().size === notes.length) return;
      if (Date.now() > until) throw Error("Embedding backfill did not become ready");
      await new Promise(r => setTimeout(r, 20));
    }
  };
  try {
    const date = new Date().toISOString().slice(0, 10);
    for (const n of notes) {
      // Gold queries and language labels NEVER enter the indexed note.
      const fm = { id: n.id, type: n.type, scope: n.scope, title: n.title, summary: n.summary, topic_path: [n.scope], tags: [], recall_when: n.recall_when, sensitivity: "team", created: date, updated: date };
      const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
      await writeFile(join(root, `${n.id}.md`), `---\n${yaml}\n---\n\n${n.body}\n`);
    }
    const loaded = await vault.init();
    if (loaded.loaded !== notes.length || loaded.skipped.length) throw Error(`Vault load mismatch: ${JSON.stringify(loaded)}`);
    search.start();
    if (model !== "none") {
      embeddingInfo = await modelInfo(model, baseURL);
      process.env.BASTRA_EMBEDDING_MODEL = model;
      const options = { baseURL, model: process.env.BASTRA_EMBEDDING_MODEL, keepAlive: "10m" };
      const probe = new core.OllamaEmbeddingProvider(options), started = performance.now();
      const v = await serial.run(() => probe.embed(["Invented model comparison dimensionality probe."]));
      const actualDim = v[0]?.length;
      if (!actualDim || !v[0].every(Number.isFinite) || !v[0].some(x => x !== 0)) throw Error("Invalid dimensionality probe");
      const dim = positive(specifiedDim, actualDim);
      if (dim !== actualDim) throw Error(`--embedding-dim ${dim} differs from returned ${actualDim}`);
      process.env.BASTRA_EMBEDDING_DIM = String(dim);
      dimensionProbe = { dim, automatic: specifiedDim === undefined, duration_ms: performance.now() - started };
      const raw = new core.OllamaEmbeddingProvider({ ...options, dim });
      const measure = async <T,>(fn: () => Promise<T>) => serial.run(async () => { const t = performance.now(); calls++; try { return await fn(); } finally { embedTimes.push(performance.now() - t); } });
      const validate = (vectors: Float32Array[]) => { if (vectors.some(v => v.length !== dim || !v.every(Number.isFinite) || !v.some(x => x !== 0))) throw Error("Embedding dimension/nonfinite/zero-vector mismatch"); return vectors; };
      const provider = { id: raw.id, dim, embed: async (texts: string[]) => validate(await measure(() => raw.embed(texts))),
        embedWithMeta: async (texts: string[]) => { const r = await measure(() => raw.embedWithMeta(texts)); validate(r.vectors); return r; } };
      embeddings = new core.EmbeddingIndex(vault, provider, join(root, ".bastra", "vectors.json"));
      await embeddings.start(); await drain(); search.useEmbeddings(embeddings);
    }
    return { root, vault, search, embeddings, serial, close, drain, embeddingInfo, dimensionProbe,
      embeddingStats: () => ({ calls_excluding_dimension_probe: calls, request_timing: timing(embedTimes) }) };
  } catch (e) { await close(); throw e; }
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export interface ExpansionEntry { id: string; source_hash: string; prompt_sha256: string; status: string; phrases: string[]; raw?: string; duration_ms?: number }
export async function applyExpansions(f: Fixture, file: string) {
  const cache = JSON.parse(await readFile(file, "utf8"));
  if (cache.schema !== 1 || !Array.isArray(cache.entries)) throw Error("Invalid expansion cache");
  const entries = new Map<string, ExpansionEntry>();
  for (const e of cache.entries) {
    if (entries.has(e.id) || !Array.isArray(e.phrases) || e.phrases.some((p: unknown) => typeof p !== "string" || !p.trim())) throw Error("Invalid/duplicate expansion entry");
    entries.set(e.id, e);
  }
  const { mutateMemoryFile } = await import("../../packages/core/src/memory-mutate.ts");
  for (const m of f.vault.list()) {
    const e = entries.get(m.fm.id);
    if (!e || e.source_hash !== core.sourceHash(m) || e.prompt_sha256 !== digest(core.buildExpandPrompt(m))) throw Error(`Missing/stale expansion cache for ${m.fm.id}`);
    if (e.status !== "written") continue;
    await mutateMemoryFile(m.filePath, m.fm.id, { frontmatter: parsed => ({ ...parsed, recall_when_expanded: e.phrases, recall_when_expanded_src: e.source_hash }), body: b => b }, { vaultRoot: f.root });
    await f.vault.reindexFile(m.filePath);
  }
  await f.drain();
  return cache;
}

export async function rank(f: Fixture, query: string, lane: "bm25" | "hybrid" | "vector", k: number) {
  if (lane === "vector") {
    if (!f.embeddings) throw Error("Vector lane needs an embedding model");
    // Same query normalization as recallHybrid, then the production dense arm.
    const { normalizeQuery } = await import("../../packages/core/src/query-normalize.ts");
    const r = await f.embeddings.searchDetailed(normalizeQuery(query), k);
    if (r.outcome !== "hits") throw Error(`Dense arm ${r.outcome}`);
    return r.hits.map(h => ({ id: h.id, score: h.score, mode: "vector" }));
  }
  const opts = { k, authored_query: query, allow_private: false };
  const hits = lane === "bm25" ? f.search.recall(query, opts) : await f.search.recallHybrid(query, opts);
  if (lane === "hybrid" && (!f.embeddings?.runtimeHealth().ok || !hits.some(h => h.mode === "hybrid" || h.mode === "vector"))) throw Error("Hybrid run lost the dense arm");
  return hits.map(h => ({ id: h.id, score: h.score, mode: h.mode ?? "bm25" }));
}
