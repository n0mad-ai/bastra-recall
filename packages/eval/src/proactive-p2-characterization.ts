/**
 * Deterministic P2 characterization mode (#1649), the comparison baseline for the
 * planned restructuring of the P2 driver (#1531).
 *
 * It runs the UNCHANGED `proactive-p2-driver.ts` against an in-process stand-in
 * feature (see `proactive-p2-fake-*.ts`) on a virtual clock, with fixed root layout,
 * port, reference instant, credentials and commit IDs. No wall clock, no unseeded
 * randomness, no sockets, no model calls: the same driver source yields the same
 * output, byte for byte. The output records what the DRIVER does (requests, clock
 * steps, computed values, evidence) for the cases whose logic lives in the driver's
 * own `run`. It is no evidence about the feature and never a measurement result.
 *
 * Comparison surface: per row the observation without its transport provenance
 * (`splitP2Observation`: data root, loopback port, child process logs), with the
 * row's root path written as `<root>`. The real measurement runner is not touched.
 *
 *   node --import tsx packages/eval/src/proactive-p2-characterization.ts            # full document
 *   node --import tsx packages/eval/src/proactive-p2-characterization.ts --summary  # frozen form
 *
 * The frozen summary lives in `fixtures/proactive-p2-characterization.json`; the test
 * `__tests__/proactive-p2-characterization.test.ts` compares a fresh run against it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PROACTIVE_CASES, type Observation } from "./proactive-measurement.js";
import type { FeatureDriver } from "./proactive-measurement-run.js";
import { FakeWorld, enterWorld, installProcessFakes, writeFeatureRoot } from "./proactive-p2-fake-feature.js";
import { drive, install, reset } from "./proactive-p2-virtual-runtime.js";

/** Cases whose observation logic is written inside the P2 driver's `run`, i.e. what #1531 restructures. */
export const CHARACTERIZED_CASES = [
  "p3-source-key-tuple-boundary",
  "p3-automatic-evaluation",
  "p3-returning-source-transitions",
  "p2-auth-boundaries",
  "p2-transport-parity",
  "p2-owner-lifecycle",
  "p2-durable-restart",
  "p2-concurrency-cas",
  "p1-p2-corruption-recovery",
  "seven-day-evaluation",
  "active-session-deadline",
  "offline-restart",
  "relay-overflow-disabled-purged",
  "multi-client-occurrence",
  "acknowledged-unfinished",
  "dst-recurrence-rollback",
];
const MODE = "proactive-p2-characterization-v1";
const REFERENCE_INSTANT = "2026-10-12T12:00:00Z";
const PORT = 47123;
const PROVENANCE_KEYS = ["root", "port", "process_logs"];

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function replacePaths(value: unknown, paths: Array<[string, string]>): unknown {
  if (typeof value === "string") return paths.reduce((s, [path, label]) => s.split(path).join(label), value);
  if (Array.isArray(value)) return value.map((v) => replacePaths(v, paths));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replacePaths(v, paths)]));
  return value;
}

/**
 * Split a driver row into the comparable observation and its transport provenance.
 * Top-level evidence keys `root`, `port` and `process_logs` move to `provenance`;
 * the row's root path inside every other string becomes `<root>`. The raw row is
 * not modified, so the private raw evidence stays complete.
 */
export function splitP2Observation(row: Observation, transport: { root: string }) {
  const provenance: Record<string, unknown[]> = {};
  const evidence = row.evidence.map((entry) => {
    if (!isRecord(entry)) return entry;
    const kept = { ...entry };
    for (const key of PROVENANCE_KEYS.filter((k) => Object.hasOwn(kept, k))) {
      (provenance[key] ??= []).push(kept[key]);
      delete kept[key];
    }
    return kept;
  });
  const roots = [
    ...new Set([transport.root, existsSync(transport.root) ? realpathSync(transport.root) : transport.root]),
  ];
  const comparable = replacePaths(
    { ...row, evidence },
    roots.sort((a, b) => b.length - a.length).map((root): [string, string] => [root, "<root>"])
  ) as Observation;
  return { comparable, provenance };
}

interface CharacterizedRow {
  case_id: string;
  repetition: number;
  outcome: "observed" | "error";
  error?: string;
  values: Observation["values"];
  evidence: unknown[];
  stdout: string[];
  trace: unknown[];
}
export interface CharacterizationDocument {
  mode: string;
  note: string;
  reference_instant: string;
  driver_metadata: Omit<FeatureDriver["metadata"], "support_sha256">;
  rows: CharacterizedRow[];
}

/** The frozen form: every value in full, the evidence of each row and the whole document by hash. */
export function characterizationSummary(document: CharacterizationDocument) {
  return {
    mode: document.mode,
    document_sha256: sha256(JSON.stringify(document)),
    rows: document.rows.map((r) => ({
      case_id: r.case_id,
      repetition: r.repetition,
      outcome: r.outcome,
      ...(r.error ? { error: r.error } : {}),
      values: r.values,
      evidence_sha256: sha256(JSON.stringify(r.evidence)),
      trace_sha256: sha256(JSON.stringify(r.trace)),
      stdout: r.stdout,
    })),
  };
}

async function characterizeRow(driver: FeatureDriver, id: string, repetition: number, base: string, feature: string) {
  const root = join(base, "rows", `${id}-${repetition}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const world = new FakeWorld();
  enterWorld(world);
  reset(Date.parse(REFERENCE_INSTANT));
  const stdout: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void stdout.push(args.join(" "));
  const c = PROACTIVE_CASES.find((x) => x.id === id)!;
  const context = { root, port: PORT, reference_instant: REFERENCE_INSTANT, repetition, feature_root: feature };
  try {
    const { comparable } = splitP2Observation(await drive(driver.run(c, context)), { root });
    return {
      case_id: id,
      repetition,
      outcome: "observed" as const,
      values: comparable.values,
      evidence: comparable.evidence,
      stdout,
      trace: replacePaths(world.trace, [[root, "<root>"]]) as unknown[],
    };
  } catch (error) {
    const path = join(root, "incomplete-evidence.json");
    const partial = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { values: {}, evidence: [] };
    const { comparable } = splitP2Observation({ ...partial, case_id: id, repetition }, { root });
    return {
      case_id: id,
      repetition,
      outcome: "error" as const,
      error: String(error).split(root).join("<root>"),
      values: comparable.values,
      evidence: comparable.evidence,
      stdout,
      trace: replacePaths(world.trace, [[root, "<root>"]]) as unknown[],
    };
  } finally {
    console.log = log;
  }
}

/** Run every characterized case three times, each in a fresh stand-in world and virtual timeline. */
async function characterize(): Promise<CharacterizationDocument> {
  const base = mkdtempSync(join(tmpdir(), "bastra-p2-characterization-"));
  try {
    const feature = writeFeatureRoot(base);
    enterWorld(new FakeWorld());
    installProcessFakes(base);
    process.argv.push("--feature-root", feature);
    const driver: FeatureDriver = (await import("./proactive-p2-driver.js")).default;
    install(Date.parse(REFERENCE_INSTANT));
    const rows: CharacterizedRow[] = [];
    for (const id of CHARACTERIZED_CASES)
      for (let repetition = 1; repetition <= 3; repetition++)
        rows.push(await characterizeRow(driver, id, repetition, base, feature));
    const { support_sha256: _fileIdentity, ...driver_metadata } = driver.metadata;
    return {
      mode: MODE,
      note: "Driver characterization against an in-process stand-in feature; not feature evidence or a measurement.",
      reference_instant: REFERENCE_INSTANT,
      driver_metadata,
      rows: replacePaths(rows, [
        [realpathSync(base), "<base>"],
        [base, "<base>"],
      ]) as CharacterizedRow[],
    };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The mode is closed: it always drives its own stand-in feature root. Any other argument, above
  // all a `--feature-root` taken over from a real measurement command, is refused before the
  // driver (which takes the first `--feature-root` and imports that checkout's modules) loads.
  const unsupported = process.argv.slice(2).filter((a) => a !== "--summary");
  if (unsupported.length) {
    process.stderr.write(
      `proactive-p2-characterization: unsupported argument(s): ${unsupported.join(" ")}. ` +
        "The fixed mode takes only --summary and always uses its own stand-in feature root.\n"
    );
    process.exitCode = 2;
  } else {
    const summary = process.argv.includes("--summary");
    const document = await characterize();
    process.stdout.write(JSON.stringify(summary ? characterizationSummary(document) : document, null, 2) + "\n");
  }
}
