#!/usr/bin/env node
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { hash } from "../src/learned-recall/reviewed-miss-harvest.js";
import {
  loadTelemetry,
  parseReviewerLabels,
  snapshotVault,
  telemetryFiles,
  type ObservationEngines,
  type Telemetry,
} from "../src/learned-recall/reviewed-miss-engines.js";
import {
  countClasses,
  dens,
  emptyClassCounts,
  liveClasses,
  observeLanes,
  poolsByLane,
  specimensOf,
  thinClasses,
  type EvidenceReport,
} from "../src/learned-recall/reviewed-miss-evidence.js";

const FLAGS_WITH_VALUE = new Set(["--out", "--events", "--vault", "--labels", "--proposals", "--evidence", "--hub-sessions", "--since", "--specimens"]);
const FLAGS_BARE = new Set(["--hook-lane"]);

function usage(): never {
  console.error([
    "usage: tsx scripts/harvest-reviewed-misses.ts [--events DIR] [--vault DIR] [--labels FILE] [--hook-lane]",
    "         [--out queue.json] [--proposals FILE] [--evidence FILE] [--hub-sessions N] [session.jsonl ...]",
    "",
    "  --events DIR      daemon telemetry dir (events-*.jsonl): joins the frozen pool by recall_id",
    "  --vault DIR       vault root: snapshot for membership proofs; never written",
    "  --labels FILE     reviewer labels, one JSON object per line: {\"ref\": \"sha256:…\", \"durable\": true}",
    "  --hook-lane       also observe the hook lane from telemetry alone (needs --events and --vault)",
    "  --out FILE        write the hashed queue (ledger) here instead of stdout",
    "  --proposals FILE  write cue proposals here; carries CLEAR memory ids, keep it local",
    "  --evidence FILE   write heatmap and hot paths here; carries CLEAR memory ids, keep it local",
    "  --hub-sessions N  distinct sessions above which a memory counts as a hub (default 3)",
    "  --since DAYS      only telemetry events younger than DAYS (default: all files in the dir)",
    "  --specimens FILE  write one hashed, query-free specimen per (lane, class) with provenance — live fixtures",
    "",
    "Sessions are optional when --hook-lane is given. The evidence report is one JSON line on stderr:",
    "coverage · observed · gaps (dens) · engines — kept apart so 0 misses and no telemetry never look alike.",
  ].join("\n"));
  process.exit(2);
}

type ValueFlag = "out" | "events" | "vault" | "labels" | "proposals" | "evidence" | "hub-sessions" | "since" | "specimens";

interface Args extends Record<ValueFlag, string | null> {
  hookLane: boolean;
  inputs: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: null, events: null, vault: null, labels: null, proposals: null, evidence: null, "hub-sessions": null, since: null, specimens: null, hookLane: false, inputs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (FLAGS_WITH_VALUE.has(arg)) {
      const value = argv[index + 1];
      if (!value) usage();
      args[arg.slice(2) as ValueFlag] = value;
      index += 1;
    } else if (FLAGS_BARE.has(arg)) {
      args.hookLane = true;
    } else if (arg.startsWith("--")) {
      usage();
    } else {
      args.inputs.push(arg);
    }
  }
  if (args.inputs.length === 0 && !args.hookLane) usage();
  if (args.hookLane && (!args.events || !args.vault)) usage();
  return args;
}

/** A path that is wrong is an error, never a run that reports zero. */
function fail(message: string): never {
  console.error("harvest-reviewed-misses: " + message);
  process.exit(1);
}

async function requireDir(flag: string, path: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) fail(`${flag} ${path}: not a directory`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.events) {
    await requireDir("--events", args.events);
    if ((await telemetryFiles(args.events)).length === 0) fail(`--events ${args.events}: no events-*.jsonl in it`);
  }
  if (args.vault) await requireDir("--vault", args.vault);
  const hubSessions = args["hub-sessions"] ? Number(args["hub-sessions"]) : 3;
  if (!Number.isInteger(hubSessions) || hubSessions < 1) usage();
  const sinceDays = args.since ? Number(args.since) : 0;
  if (!Number.isFinite(sinceDays) || sinceDays < 0) usage();
  const telemetry: Telemetry | null = args.events
    ? await loadTelemetry(args.events, sinceDays > 0 ? { sinceMs: Date.now() - sinceDays * 86_400_000 } : {})
    : null;
  const engines: ObservationEngines = {
    pools: telemetry?.pools ?? null,
    vaultRoot: args.vault ? resolve(args.vault) : null,
    snapshot: args.vault ? await snapshotVault(args.vault) : null,
    labels: args.labels ? parseReviewerLabels(await readFile(args.labels, "utf8")) : new Map(),
  };
  if (args.vault && engines.snapshot?.idCount === 0) fail(`--vault ${args.vault}: no memory in it`);

  const transcripts = await Promise.all(args.inputs.map(async (input) => ({ jsonl: await readFile(input, "utf8"), fileName: basename(resolve(input)) })));
  const { transcript: pairs, hook, stats, gaps, heat, hubs, paths, proposals } = observeLanes(transcripts, telemetry, engines, { hookLane: args.hookLane, hubSessions });
  const transcriptRecords = pairs.map((pair) => pair.record);

  const byTranscript = countClasses(transcriptRecords);
  const byHook = args.hookLane ? countClasses(hook.records) : emptyClassCounts();
  const report: EvidenceReport = {
    kind: "reviewed-miss-evidence-report/v2",
    coverage: {
      window_days: sinceDays > 0 ? sinceDays : null,
      sessions_scanned: args.inputs.length,
      transcript_recalls: stats.recalls,
      transcript_recalls_with_recall_id: stats.withRecallId,
      transcript_chains: transcriptRecords.length,
      transcript_chains_joined: transcriptRecords.filter((record) => record.observation.pool !== null).length,
      telemetry_pools: telemetry?.pools.size ?? 0,
      telemetry_pools_by_lane: telemetry ? poolsByLane(telemetry.pools) : { recall: 0, hook_recall: 0 },
      telemetry_loads: telemetry?.loads.length ?? 0,
      telemetry_loads_linked: telemetry?.loads.filter((load) => load.fromHookRecall ?? load.followsRecall).length ?? 0,
      hook_loads_covered_by_transcript: hook.coveredByTranscript,
      vault_ids: engines.snapshot?.idCount ?? null,
    },
    observed: {
      by_class: { transcript: byTranscript, hook: byHook },
      live_classes: liveClasses(byTranscript, byHook),
      observed_thin: thinClasses(byTranscript, byHook),
      heatmap_top: heat.slice(0, 8).map(({ memoryId, surfaced, surfacedSessions, loaded, hub, surfacedNeverLoaded }) =>
        ({ memoryId: hash("id:" + memoryId), surfaced, surfacedSessions, loaded, hub, surfacedNeverLoaded })),
      hubs: hubs.size,
      surfaced_never_loaded: heat.filter((row) => row.surfacedNeverLoaded).length,
      hot_paths_established: paths.filter((path) => path.established).length,
      proposals: {
        targets: proposals.length,
        episodes: proposals.reduce((n, p) => n + p.episodes.length, 0),
        max_support: proposals.reduce((n, p) => Math.max(n, p.support), 0),
      },
    },
    gaps: dens(gaps, args.events ?? "<events>"),
    engines: {
      pool_join: args.events ? `telemetry-dir (${telemetry?.pools.size ?? 0} pools)` : "absent",
      vault_snapshot: args.vault ? `snapshot (${engines.snapshot?.idCount ?? 0} ids)` : "absent",
      reviewer_labels: args.labels ? `${engines.labels.size} labels` : "absent",
      hook_lane: args.hookLane ? `telemetry-only (${hook.records.length} loads observed)` : "absent",
    },
  };
  console.error(JSON.stringify(report));

  if (args.proposals) await writeFile(args.proposals, JSON.stringify(proposals, null, 2) + "\n", "utf8");
  if (args.evidence) {
    await writeFile(args.evidence, JSON.stringify({ kind: "reviewed-miss-evidence/v1", hub_sessions: hubSessions, heatmap: heat, hot_paths: paths }, null, 2) + "\n", "utf8");
  }
  const queue = [...transcriptRecords.map((record) => ({ lane: "transcript" as const, ...record })), ...hook.records];
  if (args.specimens) {
    const specimens = specimensOf(queue, { harvested_at: new Date().toISOString(), window_days: sinceDays > 0 ? sinceDays : null });
    await writeFile(args.specimens, specimens.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
  }
  const rendered = JSON.stringify(queue, null, 2) + "\n";
  if (args.out) await writeFile(args.out, rendered, "utf8");
  else process.stdout.write(rendered);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
