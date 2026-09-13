#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { extractReviewedMissChains, type RecallCallStats } from "../src/learned-recall/reviewed-miss-harvest.js";
import {
  loadTelemetryPools,
  observeChain,
  parseReviewerLabels,
  snapshotVault,
  type ObservationEngines,
} from "../src/learned-recall/reviewed-miss-engines.js";
import { deriveCueProposals, type HarvestAccounting, type ObservedPair } from "../src/learned-recall/reviewed-miss-cues.js";
import { REVIEWED_MISS_CLASSES, type ReviewedMissClassification } from "../src/learned-recall/reviewed-miss-observation.js";

const FLAGS_WITH_VALUE = new Set(["--out", "--events", "--vault", "--labels", "--proposals"]);

function usage(): never {
  console.error([
    "usage: tsx scripts/harvest-reviewed-misses.ts [--events DIR] [--vault DIR] [--labels FILE]",
    "         [--out queue.json] [--proposals FILE] session.jsonl [...]",
    "",
    "  --events DIR      daemon telemetry dir (events-*.jsonl): joins the frozen pool by recall_id",
    "  --vault DIR       vault root: snapshot for membership proofs; never written",
    "  --labels FILE     reviewer labels, one JSON object per line: {\"ref\": \"sha256:…\", \"durable\": true}",
    "  --out FILE        write the hashed queue (ledger) here instead of stdout",
    "  --proposals FILE  write cue proposals here; carries CLEAR memory ids, keep it local",
    "",
    "The accounting report is one JSON line on stderr.",
  ].join("\n"));
  process.exit(2);
}

type ValueFlag = "out" | "events" | "vault" | "labels" | "proposals";

interface Args extends Record<ValueFlag, string | null> {
  inputs: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: null, events: null, vault: null, labels: null, proposals: null, inputs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (FLAGS_WITH_VALUE.has(arg)) {
      const value = argv[index + 1];
      if (!value) usage();
      args[arg.slice(2) as ValueFlag] = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      usage();
    } else {
      args.inputs.push(arg);
    }
  }
  if (args.inputs.length === 0) usage();
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const engines: ObservationEngines = {
    pools: args.events ? await loadTelemetryPools(args.events) : null,
    vaultRoot: args.vault ? resolve(args.vault) : null,
    snapshot: args.vault ? await snapshotVault(args.vault) : null,
    labels: args.labels ? parseReviewerLabels(await readFile(args.labels, "utf8")) : new Map(),
  };
  const stats: RecallCallStats = { recalls: 0, withRecallId: 0 };
  const pairs: ObservedPair[] = (await Promise.all(args.inputs.map(async (input) =>
    extractReviewedMissChains(await readFile(input, "utf8"), basename(resolve(input)), stats)
      .map((chain) => ({ chain, record: observeChain(chain, engines) })),
  ))).flat();
  const records = pairs.map((pair) => pair.record);
  const proposals = deriveCueProposals(pairs, engines);

  // Accounting names what was absent, so "0 misses" and "no engine given"
  // never look alike. It goes to stderr; stdout stays the queue.
  const byClass = Object.fromEntries(REVIEWED_MISS_CLASSES.map((cls) => [cls, 0])) as Record<ReviewedMissClassification, number>;
  for (const record of records) byClass[record.classification] += 1;
  const report: HarvestAccounting = {
    kind: "reviewed-miss-harvest-report/v1",
    sessions: args.inputs.length,
    recalls: stats.recalls,
    recalls_with_recall_id: stats.withRecallId,
    chains: records.length,
    joined_to_telemetry: records.filter((record) => record.observation.pool !== null).length,
    explicit_misses: records.filter((record) => record.status === "candidate").length,
    by_class: byClass,
    proposals: {
      targets: proposals.length,
      episodes: proposals.reduce((n, p) => n + p.episodes.length, 0),
      max_support: proposals.reduce((n, p) => Math.max(n, p.support), 0),
    },
    engines: {
      pool_join: args.events ? `telemetry-dir (${engines.pools?.size ?? 0} pools)` : "absent",
      vault_snapshot: args.vault ? `snapshot (${engines.snapshot?.idCount ?? 0} ids)` : "absent",
      reviewer_labels: args.labels ? `${engines.labels.size} labels` : "absent",
    },
  };
  console.error(JSON.stringify(report));

  if (args.proposals) await writeFile(args.proposals, JSON.stringify(proposals, null, 2) + "\n", "utf8");
  const rendered = JSON.stringify(records, null, 2) + "\n";
  if (args.out) await writeFile(args.out, rendered, "utf8");
  else process.stdout.write(rendered);
}

void main();
