/**
 * Trigger collisions in the EXISTING vault — the stock-take #289 asks for.
 *
 * `save-quality.ts` answers one question at write time: does this NEW trigger
 * name a situation another memory already declares? Nobody has ever asked the
 * same question of the stock. #289: "Welche der vorhandenen Memories tragen
 * Trigger, die nichts mehr unterscheiden? Die Zahl ist unbekannt, und sie
 * wächst mit jedem Save, der den Malus wegklickt."
 *
 * WHY THIS IS ONLY NOW WORTH MEASURING: before #300 the collision verdict ran
 * on retrieval, and an absolute cut on a raw BM25 score decided nothing — the
 * word "collision" had become a synonym for "the admitted pool" (a median 69%
 * of it, firing on 97% of scans). A stock-take then would have counted noise.
 * #300 moved the verdict to containment between two AUTHORED phrases and the
 * false-alarm rate against verbatim-duplicate ground truth fell from 90.4% to
 * 0.9%. The number this script prints means something because that happened
 * first — see the comment block at `daemon/src/save-quality.ts:350-375`.
 *
 * WHAT THIS IS NOT: not a recall measurement. A trigger that collides is a
 * trigger that fails to DISCRIMINATE, which is a necessary condition for bad
 * ranking, not a sufficient one. The lift this predicts (recall@5 0.457 ->
 * 0.565, measured under #238 on a vault whose triggers were summary copies) is
 * an argument for the cleanup, not a result of it. Nothing here rewrites
 * anything: `recall_when` is authoring work and stays the human's (#289/3).
 *
 * WHAT THE NUMBER IS A FLOOR OF — two exclusions, both structural:
 *
 *  1. The verdict is FULL containment. `TRIGGER_CLAIMS_SITUATION_MIN` is
 *     exactly 1 (`save-similarity.ts:195`): every content word of this trigger
 *     must appear in the other one. A paraphrase that means the same thing and
 *     shares 83% of its words is not counted here — that band is #325's open
 *     question, and it has no gold set yet. So this reports the collisions
 *     nobody can argue about, not all of them.
 *  2. Collisions are scope×type-local. `admittedPool` filters on
 *     `scope === input.scope && type === input.type` (`save-quality.ts:338`),
 *     so the same phrase on a `lesson` and on a `project-fact` never collides,
 *     however identical. That mirrors what `recall` can retrieve, which is the
 *     right frame for a write-time advisory and a real ceiling on a stock-take.
 *
 * Requires the daemon to be built (`npm run build -w @bastra-recall/daemon`):
 * `scoreSaveQuality` is read from `daemon/dist` at runtime.
 *
 *   BASTRA_VAULT_PATH=~/vault npx tsx src/trigger-collisions.ts --out stock.json
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { Vault, SearchIndex } from "@bastra-recall/core";

/** The slice of `SaveQualityResult` this harness reads. Declared rather than
 *  imported: `@bastra-recall/eval` depends on `core` only, and pulling the
 *  daemon into eval's dependency graph for one function is the larger evil —
 *  the same trade `absence-honesty.ts:49` documents. `bridge-transfer.ts:93`
 *  established the dynamic-import-from-dist shape used below. */
interface TriggerCollision {
  trigger: string;
  count: number;
  examples: string[];
  claim?: string;
  at_least?: boolean;
  admitted_pool: number;
}
interface SaveQualityResult {
  score: number;
  band: string;
  issues: string[];
  trigger_collisions: TriggerCollision[];
}
interface SaveQualityModule {
  scoreSaveQuality: (deps: unknown, input: unknown, excludeId: string) => SaveQualityResult;
}

const daemonDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../daemon/dist");
const { scoreSaveQuality } = (await import(
  path.join(daemonDist, "save-quality.js")
)) as SaveQualityModule;

interface Row {
  id: string;
  scope: string;
  type: string;
  score: number;
  trigger_count: number;
  /** Per trigger: how many OTHER memories already declare the same situation. */
  collisions: Array<{ trigger: string; count: number; pool: number; at_least: boolean }>;
}

/** Scopes whose `recall_when` is written by the import pipeline rather than by
 *  a person. Their collisions are real but they are a generator's problem, and
 *  #289 is about the authored stock. */
const IMPORTED_SCOPES = new Set(["documents", "bookmarks"]);

function pct(a: number, b: number): string {
  return b === 0 ? "  n/a" : `${((100 * a) / b).toFixed(1)}%`;
}

function median(xs: number[]): number {
  return xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (n: string, d: string): string => {
    const i = argv.indexOf(n);
    return i === -1 ? d : (argv[i + 1] ?? d);
  };
  const outPath = arg("--out", "");
  const limit = Number.parseInt(arg("--n", "0"), 10);
  const vaultRoot = (process.env.BASTRA_VAULT_PATH ?? arg("--vault", "")).replace(/^~/, os.homedir());
  if (!vaultRoot) {
    console.error("FATAL: set BASTRA_VAULT_PATH or pass --vault <path>");
    process.exit(2);
  }

  const vault = new Vault(vaultRoot);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  // No embeddings on purpose. The collision scan calls `search.recall(...)`,
  // which is the BM25 arm — #300 demoted it to the candidate generator, and the
  // verdict is a containment test between authored phrases. Waiting on Ollama
  // here would measure nothing extra and would put an hour between the question
  // and the answer.
  const deps = { vault, search, vaultPath: vaultRoot, telemetry: null } as unknown;

  const memories = vault.list();
  const subset = limit > 0 ? memories.slice(0, limit) : memories;
  console.error(`vault ${memories.length} memories, scanning ${subset.length}`);

  const rows: Row[] = [];
  let done = 0;
  for (const m of subset) {
    const fm = m.fm;
    const triggers = fm.recall_when ?? [];
    // A memory with no triggers cannot collide, but it is not healthy either —
    // counted separately below rather than silently skipped.
    const input = {
      title: fm.title ?? fm.id,
      summary: fm.summary ?? "",
      body: (m as { body?: string }).body ?? "",
      type: fm.type,
      scope: fm.scope,
      tags: fm.tags ?? [],
      topic_path: fm.topic_path ?? [],
      recall_when: triggers,
    };
    // The memory is already IN the vault, so it finds itself as its own perfect
    // duplicate unless excluded — the exact trap `save-quality.ts:149` documents
    // for the overwrite path.
    const result = scoreSaveQuality(deps, input, fm.id);
    rows.push({
      id: fm.id,
      scope: fm.scope,
      type: fm.type,
      score: result.score,
      trigger_count: triggers.length,
      collisions: (result.trigger_collisions ?? []).map((c) => ({
        trigger: c.trigger,
        count: c.count,
        pool: c.admitted_pool,
        at_least: c.at_least === true,
      })),
    });
    if (++done % 25 === 0) process.stderr.write(`\rscored ${done}/${subset.length}`);
  }
  process.stderr.write(`\rscored ${done}/${subset.length}\n`);

  // ── The stock-take ────────────────────────────────────────────────────────
  const withTriggers = rows.filter((r) => r.trigger_count > 0);
  const noTriggers = rows.length - withTriggers.length;
  const colliding = withTriggers.filter((r) => r.collisions.length > 0);
  const allTriggers = withTriggers.reduce((n, r) => n + r.trigger_count, 0);
  const allCollisions = withTriggers.reduce((n, r) => n + r.collisions.length, 0);

  console.log(`\n── stock-take over ${rows.length} memories ──`);
  console.log(`  memories with at least one colliding trigger  ${pct(colliding.length, withTriggers.length).padStart(6)}  (${colliding.length}/${withTriggers.length})`);
  console.log(`  triggers that collide                         ${pct(allCollisions, allTriggers).padStart(6)}  (${allCollisions}/${allTriggers})`);
  if (noTriggers > 0) console.log(`  memories with NO recall_when at all            ${noTriggers}`);

  // #289 is explicitly about hand-written triggers ("die Qualität der von Hand
  // geschriebenen Trigger im vorhandenen Bestand"). Imported documents and
  // bookmarks carry triggers a generator wrote, and they collide for a
  // different reason with a different fix — pooling the two reports a number
  // that describes neither, the same trap the band harness hit at #338.
  const authored = withTriggers.filter((r) => !IMPORTED_SCOPES.has(r.scope));
  const imported = withTriggers.filter((r) => IMPORTED_SCOPES.has(r.scope));
  const authoredColliding = authored.filter((r) => r.collisions.length > 0);
  const importedColliding = imported.filter((r) => r.collisions.length > 0);
  console.log(`\n  split by who wrote the trigger:`);
  console.log(`    authored (the #289 question)  ${pct(authoredColliding.length, authored.length).padStart(6)}  (${authoredColliding.length}/${authored.length})`);
  console.log(`    imported/generated            ${pct(importedColliding.length, imported.length).padStart(6)}  (${importedColliding.length}/${imported.length})`);

  // How hard do they collide? A trigger matching one other memory is a note; one
  // matching most of its pool is the #289 finding. Reported as a distribution,
  // because a mean over these two would describe neither.
  const shares = colliding.flatMap((r) => r.collisions.map((c) => (c.pool > 0 ? c.count / c.pool : 0)));
  const bands = [
    { label: "1 other memory        ", hit: (c: { count: number }) => c.count === 1 },
    { label: "2-4 others            ", hit: (c: { count: number }) => c.count >= 2 && c.count <= 4 },
    { label: "5+ others             ", hit: (c: { count: number }) => c.count >= 5 },
    { label: "over half of its pool ", hit: (c: { count: number; pool: number }) => c.pool > 0 && c.count > c.pool / 2 },
  ];
  const flat = colliding.flatMap((r) => r.collisions);
  console.log(`\n  colliding triggers by reach (${flat.length} total):`);
  for (const b of bands) {
    console.log(`    ${b.label} ${pct(flat.filter(b.hit).length, flat.length).padStart(6)}  (${flat.filter(b.hit).length})`);
  }
  console.log(`  median share of pool touched: ${(100 * median(shares)).toFixed(1)}%`);

  // Score distribution — #289's claim was that the malus is a permanent state.
  const scores = rows.map((r) => r.score);
  console.log(`\n  save-quality score: median ${median(scores)}, min ${Math.min(...scores)}, max ${Math.max(...scores)}`);
  for (const [label, lo, hi] of [["90-100", 90, 100], ["70-89", 70, 89], ["below 70", 0, 69]] as const) {
    console.log(`    ${String(label).padEnd(9)} ${pct(scores.filter((s) => s >= lo && s <= hi).length, scores.length).padStart(6)}`);
  }

  // The worst offenders, which is what a cleanup run would work from. Grouped by
  // trigger TEXT: one generated phrase shared by fifteen imported documents is
  // one thing to fix, not fifteen findings — listing it fifteen times reads as
  // fifteen problems and buries everything below it.
  const byTrigger = new Map<string, { count: number; pool: number; memories: number; at_least: boolean }>();
  for (const c of flat) {
    const e = byTrigger.get(c.trigger) ?? { count: c.count, pool: c.pool, memories: 0, at_least: c.at_least };
    e.memories += 1;
    e.count = Math.max(e.count, c.count);
    byTrigger.set(c.trigger, e);
  }
  const worst = [...byTrigger.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 15);
  if (worst.length > 0) {
    console.log(`\n  widest triggers (${byTrigger.size} distinct phrases behind ${flat.length} collisions):`);
    for (const [trigger, e] of worst) {
      const carried = e.memories > 1 ? `  [carried by ${e.memories} memories]` : "";
      console.log(`    ${e.at_least ? ">=" : "  "}${String(e.count).padStart(3)} of ${String(e.pool).padStart(3)}   "${trigger}"${carried}`);
    }
  }

  // Which scopes carry it — a cleanup has to start somewhere.
  const byScope = new Map<string, { n: number; colliding: number }>();
  for (const r of withTriggers) {
    const e = byScope.get(r.scope) ?? { n: 0, colliding: 0 };
    e.n += 1;
    if (r.collisions.length > 0) e.colliding += 1;
    byScope.set(r.scope, e);
  }
  console.log(`\n  by scope (memories with >=1 colliding trigger):`);
  for (const [scope, e] of [...byScope.entries()].sort((a, b) => b[1].colliding - a[1].colliding)) {
    console.log(`    ${scope.padEnd(18)} ${pct(e.colliding, e.n).padStart(6)}  (${e.colliding}/${e.n})`);
  }

  // #289: the same split by type. The pool is scope×type-local, so the type is
  // the other half of the question — a scope can look bad only because one
  // type inside it does.
  const byType = new Map<string, { n: number; colliding: number }>();
  for (const r of withTriggers) {
    const e = byType.get(r.type) ?? { n: 0, colliding: 0 };
    e.n += 1;
    if (r.collisions.length > 0) e.colliding += 1;
    byType.set(r.type, e);
  }
  console.log(`\n  by type (memories with >=1 colliding trigger):`);
  for (const [type, e] of [...byType.entries()].sort((a, b) => b[1].colliding - a[1].colliding)) {
    console.log(`    ${type.padEnd(18)} ${pct(e.colliding, e.n).padStart(6)}  (${e.colliding}/${e.n})`);
  }

  search.stop();
  await vault.stop();
  if (outPath) {
    await fs.writeFile(outPath, JSON.stringify({ vault_size: rows.length, rows }, null, 2));
    console.error(`\nwrote ${outPath}`);
  }
}

void main();
