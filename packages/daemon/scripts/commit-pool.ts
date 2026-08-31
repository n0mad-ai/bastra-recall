/**
 * commit-pool.ts — the #135 corpus-commitment clause for the #129 contribution gate.
 *
 * Run it two ways:
 *   npx tsx packages/daemon/scripts/commit-pool.ts            # commit YOUR real #121 log (Tier B)
 *   npx tsx packages/daemon/scripts/commit-pool.ts --days 7   #   ...last 7 days
 *   npx tsx packages/daemon/scripts/commit-pool.ts --synthetic # the leak/closure PROOF (Tier A)
 *
 * ── Why this exists ────────────────────────────────────────────────────────────────────────
 * #129/#131 certify that a harvested bridge lifts the OUT-OF-POOL far slice (real transfer, not
 * in-pool reorder), drawing the held-out split from the #121 candidate-pool log. #135 names a leak
 * one level UNDER the split: the held-out set is sampled FROM that log, but the log is produced by
 * the SAME side that mints the bridge. A net-harmful bridge (+far / -near) is rejected only if its
 * near-regressions are IN the log to be sampled. Omit those queries before scoring and the held-out
 * set can't contain what it never saw — the bridge shows pure far-lift, no visible regression, and
 * clears the gate. (#89 own-trigger circularity two layers up: the attested party authors the
 * evidence corpus it's judged on.)
 *
 * daniel confirmed the boundary (#135 reply): LOCALLY the leak can't fire — harvest.ts inherits log
 * membership from every recall, it never chooses it (extractCandidatePools reads ALL recall/
 * hook_recall events). The leak is born at `contribute`, where a FOREIGN bridge arrives carrying its
 * author's bookkeeping. So the closure is modeled at the trust boundary (--synthetic); the real log
 * only needs the commitment computed over it (default run).
 *
 * ── The commitment ─────────────────────────────────────────────────────────────────────────
 * Before any bridge is scored, COMMIT the candidate-pool log: a canonical hash, published + fixed
 * before eval. A contributed bridge ships {committedLogHash, foldMap, farLift, nearRegression}. The
 * recipient (a) verifies the shipped scores were computed against the committed log (re-hashes it),
 * and (b) RE-CHECKS the bridge on ITS OWN pool — so the verdict never trusts the contributor's
 * corpus, only re-runs the protocol against a corpus that can't have shifted after the fact, and
 * against the recipient's near slice the author cannot omit.
 *
 * ── Honest scope (load-bearing) ────────────────────────────────────────────────────────────
 *   • No empirical lift claim — protocol proposal. The deltas in --synthetic are ILLUSTRATIVE
 *     (the issue's +30-far/-50-near model as ±1 unit moves), not bastra magnitudes.
 *   • Tier A (--synthetic) validates the GATE LOGIC: that committing the log + recipient re-check
 *     removes the author's freedom to omit regressions. Tier B (real log) emits the commitment over
 *     your vault; it does NOT prove closure (one vault has no contribute boundary to leak across).
 *   • foldOf() is the #129 SPEC split (hash(query)→fold) — #129 is OPEN, the k-fold is not yet in
 *     core. This harness slots beside that spec; `contribute` stays unwired until both the split
 *     (#129/#131) and this commitment exist.
 *   • drand fold-seed is OUT of scope: the load-bearing leak is corpus MEMBERSHIP, not the seed
 *     (#135) — a clean drop-in at the same point later (Bellard: don't build the second instrument first).
 */
import { createHash } from "node:crypto";

import {
  defaultLogDir,
  extractCandidatePools,
  readEventLog,
  type CandidatePoolEntry,
} from "../src/learned-recall/harvest.js";

const N_FOLDS = 5;
const FAR_LIFT_MIN = 0; // a promotable bridge must show positive held-out far-lift
const NEAR_REG_MAX = 0; // ...and no net near-regression on the held-out near slice

// ── commitment primitive ──────────────────────────────────────────────────────────────────────

/**
 * Deterministic hash of the committed candidate-pool log. Canonical so committer and recipient hash
 * identically: queries sorted, each pool's ids sorted — the membership the leak turns on. Mirrors
 * the append-only discipline of core/src/audit-log.ts.
 */
export function canonicalLogHash(entries: CandidatePoolEntry[]): string {
  const lines = entries
    .map((e) => `${e.query}\t${e.pool.map((p) => p.id).sort().join(",")}`)
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** #129 SPEC split: hash(query) → fold. Deterministic, so the recipient re-derives the same split
 *  from the committed log without trusting the contributor's partition. (Not yet in core — #129 OPEN.) */
export function foldOf(query: string, nFolds = N_FOLDS): number {
  const h = createHash("sha256").update(query).digest();
  return h.readUInt32BE(0) % nFolds;
}

// ── modeled bridge + gate (Tier A, --synthetic) ─────────────────────────────────────────────────

type Kind = "far" | "near";
interface LabeledQuery { query: string; kind: Kind; }
interface Bridge { farLift: number; nearReg: number; }

/** Δ the bridge applies to a query's gold rank: <0 = rescued (good on far), >0 = buried (bad on near). */
function bridgeDelta(kind: Kind, b: Bridge): number {
  return kind === "far" ? -b.farLift : kind === "near" ? +b.nearReg : 0;
}

/** Score a bridge on the HELD-OUT fold of a log. The gate can only see regressions on near queries
 *  PRESENT in `log` — omit them and nearReg reads ~0. That is the whole leak. */
function scoreOnLog(log: LabeledQuery[], b: Bridge, heldOutFold: number): { farLift: number; nearReg: number } {
  const far: number[] = [], near: number[] = [];
  for (const { query, kind } of log) {
    if (foldOf(query) !== heldOutFold) continue;
    (kind === "far" ? far : near).push(bridgeDelta(kind, b));
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : 0);
  return { farLift: -mean(far), nearReg: mean(near) };
}

function promote(farLift: number, nearReg: number): boolean {
  return farLift > FAR_LIFT_MIN && nearReg <= NEAR_REG_MAX;
}

/** No commitment: author scores on the corpus THEY control (and can omit from). */
function naiveGate(authorLog: LabeledQuery[], b: Bridge, fold: number): boolean {
  const { farLift, nearReg } = scoreOnLog(authorLog, b, fold);
  return promote(farLift, nearReg);
}

/** #135: recipient verifies the committed-log hash, then RE-CHECKS on its own pool. The author's
 *  omission becomes non-load-bearing — the verdict never trusts the author's corpus. */
function committedGate(
  authorEntries: CandidatePoolEntry[],
  shippedHash: string,
  recipientLog: LabeledQuery[],
  b: Bridge,
  fold: number,
): boolean {
  if (canonicalLogHash(authorEntries) !== shippedHash) return false; // corpus shifted → reject outright
  const { farLift, nearReg } = scoreOnLog(recipientLog, b, fold);
  return promote(farLift, nearReg);
}

// ── Tier A: the three controls ──────────────────────────────────────────────────────────────────

function makeLog(nFar = 60, nNear = 60): LabeledQuery[] {
  return [
    ...Array.from({ length: nFar }, (_, i) => ({ query: `far${i}`, kind: "far" as Kind })),
    ...Array.from({ length: nNear }, (_, i) => ({ query: `near${i}`, kind: "near" as Kind })),
  ];
}

/** A LabeledQuery log carries no pool ids; for the hash we project it onto minimal CandidatePoolEntry. */
function asEntries(log: LabeledQuery[]): CandidatePoolEntry[] {
  // `scoreKind: null` is the honest value, not a placeholder: these entries are
  // projected from a synthetic label log, not read off a telemetry event, so
  // nothing has said which score space `topScore` lives in. It is also the
  // value that keeps the harvest behaving as it did while the field was merely
  // absent — only "bm25" is treated specially there.
  return log.map((q) => ({ query: q.query, pool: [{ id: q.query, score: 1 }], topScore: 1, scoreKind: null }));
}

function synthetic(): void {
  const fullLog = makeLog();
  const recipientLog = makeLog(); // recipient's own pool, same near coverage the author can't omit
  const fold = 0;

  const controls: Array<{ name: string; bridge: Bridge; expect: string }> = [
    { name: "positive (+far, 0 near)", bridge: { farLift: 1, nearReg: 0 }, expect: "PASS / PASS" },
    { name: "LEAK     (+far, -near) ", bridge: { farLift: 1, nearReg: 1 }, expect: "PASS / FAIL  <- leak closed" },
    { name: "null     ( 0 far, 0 near)", bridge: { farLift: 0, nearReg: 0 }, expect: "FAIL / FAIL" },
  ];

  console.log("control                     | naive | committed | what should happen");
  console.log("-".repeat(78));
  for (const { name, bridge, expect } of controls) {
    // ATTACK: for the harmful bridge the author OMITS its near-regression queries before scoring.
    const authorLog = bridge.nearReg > 0 ? fullLog.filter((q) => q.kind !== "near") : fullLog;
    const shippedHash = canonicalLogHash(asEntries(authorLog));

    const naive = naiveGate(authorLog, bridge, fold);
    const committed = committedGate(asEntries(authorLog), shippedHash, recipientLog, bridge, fold);
    const cell = (b: boolean, w: number) => (b ? "PASS" : "FAIL").padEnd(w);
    console.log(`${name.padEnd(27)}| ${cell(naive, 5)} | ${cell(committed, 9)} | ${expect}`);
  }
  console.log(
    "\nThe commitment flips exactly the harmful-bridge verdict (naive PASS → committed FAIL) and\n" +
      "leaves positive + null unchanged. Magnitudes illustrative; the claim is the discrimination,\n" +
      "not the number. Tier B = real reaches + #121 log on a production vault.",
  );
}

// ── Tier B: commit the real #121 log ────────────────────────────────────────────────────────────

async function commitRealLog(days: number | null): Promise<void> {
  const events = await readEventLog(defaultLogDir(), days);
  const entries = extractCandidatePools(events);
  if (entries.length === 0) {
    console.log("no #121 candidate-pool entries found in the log — nothing to commit.");
    console.log("(run some recalls so the daemon emits candidate_pool, or check BASTRA_LOG_PATH.)");
    return;
  }
  const hash = canonicalLogHash(entries);
  const folds = new Array(N_FOLDS).fill(0);
  for (const e of entries) folds[foldOf(e.query)]++;

  console.log(`committed candidate-pool log: ${entries.length} entries${days ? ` (last ${days}d)` : ""}`);
  console.log(`committedLogHash (sha256): ${hash}`);
  console.log(`fold distribution (hash(query)%${N_FOLDS}): [${folds.join(", ")}]`);
  console.log(
    "\nThis is the artifact you publish BEFORE scoring a bridge. A contributed bridge then ships\n" +
      "{committedLogHash, foldMap, farLift, nearRegression}; the recipient re-hashes this log and\n" +
      "re-checks the bridge on its own pool. Closure is proven at the trust boundary — run\n" +
      "--synthetic for that; a single vault has no contribute boundary to leak across.",
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--synthetic")) {
    synthetic();
    return;
  }
  const di = argv.indexOf("--days");
  const days = di >= 0 && argv[di + 1] ? parseInt(argv[di + 1], 10) : null;
  await commitRealLog(days);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
