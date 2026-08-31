/**
 * TEMPORARY — the OB pre-question: does `descriptive_entity` move anything?
 *
 * Explorative, NOT the registered design-A run. It keeps the selection/holdout
 * discipline anyway so the result cannot contaminate the real comparison later.
 *
 * Two modes, deliberately separate processes so no holdout number can be seen
 * before the parameters are fixed:
 *   --grid     choose boost x confidence on the SELECTION only
 *   --holdout  one paired comparison with the fixed parameters
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  EmbeddingIndex, OllamaEmbeddingProvider, SearchIndex, Vault,
  projectCues, hitTitleMatches, type CueProjection, type RecallHit,
} from "@bastra-recall/core";
import { splitGoldCases } from "./src/goldset-split.js";
import type { GoldCase } from "./src/goldset.js";

const K = 10;
const FLOOR = 30;
const H = join(homedir(), ".bastra", "eval-goldset");
const CUES = join(homedir(), ".bastra", "eval-cues", "batch.jsonl");
const VAULT = process.env.BASTRA_VAULT_PATH!;

function goldCases(): GoldCase[] {
  const out: GoldCase[] = [];
  for (const f of ["gold-blind.json", "gold-tel-1.json", "gold-tel-2.json", "gold-tel-3.json", "gold-tel-4.json"]) {
    out.push(...(JSON.parse(readFileSync(join(H, f), "utf8")).cases as GoldCase[]));
  }
  return out;
}

/** The registered split, on the pool design A holds fixed: descriptive. */
function parts(): { selection: GoldCase[]; holdout: GoldCase[] } {
  const desc = goldCases().filter((c) => c.kind === "descriptive");
  const r = splitGoldCases(desc, { seed: 20260828, selectionShare: 0.3, stratifyBy: ["origin_type", "lang"] });
  return { selection: r.selection, holdout: r.holdout };
}

async function attach(vault: Vault, search: SearchIndex): Promise<() => Promise<void>> {
  const provider = new OllamaEmbeddingProvider({ baseURL: "http://localhost:11434", model: "embeddinggemma", keepAlive: "10m" });
  const tmp = await mkdtemp(join(tmpdir(), "bastra-cue-ob-"));
  const store = join(tmp, "embeddings.json");
  await copyFile(join(VAULT, ".bastra", "embeddings.json"), store);
  await provider.embed(["probe"]);
  const emb = new EmbeddingIndex(vault, provider, store);
  await emb.start();
  const want = vault.size();
  const deadline = Date.now() + 15 * 60 * 1000;
  while (emb.size() < want && Date.now() < deadline) await new Promise((r) => setTimeout(r, 400));
  if (emb.size() < want) throw new Error(`only ${emb.size()}/${want} vectors — partial arm is not a measurement`);
  search.useEmbeddings(emb);
  if (!search.hasEmbeddings()) throw new Error("useEmbeddings did not take effect");
  return async () => { emb.stop(); await rm(tmp, { recursive: true, force: true }); };
}

/** Cue lines at or above a confidence threshold. The threshold is a free
 *  parameter of the generation path and is chosen on the selection (§18.3). */
function projectionAt(minConfidence: number, vault: Vault): CueProjection {
  const lines = readFileSync(CUES, "utf8").split("\n").filter((l) => {
    const t = l.trim();
    if (!t) return false;
    try { return (JSON.parse(t).confidence ?? 0) >= minConfidence; } catch { return false; }
  });
  return projectCues(lines, vault);
}

interface Row { id: string; rank: number; anchored: boolean; hits: number }

async function score(cases: GoldCase[], search: SearchIndex): Promise<Row[]> {
  const rows: Row[] = [];
  for (const c of cases) {
    const hits: RecallHit[] = (await search.recallHybrid(c.query, { k: K })).filter((h) => h.score >= FLOOR);
    const exp = new Set(c.expected_ids);
    const r = hits.findIndex((h) => exp.has(h.id));
    rows.push({
      id: c.id,
      rank: r + 1,
      anchored: hits.some((h) => h.matched_recall_when === true || hitTitleMatches(h)),
      hits: hits.length,
    });
  }
  return rows;
}

const at = (rows: Row[], k: number): number => rows.filter((r) => r.rank >= 1 && r.rank <= k).length / rows.length;
const mrr = (rows: Row[]): number => rows.reduce((a, r) => a + (r.rank > 0 ? 1 / r.rank : 0), 0) / rows.length;
const pct = (x: number): string => (100 * x).toFixed(2) + "%";

/** Wilson 95% interval, used for the paired difference's CI below. */
function wilson(k: number, n: number): [number, number] {
  const z = 1.959964, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), c + h];
}

/** Two-sided exact McNemar: binomial test on the discordant pairs. */
function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const logC = (nn: number, kk: number): number => {
    let s = 0;
    for (let i = 0; i < kk; i++) s += Math.log(nn - i) - Math.log(i + 1);
    return s;
  };
  const pk = (kk: number): number => Math.exp(logC(n, kk) + n * Math.log(0.5));
  const obs = pk(Math.min(b, c));
  let p = 0;
  for (let kk = 0; kk <= n; kk++) if (pk(kk) <= obs * (1 + 1e-9)) p += pk(kk);
  return Math.min(1, p);
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--holdout") ? "holdout" : "grid";
  const vault = new Vault(VAULT);
  await vault.init();
  const { selection, holdout } = parts();

  if (mode === "grid") {
    console.log(`GRID auf der SELECTION (${selection.length} Faelle) — Holdout wird NICHT angefasst`);
    const results: { boost: number; conf: number; r3: number; r1: number; cues: number }[] = [];
    for (const conf of [0, 0.25, 0.5]) {
      const proj = projectionAt(conf, vault);
      for (const boost of [2, 4, 8]) {
        const search = new SearchIndex(vault, { projection: proj, boost });
        search.start();
        const done = await attach(vault, search);
        const rows = await score(selection, search);
        await done();
        results.push({ boost, conf, r3: at(rows, 3), r1: at(rows, 1), cues: proj.accepted });
        console.log(`  conf=${conf} boost=${boost}  R@1=${pct(at(rows, 1))}  R@3=${pct(at(rows, 3))}  (${proj.accepted} cues)`);
      }
    }
    // Baseline without cues, for orientation only — still selection-only.
    const base = new SearchIndex(vault);
    base.start();
    const doneB = await attach(vault, base);
    const rowsB = await score(selection, base);
    await doneB();
    console.log(`  OHNE Cues            R@1=${pct(at(rowsB, 1))}  R@3=${pct(at(rowsB, 3))}`);
    results.sort((a, b) => b.r3 - a.r3 || b.r1 - a.r1 || a.boost - b.boost);
    console.log(`\nBESTE KOMBINATION: boost=${results[0].boost} conf=${results[0].conf} (R@3 ${pct(results[0].r3)})`);
    writeFileSync(join(homedir(), ".bastra", "eval-cues", "grid.json"),
      JSON.stringify({ selection_n: selection.length, baseline_r3: at(rowsB, 3), results }, null, 2) + "\n", { mode: 0o600 });
    return;
  }

  const boost = Number(process.env.OB_BOOST), conf = Number(process.env.OB_CONF);
  if (!Number.isFinite(boost) || !Number.isFinite(conf)) throw new Error("OB_BOOST and OB_CONF are required for --holdout");
  console.log(`HOLDOUT (${holdout.length} Faelle), fixiert: boost=${boost} conf=${conf}`);

  const proj = projectionAt(conf, vault);
  const withCues = new SearchIndex(vault, { projection: proj, boost });
  withCues.start();
  let done = await attach(vault, withCues);
  const rowsWith = await score(holdout, withCues);
  await done();

  const without = new SearchIndex(vault);
  without.start();
  done = await attach(vault, without);
  const rowsWithout = await score(holdout, without);
  await done();

  const byId = new Map(rowsWithout.map((r) => [r.id, r]));
  let b = 0, c = 0;
  for (const w of rowsWith) {
    const o = byId.get(w.id)!;
    const hw = w.rank >= 1 && w.rank <= 3, ho = o.rank >= 1 && o.rank <= 3;
    if (hw && !ho) b++; else if (!hw && ho) c++;
  }
  const n = holdout.length;
  const d = at(rowsWith, 3) - at(rowsWithout, 3);
  const out = {
    n, boost, confidence: conf, cues_in_projection: proj.accepted,
    with_cues: { r1: at(rowsWith, 1), r3: at(rowsWith, 3), r10: at(rowsWith, K), mrr: mrr(rowsWith),
      unanchored: rowsWith.filter((r) => !r.anchored && r.hits > 0).length },
    without_cues: { r1: at(rowsWithout, 1), r3: at(rowsWithout, 3), r10: at(rowsWithout, K), mrr: mrr(rowsWithout),
      unanchored: rowsWithout.filter((r) => !r.anchored && r.hits > 0).length },
    paired: { discordant_b_only_cues: b, discordant_c_only_baseline: c, delta_r3: d,
      delta_ci_95: [wilson(b, n)[0] - wilson(c, n)[1], wilson(b, n)[1] - wilson(c, n)[0]],
      mcnemar_exact_p: mcnemarExact(b, c) },
  };
  console.log(JSON.stringify(out, null, 2));

  const runDate = new Date().toISOString();
  const short = createHash("sha256").update(JSON.stringify(out) + runDate).digest("hex").slice(0, 12);
  const dir = join(homedir(), ".bastra", "eval-runs", `${runDate.slice(0, 10)}-${short}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const w = (f: string, s: string): void => writeFileSync(join(dir, f), s, { mode: 0o600 });
  w("results.json", JSON.stringify({ ...out, rows_with: rowsWith, rows_without: rowsWithout }, null, 2) + "\n");
  w("manifest.json", JSON.stringify({
    run_date: runDate, vault_path: VAULT, vault_size: vault.size(),
    provider: "Hybrid (BM25 + Vector RRF) · ollama-embeddinggemma",
    experiment: "OB pre-question — descriptive_entity batch cues vs none. EXPLORATIVE, not the registered design-A run.",
    command: `OB_BOOST=${boost} OB_CONF=${conf} tsx cue-ob-tmp.ts --holdout`,
    split: { seed: 20260828, selection_share: 0.3, stratify_by: ["origin_type", "lang"], pool: "descriptive answerable" },
  }, null, 2) + "\n");
  w("command.txt", `OB_BOOST=${boost} OB_CONF=${conf} tsx cue-ob-tmp.ts --holdout\n`);
  w("stdout.txt", ""); w("stderr.txt", "");
  console.log(`\nrun artifact: ${dir}`);
}

main().catch((e: Error) => { console.error(`FATAL: ${e.message}`); process.exit(1); });
