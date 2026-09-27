// #387 determinism check (review point 1 on #387): ~200 gold queries from a goldset-run
// results.json, raw query vectors embedded twice, compared elementwise, plus the raw
// cosine against the stored vector of the served top-1 memory. Writes a private run
// artifact (vectors are vault-derived) under ~/.bastra/eval-runs.
// Usage: node scripts/determinism-check.mjs <results.json> <vault>/.bastra/embeddings.json
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { OllamaEmbeddingProvider } from "@bastra-recall/core";
const [resultsPath, storePath] = process.argv.slice(2);
const rows = JSON.parse(readFileSync(resultsPath, "utf8")).rows
  .filter((r) => !r.no_answer && r.top_id).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 200);
const store = JSON.parse(readFileSync(storePath, "utf8"));
const docVec = (id) => { const b = Buffer.from(store.vectors[id], "base64"); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const p = new OllamaEmbeddingProvider({ baseURL: "http://localhost:11434", model: "embeddinggemma", keepAlive: "10m" });
const pass = async () => { const out = []; for (const r of rows) out.push((await p.embed([r.query]))[0]); return out; };
const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / Math.sqrt(na * nb); };
const t0 = Date.now();
const v1 = await pass(); const v2 = await pass();
let maxAbs = 0, maxRel = 0, identicalVectors = 0, maxSimDiff = 0;
const sims = [];
for (let q = 0; q < rows.length; q++) {
  let same = true;
  for (let i = 0; i < v1[q].length; i++) {
    const a = v1[q][i], b = v2[q][i], d = Math.abs(a - b);
    if (d !== 0) same = false;
    maxAbs = Math.max(maxAbs, d);
    if (a !== 0) maxRel = Math.max(maxRel, d / Math.abs(a));
  }
  if (same) identicalVectors++;
  const dv = docVec(rows[q].top_id);
  const s1 = cos(v1[q], dv), s2 = cos(v2[q], dv); sims.push(s1);
  maxSimDiff = Math.max(maxSimDiff, Math.abs(s1 - s2));
}
const digest = (vs) => createHash("sha256").update(Buffer.concat(vs.map((v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength)))).digest("hex");
const summary = {
  run_date: new Date().toISOString(), provider: p.id, dim: v1[0].length, queries: rows.length,
  selection: "answerable non-probe rows of the run with a served top_id, sorted by case id ascending, first 200",
  source_results: resultsPath, passes: 2, mode: "one query per request, as EmbeddingIndex embeds a query",
  identical_vectors: identicalVectors, max_abs_diff: maxAbs, max_rel_diff: maxRel,
  raw_similarity: "cosine(query vector, stored vector of the served top-1 memory)", max_similarity_diff: maxSimDiff,
  vectors_sha256_pass1: digest(v1), vectors_sha256_pass2: digest(v2),
  similarities_sha256: createHash("sha256").update(sims.map((s) => s.toPrecision(9)).join(",")).digest("hex"),
  duration_ms: Date.now() - t0,
};
const dir = join(homedir(), ".bastra", "eval-runs", `${summary.run_date.slice(0, 10)}-determinism-${summary.vectors_sha256_pass1.slice(0, 12)}`);
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
writeFileSync(join(dir, "vectors.json"), JSON.stringify({ ids: rows.map((r) => r.id), pass1: v1.map((v) => Buffer.from(v.buffer).toString("base64")) }) + "\n", { mode: 0o600 });
writeFileSync(join(dir, "command.txt"), `node scripts/determinism-check.mjs ${resultsPath} <vault>/.bastra/embeddings.json\n`, { mode: 0o600 });
console.log(JSON.stringify({ ...summary, artifact: dir }, null, 2));
