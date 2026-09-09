#!/usr/bin/env tsx
/**
 * Is the gold even IN the pool? The question that sits underneath #501.
 *
 * #103 and #118 concluded that the remaining deficit is mis-ranking rather than
 * missing recall, and #501 is built on that conclusion: a cross-encoder can
 * reorder a pool, and nothing else. **It cannot retrieve.** So the honest
 * ceiling on everything #501 can achieve is the share of cases whose gold is in
 * the candidate pool at all — and if that share is low, the answer to the
 * mis-ranking finding is not "sort better", it is "get it into the pool first".
 * That would be a statement about retrieval, not about ranking, and it holds
 * whichever way #501 comes out.
 *
 * This runs the same production path the replay does — `recallHybrid` behind
 * `gatedHybridRecaller` — and loads **one gold file at a time**, so every case
 * keeps its provenance. That matters: an early diagnostic over eight
 * `gold-blind` cases found five whose gold was nowhere in the 40-deep pool, and
 * `gold-blind` is one set of twelve and plausibly the hardest. Per file and
 * total is what separates "a property of the blind set" from "a property of our
 * retrieval".
 *
 * No cross-encoder, no scoring, no model of any kind: this measures retrieval.
 *
 *   BASTRA_VAULT_PATH=/path/to/vault npx tsx src/rerank-pool-coverage.ts \
 *     --gold-dir ~/.bastra/eval-goldset --out /tmp/coverage.json
 */
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SearchIndex, Vault } from "@bastra-recall/core";
import type { RecallHit } from "@bastra-recall/core";
import { loadGoldFiles } from "./goldset-dataset.js";
import { PRODUCTION_K, SCORE_FLOOR, attachHybrid, gatedHybridRecaller } from "./goldset-run.js";
import { partitionCases } from "./rerank-replay.js";

/** The depths reported. 40 is `HOP_SEED_POOL` — the whole pool a rerank sees. */
const DEPTHS = [1, 3, 5, 10, 20, 30, 40] as const;

interface FileCoverage {
  file: string;
  /** How the file splits across the C-051/C-057 cue axis. */
  kinds?: Record<string, number>;
  cases: number;
  /** Share whose first expected id sits at or above each depth IN THE POOL. */
  in_pool_at: Record<string, number>;
  /** Same at the SERVED depth, after slice(k) and the score floor. */
  served_at_3: number;
  served_at_10: number;
  /** Cases whose gold is nowhere in the pool — the part no reranker can reach. */
  absent_from_pool: number;
  median_pool_size: number;
}

function share(xs: readonly number[], pred: (x: number) => boolean): number {
  return xs.length === 0 ? 0 : xs.filter(pred).length / xs.length;
}

async function main(): Promise<void> {
  let goldDir = join(process.env.HOME ?? "", ".bastra", "eval-goldset");
  let out: string | null = null;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--gold-dir") goldDir = argv[++i];
    else if (argv[i] === "--out") out = argv[++i];
    else throw new Error(`unknown flag: ${argv[i]}`);
  }
  const vaultPath = process.env.BASTRA_VAULT_PATH;
  if (!vaultPath) throw new Error("BASTRA_VAULT_PATH is required");

  const vault = new Vault(vaultPath);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const arm = await attachHybrid(vault, search, vaultPath);
  console.error(`[pool-coverage] ${arm.label}`);

  const files = readdirSync(goldDir).filter((f) => f.startsWith("gold-") && f.endsWith(".json")).sort();
  const perFile: FileCoverage[] = [];
  const allRanks: number[] = [];
  const allByKind: Record<string, number[]> = {};
  const allServed3: boolean[] = [];
  const allServed10: boolean[] = [];

  for (const file of files) {
    const { cases } = loadGoldFiles([join(goldDir, file)]);
    const answerable = partitionCases(cases).answerable;
    const ranks: number[] = [];
    const served3: boolean[] = [];
    const served10: boolean[] = [];
    const sizes: number[] = [];
    const kinds: Record<string, number> = {};
    const byKindRanks: Record<string, number[]> = {};
    for (const c of answerable) {
      let pool: RecallHit[] = [];
      const recall = gatedHybridRecaller((q, o) =>
        search.recallHybrid(q, { ...o, onCandidatePool: (p) => { pool = p; } }),
      );
      await recall(c.query, c.id);
      const exp = new Set(c.expected_ids);
      // 0 means "nowhere in the pool" — kept as 0 rather than Infinity so the
      // JSON stays readable, and every predicate below tests `r >= 1` first.
      const rank = pool.findIndex((h) => exp.has(h.id)) + 1;
      ranks.push(rank);
      sizes.push(pool.length);
      kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
      (byKindRanks[c.kind] ??= []).push(rank);
      (allByKind[c.kind] ??= []).push(rank);
      const servedIds = pool.slice(0, PRODUCTION_K).filter((h) => h.score >= SCORE_FLOOR).map((h) => h.id);
      const sRank = servedIds.findIndex((id) => exp.has(id)) + 1;
      served3.push(sRank >= 1 && sRank <= 3);
      served10.push(sRank >= 1);
    }
    const sorted = [...sizes].sort((a, b) => a - b);
    perFile.push({
      file,
      kinds,
      cases: answerable.length,
      in_pool_at: Object.fromEntries(DEPTHS.map((d) => [`@${d}`, share(ranks, (r) => r >= 1 && r <= d)])),
      served_at_3: share(served3.map((b) => (b ? 1 : 0)), (x) => x === 1),
      served_at_10: share(served10.map((b) => (b ? 1 : 0)), (x) => x === 1),
      absent_from_pool: ranks.filter((r) => r === 0).length,
      median_pool_size: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    });
    allRanks.push(...ranks);
    allServed3.push(...served3);
    allServed10.push(...served10);
    process.stderr.write(`[pool-coverage] ${file}: ${answerable.length} cases\n`);
  }

  // The split that decides how the ceiling reads. `associative` cases are
  // authored so no term of the incident report survives in the query — a
  // measured property of the data (4 % lexical overlap against 65 %), not a
  // retrieval defect. One mixed denominator hides that.
  const byKind = Object.fromEntries(
    Object.entries(allByKind).map(([k, rs]) => [
      k,
      {
        cases: rs.length,
        in_pool_at: Object.fromEntries(DEPTHS.map((d) => [`@${d}`, share(rs, (r) => r >= 1 && r <= d)])),
        absent_from_pool: rs.filter((r) => r === 0).length,
      },
    ]),
  );

  const total = {
    cases: allRanks.length,
    by_kind: byKind,
    in_pool_at: Object.fromEntries(DEPTHS.map((d) => [`@${d}`, share(allRanks, (r) => r >= 1 && r <= d)])),
    served_at_3: share(allServed3.map((b) => (b ? 1 : 0)), (x) => x === 1),
    served_at_10: share(allServed10.map((b) => (b ? 1 : 0)), (x) => x === 1),
    absent_from_pool: allRanks.filter((r) => r === 0).length,
  };

  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const L: string[] = ["", "  Pool coverage — the ceiling on anything a reranker can do.", ""];
  L.push(`  ${"file".padEnd(24)} | ${"n".padStart(4)} | ${DEPTHS.map((d) => `@${d}`.padStart(6)).join(" |")} | absent | served@3`);
  for (const f of [...perFile, { ...total, file: "TOTAL", median_pool_size: 0 } as FileCoverage]) {
    L.push(
      `  ${f.file.padEnd(24)} | ${String(f.cases).padStart(4)} | ` +
        `${DEPTHS.map((d) => pct(f.in_pool_at[`@${d}`]).padStart(6)).join(" |")} | ` +
        `${String(f.absent_from_pool).padStart(6)} | ${pct(f.served_at_3)}`,
    );
  }
  L.push("");
  L.push("  By cue axis — associative sets are authored to share no vocabulary with their target:");
  for (const [k, v] of Object.entries(byKind)) {
    L.push(
      `    ${k.padEnd(14)} n=${String(v.cases).padStart(4)} | ` +
        `${DEPTHS.map((d) => pct(v.in_pool_at[`@${d}`]).padStart(6)).join(" |")} | absent ${v.absent_from_pool}`,
    );
  }
  L.push("");
  L.push(`  ${total.absent_from_pool} of ${total.cases} cases have NO expected id anywhere in the 40-deep pool.`);
  L.push("  No reranker can reach those: it reorders a pool, it cannot retrieve.");
  L.push("");
  console.log(L.join("\n"));

  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ issue: 501, note: "retrieval only — no cross-encoder involved", production_k: PRODUCTION_K, score_floor: SCORE_FLOOR, per_file: perFile, total }, null, 2) + "\n", { mode: 0o600 });
    console.error(`[pool-coverage] wrote ${out}`);
  }

  await arm.cleanup();
  search.stop();
  await vault.stop();
}

if (import.meta.filename === process.argv[1]) {
  main().catch((e: Error) => {
    console.error(`[pool-coverage] FATAL: ${e.message}`);
    process.exit(1);
  });
}
