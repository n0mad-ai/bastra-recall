/** #644: frozen synthetic correction baseline; never writes to a real vault. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";

const fixture = new URL("../fixtures/supersession-durability.json", import.meta.url);
const registration = new URL("../registrations/supersession-durability.json", import.meta.url);
const hash = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const corpus = JSON.parse(readFileSync(fixture, "utf8")) as { cases: {
  id: string; language: string; kind: string; title: string; before: string; after: string; queries: string[];
}[] };
const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== "--out") throw new Error("usage: --out <artifact>");
const opts = { cwd: import.meta.dirname, encoding: "utf8" as const };
const coreDir = new URL("../../core/src/", import.meta.url);
const coreHash = createHash("sha256");
for (const f of readdirSync(coreDir).filter(f => f.endsWith(".ts")).sort()) {
  coreHash.update(f).update("\0").update(readFileSync(new URL(f, coreDir)));
}
const engine = { repo_commit: execFileSync("git", ["rev-parse", "HEAD"], opts).trim(),
  repo_dirty: execFileSync("git", ["status", "--porcelain"], opts).trim().length > 0,
  core_src_sha256: coreHash.digest("hex") };
const root = await mkdtemp(join(tmpdir(), "supersession-durability-"));
const rows: Record<string, unknown>[] = [];
try {
  for (const c of corpus.cases) {
    const dir = join(root, c.id);
    await mkdir(join(dir, "memories"), { recursive: true });
    const old = `${c.id}-a-old`, successor = `${c.id}-z-new`;
    for (const [id, body, link] of [
      [old, c.before, `superseded_by: ${successor}`],
      [successor, c.after, `replaces: ${old}`],
      [`${c.id}-distractor`, "The telescope maintenance schedule is monthly.", ""],
    ]) {
      await writeFile(join(dir, "memories", `${id}.md`),
        `---\nid: ${id}\ntitle: ${JSON.stringify(id.endsWith("distractor") ? "Telescope maintenance" : c.title)}\n` +
        `type: reference\nsummary: ${JSON.stringify(body)}\n` +
        `scope: synthetic-correction\ntopic_path: [eval]\ntags: []\nrecall_when: []\n` +
        `created: 2026-01-01\nupdated: 2026-01-01\n${link}\n---\n\n${body}\n`);
    }
    const vault = new Vault(dir);
    const loaded = await vault.init();
    if (loaded.loaded !== 3 || loaded.skipped.length) throw new Error("incomplete fixture index");
    const search = new SearchIndex(vault); search.start();
    try {
      for (const [qi, query] of c.queries.entries()) {
        const hits = search.recall(query, { k: 3 });
        const rank = (id: string): number | null => {
          const i = hits.findIndex(h => h.id === id); return i < 0 ? null : i + 1;
        };
        const a = rank(old), b = rank(successor);
        const sa = hits.find(h => h.id === old)?.score, sb = hits.find(h => h.id === successor)?.score;
        rows.push({ case: c.id, language: c.language, kind: c.kind, query_class: ["neutral", "old-anchor", "paraphrase"][qi],
          predecessor_rank: a, successor_rank: b,
          predecessor_outranks: a !== null && (b === null || a < b),
          strict_score_inversion: sa !== undefined && (sb === undefined || sa > sb),
          score_tie: sa !== undefined && sb !== undefined && sa === sb,
          both_missing: a === null && b === null, predecessor_reachable: vault.get(old)?.body.trim() === c.before });
      }
    } finally { search.stop(); }
  }
} finally { await rm(root, { recursive: true, force: true }); }
const summarize = (xs: typeof rows): Record<string, number> => ({
  n: xs.length, predecessor_outranks: xs.filter(x => x.predecessor_outranks).length,
  strict_score_inversions: xs.filter(x => x.strict_score_inversion).length,
  score_ties: xs.filter(x => x.score_tie).length, both_missing: xs.filter(x => x.both_missing).length,
  successor_hit_at_1: xs.filter(x => x.successor_rank === 1).length,
  successor_hit_at_3: xs.filter(x => x.successor_rank !== null).length,
  predecessor_reachable: xs.filter(x => x.predecessor_reachable).length,
});
const slices: Record<string, unknown> = {};
for (const dimension of ["language", "kind", "query_class"]) {
  slices[dimension] = Object.fromEntries([...new Set(rows.map(r => String(r[dimension])))].map(v =>
    [v, summarize(rows.filter(r => r[dimension] === v))]));
}
const verdictHash = hash(JSON.stringify(rows));
const result = { schema_version: 1, issue: 644, harness: "supersession-durability", engine,
  corpus_sha256: hash(readFileSync(fixture)), registration_sha256: hash(readFileSync(registration)),
  code_sha256: hash(readFileSync(new URL(import.meta.url))), arm: "bm25", k: 3,
  summary: summarize(rows), slices, verdict_sha256: verdictHash, rows,
  verdict: "baseline measured; hybrid, historical/as-of queries and population durability remain unmeasured" };
await writeFile(argv[1], JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ engine, summary: result.summary, verdict_sha256: verdictHash }, null, 2));
