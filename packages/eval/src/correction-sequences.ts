/** #600 synthetic retrieval/lifecycle subset, entirely inside temporary roots. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, SearchIndex, EmbeddingIndex, OllamaEmbeddingProvider, rrfVectorWeight } from "@bastra-recall/core";

type Version = { id: string; value: string; valid_from: string; source: string };
type Case = { id: string; split: string; language: string; kind: string; title: string; versions: Version[]; queries: string[] };
const fixture = new URL("../fixtures/correction-sequences.json", import.meta.url);
const reg = new URL("../registrations/correction-sequences.json", import.meta.url);
const cases = (JSON.parse(readFileSync(fixture, "utf8")) as { cases: Case[] }).cases;
if (process.argv.length !== 4 || process.argv[2] !== "--out") throw new Error("usage: --out <artifact>");
const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const core = new URL("../../core/src/", import.meta.url), hash = createHash("sha256");
for (const f of readdirSync(core).filter(f => f.endsWith(".ts")).sort()) hash.update(f).update("\0").update(readFileSync(new URL(f, core)));
const git = (args: string[]): string => execFileSync("git", args, { cwd: import.meta.dirname, encoding: "utf8" }).trim();
const engine = { repo_commit: git(["rev-parse", "HEAD"]), repo_dirty: !!git(["status", "--porcelain"]), core_src_sha256: hash.digest("hex") };
const baseURL = process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname) || rrfVectorWeight() !== 1.5) throw new Error("require local shipped hybrid profile");
const tags = await fetch(`${baseURL}/api/tags`).then(r => r.json()) as { models: { name: string; digest: string }[] };
const digest = tags.models.find(m => m.name === "embeddinggemma:latest")?.digest;
if (!digest) throw new Error("no identified local embeddinggemma");
const provider = new OllamaEmbeddingProvider({ baseURL, model: "embeddinggemma", keepAlive: "10m" });
const work = await mkdtemp(join(tmpdir(), "correction-sequences-"));
type Row = { case: string; split: string; language: string; kind: string; phase: string; stage: number; query: number; arm: string;
  ranked: string[]; current_ids: string[]; current_hit_at_1: boolean | null; current_hit_at_5: boolean | null;
  obsolete_top1: boolean | null; obsolete_outranks_current: boolean | null; conflict_complete: boolean | null;
  oldest_reachable: boolean; reload_ranks_equal: boolean | null };
const rows: Row[] = [];
try {
 for (const c of cases) {
  const dir = join(work, c.id), memories = join(dir, "memories"), hidden = join(dir, ".fixture-archive");
  await mkdir(memories, { recursive: true }); await mkdir(hidden);
  let known: Version[] = [];
  const evaluate = async (phase: string, stage: number, expectedRanks?: Map<string, string[]>): Promise<Map<string, string[]>> => {
    const current = c.kind === "conflict" ? known.map(v => v.id) : [known.slice().sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0].id];
    for (const [i, v] of known.entries()) {
      const links = c.kind === "conflict" ? "" : `${i ? `replaces: ${known[i - 1].id}\n` : ""}${v.id !== current[0] ? `superseded_by: ${current[0]}\n` : ""}`;
      const body = `${c.title}: ${v.value}. Valid from ${v.valid_from}. Source ${v.source}.`;
      await writeFile(join(memories, `${v.id}.md`), `---\nid: ${v.id}\ntitle: ${JSON.stringify(c.title)}\ntype: reference\nsummary: ${JSON.stringify(body)}\nscope: synthetic-sequence\ntopic_path: [eval]\ntags: []\nrecall_when: []\ncreated: 2026-01-01\nupdated: 2026-01-01\n${links}---\n\n${body}\n`);
    }
    const vault = new Vault(dir); const info = await vault.init();
    if (info.loaded !== known.length || info.skipped.length) throw new Error("incomplete sequence state");
    const search = new SearchIndex(vault); search.start();
    const emb = new EmbeddingIndex(vault, provider, join(dir, ".bastra", "vectors.json"));
    await emb.start();
    const until = Date.now() + 120_000;
    while (emb.size() !== known.length) { if (Date.now() > until) throw new Error("backfill incomplete"); await new Promise(r => setTimeout(r, 50)); }
    // stop persists vectors only after size is complete; these are fresh
    // components, so no live watcher correctness is inferred from this run.
    search.useEmbeddings(emb);
    const signatures = new Map<string, string[]>();
    try {
      for (const [qi, query] of c.queries.entries()) for (const arm of ["bm25", "hybrid"]) {
        const hits = arm === "bm25" ? search.recall(query, { k: 5 }) : await search.recallHybrid(query, { k: 5 });
        const ranked = hits.map(h => h.id), old = known.filter(v => !current.includes(v.id)).map(v => v.id);
        const rank = (id: string): number => { const n = ranked.indexOf(id); return n < 0 ? Infinity : n; };
        const bestCurrent = Math.min(...current.map(rank));
        const key = `${arm}-${qi}`; signatures.set(key, ranked);
        const conflict = c.kind === "conflict" && known.length > 1;
        rows.push({ case: c.id, split: c.split, language: c.language, kind: c.kind, phase, stage, query: qi, arm, ranked, current_ids: current,
          current_hit_at_1: conflict ? null : current.includes(ranked[0]), current_hit_at_5: conflict ? null : ranked.some(id => current.includes(id)),
          obsolete_top1: conflict ? null : old.includes(ranked[0]), obsolete_outranks_current: conflict ? null : old.some(id => rank(id) < bestCurrent),
          conflict_complete: conflict ? current.every(id => ranked.includes(id)) : null,
          oldest_reachable: !!vault.get(c.versions[0].id),
          reload_ranks_equal: expectedRanks ? JSON.stringify(ranked) === JSON.stringify(expectedRanks.get(key)) : null });
      }
    } finally { await emb.stop(); search.stop(); }
    return signatures;
  };
  let terminal = new Map<string, string[]>();
  for (const [i, version] of c.versions.entries()) { known.push(version); terminal = await evaluate("ingest", i + 1); }
  await evaluate("component-reload", known.length, terminal);
  if (c.kind !== "conflict") {
    const archived = known[0];
    await rename(join(memories, `${archived.id}.md`), join(hidden, `${archived.id}.md`));
    known = known.slice(1); await evaluate("filesystem-archive-old", c.versions.length);
    await rename(join(hidden, `${archived.id}.md`), join(memories, `${archived.id}.md`));
    known = [archived, ...known]; await evaluate("filesystem-restore-old", c.versions.length);
  }
 }
} finally { await rm(work, { recursive: true, force: true }); }
const summarize = (xs: Row[]): Record<string, number> => ({ trials: xs.length,
  current_evaluable: xs.filter(r => r.current_hit_at_1 !== null).length,
  current_hit_at_1: xs.filter(r => r.current_hit_at_1).length, current_hit_at_5: xs.filter(r => r.current_hit_at_5).length,
  obsolete_top1: xs.filter(r => r.obsolete_top1).length, obsolete_outranks_current: xs.filter(r => r.obsolete_outranks_current).length,
  conflict_evaluable: xs.filter(r => r.conflict_complete !== null).length, conflict_complete: xs.filter(r => r.conflict_complete).length,
  reload_evaluable: xs.filter(r => r.reload_ranks_equal !== null).length, reload_equal: xs.filter(r => r.reload_ranks_equal).length,
  oldest_reachable: xs.filter(r => r.oldest_reachable).length });
const slices: Record<string, unknown> = {};
for (const key of ["arm", "split", "language", "kind", "phase"]) slices[key] = Object.fromEntries([...new Set(rows.map(r => r[key as keyof Row]))].map(v => [String(v), summarize(rows.filter(r => r[key as keyof Row] === v))]));
const result = { schema_version: 1, issue: 600, engine, corpus_sha256: sha(readFileSync(fixture)), code_sha256: sha(readFileSync(new URL(import.meta.url))),
  registration_sha256: sha(readFileSync(reg)), embedding_model: "embeddinggemma", embedding_model_digest: digest, rrf_vector_weight: rrfVectorWeight(), k: 5,
  n_entities: cases.length, summary: summarize(rows), slices, rows, verdict_sha256: sha(JSON.stringify(rows)),
  unsupported: ["answer accuracy/fidelity/uncertainty/citations", "historical as-of", "live ingestion", "product archive/restore API and audits", "field longevity", "M1"],
  verdict: "synthetic retrieval sequence subset measured; no product/lifecycle/answer gate passed" };
await writeFile(process.argv[3], JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ engine, summary: result.summary, slices }, null, 2));
