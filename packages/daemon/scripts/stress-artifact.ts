/**
 * Versioned run artifacts for the stress harness (#261, M0).
 *
 * A number nobody can reproduce is not a measurement. M0 requires every run to
 * carry the hashes of what produced it — code, vault, model, config, dataset —
 * and to leave the command line, the raw output and the structured results
 * behind as a private artifact.
 *
 * Private on purpose: run artifacts live under `~/.bastra/eval-runs/`, never
 * in the repository. The vault's own text is in the queries and the report;
 * only aggregated numbers may be published (C-025, §23).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface RunHashes {
  /** Harness sources + fixtures — the code that produced these numbers. */
  code: string;
  /** Repository HEAD plus a dirty flag, when the run happened inside a checkout. */
  git: string;
  /** Vault identity: sorted id + updated over every memory. */
  vault: string;
  /** Retrieval arm: provider label, or BM25-only. */
  model: string;
  /** CLI arguments and thresholds. */
  config: string;
  /** The gold case sets. */
  dataset: string;
}

export interface RunManifest {
  run_date: string;
  vault_path: string;
  vault_size: number;
  provider: string;
  command: string;
  hashes: RunHashes;
  /** Seed behind the control arm and the label-shuffle null. */
  seed: number;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * The slice summaries carry Maps, and `JSON.stringify` turns a Map into `{}` —
 * a silent hole in the record. Serialise them as objects instead.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  return value instanceof Map ? Object.fromEntries(value) : value;
}

const HERE = import.meta.dirname;

/**
 * Hashes the harness itself. Deterministic and git-independent: the sources
 * are read in a fixed order, so the same checkout always yields the same
 * digest whether or not it is a repository.
 */
function hashCode(): string {
  const files = [
    "eval-stress.ts",
    "stress-arm.ts",
    "stress-slices.ts",
    "stress-artifact.ts",
    join("stress-fixtures", "paraphrased.ts"),
    join("stress-fixtures", "cross-memory.ts"),
    join("stress-fixtures", "anti-hallucination.ts"),
    // Decides which gold cases are scored at all, so two runs with different
    // retirements would otherwise carry byte-identical code/config/dataset
    // hashes while reporting different numbers over different case sets.
    join("stress-fixtures", "retired-gold.json"),
  ];
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    try {
      h.update(readFileSync(join(HERE, f)));
    } catch {
      // A missing source is itself part of the identity — record the absence
      // rather than silently hashing a shorter list.
      h.update("<missing>");
    }
  }
  return h.digest("hex");
}

/** HEAD plus a dirty marker, or "not-a-git-checkout". */
function gitState(): string {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: HERE, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: HERE, encoding: "utf8" }).trim();
    return dirty.length > 0 ? `${head}-dirty` : head;
  } catch {
    return "not-a-git-checkout";
  }
}

/**
 * Vault identity over ids and their `updated` stamps, sorted.
 *
 * Deliberately not a content hash: this runs on vaults of thousands of files
 * and the point is to detect a different corpus, not to audit bytes. What it
 * catches is stated so nobody over-reads it — additions, removals, and edits
 * that moved `updated`.
 */
export function hashVault(mems: Array<{ fm: Record<string, unknown> }>): string {
  const rows = mems.map((m) => `${String(m.fm.id)}\0${String(m.fm.updated ?? "")}`).sort();
  return sha256(rows.join("\n"));
}

export function computeHashes(input: {
  mems: Array<{ fm: Record<string, unknown> }>;
  provider: string;
  config: unknown;
  dataset: unknown;
}): RunHashes {
  return {
    code: hashCode(),
    git: gitState(),
    vault: hashVault(input.mems),
    model: sha256(input.provider),
    config: sha256(JSON.stringify(input.config)),
    dataset: sha256(JSON.stringify(input.dataset)),
  };
}

/** `~/.bastra/eval-runs/<YYYY-MM-DD>-<short run hash>/`. */
export function runDirFor(manifest: RunManifest): string {
  const day = manifest.run_date.slice(0, 10);
  const short = sha256(JSON.stringify(manifest.hashes) + manifest.run_date).slice(0, 12);
  const root = process.env.BASTRA_EVAL_RUNS_DIR ?? join(homedir(), ".bastra", "eval-runs");
  return join(root, `${day}-${short}`);
}

/**
 * Writes the artifact and returns its directory.
 *
 * Errors propagate. An unrecorded run is not a cheaper run — it is one that
 * cannot be cited, and the caller has to know that before it reports a number.
 */
export async function writeRunArtifact(input: {
  manifest: RunManifest;
  stdout: string;
  stderr: string;
  results: unknown;
}): Promise<string> {
  const dir = runDirFor(input.manifest);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(join(dir, "manifest.json"), JSON.stringify(input.manifest, null, 2) + "\n", { mode: 0o600 }),
    writeFile(join(dir, "results.json"), JSON.stringify(input.results, jsonReplacer, 2) + "\n", { mode: 0o600 }),
    writeFile(join(dir, "stdout.txt"), input.stdout, { mode: 0o600 }),
    writeFile(join(dir, "stderr.txt"), input.stderr, { mode: 0o600 }),
    writeFile(join(dir, "command.txt"), input.manifest.command + "\n", { mode: 0o600 }),
  ]);
  return resolve(dir);
}
