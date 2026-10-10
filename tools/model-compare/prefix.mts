/**
 * Vector-only recall with the production embedding input, raw vs EmbeddingGemma's documented task prefixes.
 *   node --import tsx tools/model-compare/prefix.mts --corpus FILE --out FILE [--ids FILE] [--kinds far,far_xlang]
 * The raw document text is what the daemon embeds (`buildEmbedText` in packages/core/src/embeddings.ts: title,
 * tags, recall_when, summary, body start), built from the notes as the production vault loads them: a note
 * without tags carries the tag `unsorted` there, and the body keeps its leading blank line. The query passes
 * the production normalization. No expansion, as in the vector lane of recall.mts.
 * embeddinggemma on 127.0.0.1:11434, embeddinggemma-2:270m on 127.0.0.1:11435 (skipped when that server is absent).
 */
import { readFile } from "node:fs/promises";
import { embedBody } from "../../packages/core/src/embed-cache.ts";
import { normalizeQuery } from "../../packages/core/src/query-normalize.ts";
import { fixture, loopbackUrl, outputGuard } from "./common.mts";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? undefined : process.argv[i + 1]; };
const notes: any[] = JSON.parse(await readFile(arg("corpus")!, "utf8")).notes.filter((n: any) => (n.sensitivity ?? "team") !== "private");
const ids: Set<string> | null = arg("ids") ? new Set(JSON.parse(await readFile(arg("ids")!, "utf8"))) : null;
const kinds = (arg("kinds") ?? "near,far,far_xlang").split(",");
const write = outputGuard([arg("out")!], [arg("corpus"), arg("ids")]);
const queried = notes.filter(n => !ids || ids.has(n.id)), index = new Map(notes.map((n, i) => [n.id, i]));

async function embed(url: string, model: string, texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 8) {
    const r = await fetch(`${url}/api/embed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, input: texts.slice(i, i + 8), truncate: true }), redirect: "error" });
    if (!r.ok) throw Error(`embed HTTP ${r.status}`);
    for (const v of (await r.json() as any).embeddings) { const f = Float32Array.from(v); const n = Math.hypot(...f); out.push(f.map(x => x / n)); }
  }
  return out;
}
// The throwaway vault of recall.mts without an embedding model: only its parsed notes are used here.
const vault = await fixture(notes, "none");
const loaded = new Map(vault.vault.list().map(m => [m.fm.id, m]));
await vault.close();
const rest = (n: any) => { const m = loaded.get(n.id)!; return [m.fm.tags.join(" "), m.fm.recall_when.join(" "), m.fm.summary, embedBody(m)].filter(p => p && p.length > 0).join("\n"); };
const result: Record<string, unknown> = {};
for (const [label, server, model] of [["embeddinggemma", "http://127.0.0.1:11434", "embeddinggemma"], ["embeddinggemma-2", "http://127.0.0.1:11435", "embeddinggemma-2:270m"]]) {
  const url = loopbackUrl(server);
  if (!await fetch(`${url}/api/version`, { redirect: "error" }).then(r => r.ok).catch(() => false)) { console.error(`${label}: no server on ${url}, skipped`); continue; }
  for (const mode of ["raw", "prefix"]) {
    const docs = await embed(url, model, notes.map(n => mode === "prefix" ? `title: ${loaded.get(n.id)!.fm.title} | text: ${rest(n)}` : `${loaded.get(n.id)!.fm.title}\n${rest(n)}`));
    const row: Record<string, unknown> = {};
    for (const kind of kinds) {
      const qs = await embed(url, model, queried.map(n => (mode === "prefix" ? "task: search result | query: " : "") + normalizeQuery(n.queries[kind])));
      const ranks = queried.map((n, qi) => {
        const score = (d: Float32Array) => { let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * qs[qi][i]; return s; };
        const target = score(docs[index.get(n.id)!]);
        return 1 + docs.filter(d => score(d) > target).length;
      });
      const k = ranks.length, share = (limit: number) => Math.round(1000 * ranks.filter(r => r <= limit).length / k) / 1000;
      row[kind] = { n: k, "R@1": share(1), "R@5": share(5), MRR: Math.round(1000 * ranks.reduce((s, r) => s + 1 / r, 0) / k) / 1000, ranks };
    }
    result[`${label} ${mode}`] = row;
    console.log(label, mode, JSON.stringify(Object.fromEntries(Object.entries(row).map(([k, v]: any) => [k, { n: v.n, "R@1": v["R@1"], "R@5": v["R@5"], MRR: v.MRR }]))));
    await write(arg("out")!, JSON.stringify(result));
  }
}
