/**
 * #353: Teacher 1 — the free in-band mint — on its own trigger.
 *
 * `bastra bridges mint` reads acted-on reaches from the telemetry log and
 * mints bridges; no model, no reranker, always runnable. It was CLI-only and
 * never invoked anywhere, so the pool froze while reaches piled up (zzalli
 * counted 111 unread reaches against a pool of 2). This module is the shared
 * core for both triggers: the CLI subcommand and the daemon's own schedule.
 *
 * Every run — minted or not — records itself twice (#353 observability):
 * a `bridges_mint` telemetry event, and <bridgesRoot>/last-mint.json with
 * host + trigger, so a frozen pool is visible without counting files.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { Vault } from "@bastra-recall/core";
import { distinctiveTerms, MIN_BRIDGE_EVIDENCE } from "./bridges.js";
import { readEventLog, reconstructReaches, harvestBridges, writeBridges } from "./harvest.js";
import { envFirst } from "../env.js";

export type MintTrigger = "cli" | "daemon-boot" | "daemon-interval";

export interface MintOutcome {
  minted: number;
  reaches: number;
  written: number;
}

export interface LastMintRecord extends MintOutcome {
  ts: string;
  host: string;
  trigger: MintTrigger;
}

export const LAST_MINT_FILE = "last-mint.json";

/** A memory's distinctive vocabulary — the near terms mintBridge tests against. */
export function memoryTermsGetter(vault: Vault): (id: string) => string[] {
  return (id: string): string[] => {
    const m = vault.get(id);
    if (!m) return [];
    return distinctiveTerms(
      [m.fm.title, m.fm.summary, ...m.fm.recall_when, ...m.fm.tags, m.body].join(" "),
    );
  };
}

/**
 * One in-band mint run: telemetry log → reaches → bridges on disk. Never
 * touches the reranker. Idempotent: bridge ids are deterministic, re-runs
 * overwrite the same files with a full evidence recount.
 */
export async function runInBandMint(opts: {
  vault: Vault;
  bridgesRoot: string;
  trigger: MintTrigger;
  /** Optional day window for the log read (CLI arg); null = full log. */
  days?: number | null;
  /** Test override for the telemetry log dir. */
  logDir?: string;
}): Promise<MintOutcome> {
  const events = await readEventLog(opts.logDir, opts.days ?? null);
  const reaches = reconstructReaches(events);
  let outcome: MintOutcome = { minted: 0, reaches: reaches.length, written: 0 };
  if (reaches.length > 0) {
    const result = harvestBridges(reaches, memoryTermsGetter(opts.vault));
    // 20.08.: only confirmed bridges reach the disk (MIN_BRIDGE_EVIDENCE).
    // `minted` keeps counting every candidate, so the gap between minted and
    // written in last-mint.json is the number of single-reach anecdotes held back.
    const confirmed = result.bridges.filter((b) => b.evidence >= MIN_BRIDGE_EVIDENCE);
    const written = await writeBridges(opts.bridgesRoot, confirmed);
    outcome = { minted: result.minted, reaches: result.reaches, written };
  }
  const record: LastMintRecord = {
    ts: new Date().toISOString(),
    host: hostname(),
    trigger: opts.trigger,
    ...outcome,
  };
  await recordLastMint(opts.bridgesRoot, record);
  await writeMintTelemetry(record);
  return outcome;
}

/** Read the per-box last-mint marker; null when no mint ever ran here. */
export async function readLastMint(bridgesRoot: string): Promise<LastMintRecord | null> {
  try {
    const raw = await readFile(join(bridgesRoot, LAST_MINT_FILE), "utf8");
    const parsed = JSON.parse(raw) as LastMintRecord;
    return typeof parsed === "object" && parsed !== null && typeof parsed.ts === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function recordLastMint(bridgesRoot: string, record: LastMintRecord): Promise<void> {
  try {
    await mkdir(bridgesRoot, { recursive: true });
    await writeFile(join(bridgesRoot, LAST_MINT_FILE), JSON.stringify(record, null, 2) + "\n", "utf8");
  } catch {
    // Observability must never break the mint itself.
  }
}

/** Same event-log discipline as the hook clients: append-only, never throws. */
async function writeMintTelemetry(record: LastMintRecord): Promise<void> {
  if ((envFirst("BASTRA_TELEMETRY", "NEXUS_TELEMETRY") ?? "on").toLowerCase() === "off") return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? join(homedir(), ".bastra", "logs");
    await mkdir(logDir, { recursive: true });
    const event = {
      kind: "bridges_mint",
      ts: record.ts,
      // #363: no Claude session touches this path (CLI subcommand or
      // daemon boot/interval trigger) — null is the honest value, matching
      // ollama_lifecycle, not a boot-id lie.
      session_id: null,
      host: record.host,
      trigger: record.trigger,
      minted: record.minted,
      reaches: record.reaches,
      written: record.written,
    };
    await appendFile(
      join(logDir, `events-${record.ts.slice(0, 10)}.jsonl`),
      JSON.stringify(event) + "\n",
      "utf8",
    );
  } catch {
    // Telemetry must never break the mint.
  }
}
