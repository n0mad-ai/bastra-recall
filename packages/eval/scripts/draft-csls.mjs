/** #1109 unlabelled diagnostic. Read inputs directly; no store API or writes. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cosine } from "@bastra-recall/core";
import { bigramSet, dice } from "../../daemon/src/stop-lane-repeat.ts";
const started = performance.now();
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i + 1] || !["--drafts", "--vectors", "--out"].includes(process.argv[i])) throw new Error("require --drafts <store> --vectors <vectors> --out <aggregate>");
  args.set(process.argv[i], process.argv[i + 1]);
}
if (!["--drafts", "--vectors", "--out"].every(k => args.has(k))) throw new Error("missing input/output");
if ([args.get("--drafts"), args.get("--vectors")].some(p => resolve(p) === resolve(args.get("--out")))) throw new Error("output must differ from inputs");
const sha = b => createHash("sha256").update(b).digest("hex");
const rawDrafts = readFileSync(args.get("--drafts")), rawVectors = readFileSync(args.get("--vectors"));
const store = JSON.parse(rawDrafts), cache = JSON.parse(rawVectors);
if (store.version !== 1 || cache.version !== 1 || !Array.isArray(store.rows) || !Array.isArray(cache.rows) || !Number.isInteger(cache.dim)) throw new Error("unsupported input schema");
const vectors = new Map(cache.rows.map(row => [row.id, row]));
const valid = [];
let rejected = 0;
for (const row of store.rows) {
  const v = vectors.get(row.id);
  if (!v || v.fp !== row.fp || v.quoteHash !== sha(row.quote)) { rejected++; continue; }
  const bytes = Buffer.from(v.vector, "base64");
  if (bytes.length !== cache.dim * 4) { rejected++; continue; }
  const vector = new Float32Array(cache.dim); new Uint8Array(vector.buffer).set(bytes);
  if (!vector.every(Number.isFinite) || !vector.some(x => x !== 0)) { rejected++; continue; }
  valid.push({ vector, grams: bigramSet(row.quote), sessions: new Set(row.evidence.map(e => e.session_id)) });
}
const neighbors = Array.from({ length: valid.length }, () => []);
const pairs = [];
let sameSessionExcluded = 0;
for (let i = 0; i < valid.length; i++) for (let j = i + 1; j < valid.length; j++) {
  const a = valid[i], b = valid[j];
  if ([...a.sessions].some(s => b.sessions.has(s))) { sameSessionExcluded++; continue; }
  if (!a.sessions.size || !b.sessions.size) throw new Error("cannot classify a pair without evidence sessions");
  const raw = cosine(a.vector, b.vector), lexical = a.grams && b.grams ? dice(a.grams, b.grams) : 0;
  pairs.push({ i, j, raw, dice: lexical }); neighbors[i].push(raw); neighbors[j].push(raw);
}
const means = neighbors.map(xs => xs.length < 10 ? null : xs.sort((a, b) => b - a).slice(0, 10).reduce((a, b) => a + b, 0) / 10);
const scored = pairs.filter(p => means[p.i] !== null && means[p.j] !== null).map(p => ({ ...p, csls: 2 * p.raw - means[p.i] - means[p.j] }));
const top = field => scored.map((p, index) => ({ p, index })).sort((a, b) => b.p[field] - a.p[field] || a.index - b.index).slice(0, 120).map(x => x.index);
const tops = { cosine: top("raw"), dice: top("dice"), csls: top("csls") };
const overlap = (a, b) => a.filter(x => new Set(b).has(x)).length;
const quantile = (xs, q) => xs.length ? xs.slice().sort((a, b) => a - b)[Math.ceil(q * xs.length) - 1] : null;
const git = argv => execFileSync("git", argv, { cwd: import.meta.dirname, encoding: "utf8" }).trim();
const result = { schema_version: 1, issue: 1109, measured_at: new Date().toISOString(),
  engine: { repo_commit: git(["rev-parse", "HEAD"]), repo_dirty: !!git(["status", "--porcelain"]) },
  code_sha256: sha(readFileSync(new URL(import.meta.url))),
  registration_sha256: sha(readFileSync(new URL("../registrations/draft-csls.json", import.meta.url))),
  input_sha256: { drafts: sha(rawDrafts), vectors: sha(rawVectors) },
  stored_provider: cache.provider, stored_dimension: cache.dim, historical_model_digest: null,
  counts: { drafts: store.rows.length, valid_matched_vectors: valid.length, rejected_drafts: rejected,
    cross_session_pairs: pairs.length, same_session_pairs_excluded: sameSessionExcluded,
    csls_eligible_pairs: scored.length, drafts_without_10_neighbors: means.filter(x => x === null).length,
    ranked_top_n: Math.min(120, scored.length), independently_labelled_pairs: 0 },
  unlabelled_top_overlap: { cosine_csls: overlap(tops.cosine, tops.csls), cosine_dice: overlap(tops.cosine, tops.dice), dice_csls: overlap(tops.dice, tops.csls) },
  cosine_distribution: { p50: quantile(pairs.map(p => p.raw), 0.5), p90: quantile(pairs.map(p => p.raw), 0.9), p99: quantile(pairs.map(p => p.raw), 0.99) },
  cost: { wall_ms: performance.now() - started, existing_vector_file_bytes: rawVectors.length, raw_vector_bytes: valid.length * cache.dim * 4, inference_calls: 0, rss_bytes_at_end: process.memoryUsage().rss },
  csls_distribution: { p50: quantile(scored.map(p => p.csls), 0.5), p90: quantile(scored.map(p => p.csls), 0.9), p99: quantile(scored.map(p => p.csls), 0.99) },
  precision: null, false_positives: null, verdict: "unlabelled ranking diagnostic measured; durable-fact discrimination and promotion gate not evaluable",
  inputs_modified: false, private_content_published: false };
writeFileSync(args.get("--out"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
