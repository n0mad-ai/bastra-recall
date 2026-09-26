/**
 * Tests for src/learned-recall/mint-job.ts (#353) — the in-band mint on its
 * own trigger: mints from a telemetry log, records last-mint.json, stays
 * idempotent across re-runs.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/mint-job.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "@bastra-recall/core";
import { runInBandMint, readLastMint, LAST_MINT_FILE } from "../src/learned-recall/mint-job.js";

function nearMemory(): string {
  const ts = new Date().toISOString();
  return [
    "---",
    "id: panel-dismiss",
    "title: NSPanel resignKey dismissal",
    "type: lesson",
    "summary: panel dismissal on resignKey",
    "topic_path:",
    "  - swift",
    "tags:",
    "  - swift",
    "scope: personal",
    "recall_when:",
    "  - macOS window dismiss observer resignKey attachedSheet",
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    "Hold the panel; respect attachedSheet on resignKey.",
    "",
  ].join("\n");
}

/** Far reaches onto panel-dismiss: the query shares no vocabulary with the
 *  memory. Two by default — a confirmed bridge (#672). */
function eventLogLines(reaches = 2, ts = new Date().toISOString()): string {
  const lines: object[] = [];
  for (let i = 1; i <= reaches; i++) {
    lines.push(
      { kind: "hook_recall", ts, recall_id: `r${i}`, query: "warum schließt sich mein Fenster von allein" },
      { kind: "recall_episode", ts, recall_id: `r${i}`, memory_id: "panel-dismiss", acted_on: true },
    );
  }
  return lines.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

test("runInBandMint: mints from the log, records last-mint.json, re-run is idempotent", async () => {
  const vaultDir = await mkdtemp(join(tmpdir(), "bastra-mint-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-mint-log-"));
  const bridgesRoot = await mkdtemp(join(tmpdir(), "bastra-mint-bridges-"));
  try {
    await writeFile(join(vaultDir, "panel.md"), nearMemory(), "utf8");
    const today = new Date().toISOString().slice(0, 10);
    await writeFile(join(logDir, `events-${today}.jsonl`), eventLogLines(), "utf8");
    const vault = new Vault(vaultDir);
    await vault.init();

    const first = await runInBandMint({ vault, bridgesRoot, trigger: "daemon-boot", logDir });
    assert.equal(first.reaches, 2);
    assert.equal(first.minted, 1);
    assert.equal(first.written, 1);

    // #353 observability: the run is visible without counting files
    const last = await readLastMint(bridgesRoot);
    assert.ok(last, "last-mint.json must exist after a run");
    assert.equal(last.trigger, "daemon-boot");
    assert.equal(last.minted, 1);
    assert.equal(last.reaches, 2);

    // idempotent: same log, same bridges — overwritten, not duplicated
    const second = await runInBandMint({ vault, bridgesRoot, trigger: "daemon-interval", logDir });
    assert.equal(second.minted, 1);
    const langDirs = await readdir(join(bridgesRoot, "bridges"));
    let files = 0;
    for (const lang of langDirs) files += (await readdir(join(bridgesRoot, "bridges", lang))).length;
    assert.equal(files, 1, "re-run must overwrite the same bridge file, not add a second");
    assert.equal((await readLastMint(bridgesRoot))?.trigger, "daemon-interval");
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
    await rm(bridgesRoot, { recursive: true, force: true });
  }
});

test("runInBandMint: empty log still records the run (frozen-pool visibility)", async () => {
  const vaultDir = await mkdtemp(join(tmpdir(), "bastra-mint-vault2-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-mint-log2-"));
  const bridgesRoot = await mkdtemp(join(tmpdir(), "bastra-mint-bridges2-"));
  try {
    await mkdir(bridgesRoot, { recursive: true });
    const vault = new Vault(vaultDir);
    await vault.init();
    const outcome = await runInBandMint({ vault, bridgesRoot, trigger: "cli", logDir });
    assert.deepEqual(outcome, { minted: 0, reaches: 0, written: 0, pruned: 0 });
    const last = await readLastMint(bridgesRoot);
    assert.ok(last, `${LAST_MINT_FILE} must be written even when nothing minted`);
    assert.equal(last.minted, 0);
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
    await rm(bridgesRoot, { recursive: true, force: true });
  }
});

async function withMintDirs(fn: (d: { vault: Vault; logDir: string; bridgesRoot: string }) => Promise<void>): Promise<void> {
  const vaultDir = await mkdtemp(join(tmpdir(), "bastra-mint-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-mint-log-"));
  const bridgesRoot = await mkdtemp(join(tmpdir(), "bastra-mint-bridges-"));
  try {
    await writeFile(join(vaultDir, "panel.md"), nearMemory(), "utf8");
    const vault = new Vault(vaultDir);
    await vault.init();
    await fn({ vault, logDir, bridgesRoot });
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
    await rm(bridgesRoot, { recursive: true, force: true });
  }
}

async function bridgeFiles(bridgesRoot: string): Promise<Array<{ evidence: number; first_seen?: string }>> {
  const out: Array<{ evidence: number; first_seen?: string }> = [];
  if (!existsSync(join(bridgesRoot, "bridges"))) return out;
  for (const lang of await readdir(join(bridgesRoot, "bridges"))) {
    for (const f of await readdir(join(bridgesRoot, "bridges", lang))) {
      out.push(JSON.parse(await readFile(join(bridgesRoot, "bridges", lang, f), "utf8")));
    }
  }
  return out;
}

const DAY = 86_400_000;

test("#672: a single reach is written on first evidence, unconfirmed, stamped with the reach time", async () => {
  await withMintDirs(async ({ vault, logDir, bridgesRoot }) => {
    const reachTs = new Date().toISOString();
    await writeFile(join(logDir, `events-${reachTs.slice(0, 10)}.jsonl`), eventLogLines(1, reachTs), "utf8");
    const out = await runInBandMint({ vault, bridgesRoot, trigger: "cli", logDir });
    assert.deepEqual(out, { minted: 1, reaches: 1, written: 1, pruned: 0 });
    const [b] = await bridgeFiles(bridgesRoot);
    assert.equal(b.evidence, 1);
    assert.equal(b.first_seen, reachTs, "first_seen is the reach, not the mint run");
  });
});

test("#672: an unconfirmed bridge without a second reach is dropped once the TTL ran out", async () => {
  await withMintDirs(async ({ vault, logDir, bridgesRoot }) => {
    const reachTs = new Date(Date.now() - 5 * DAY).toISOString();
    await writeFile(join(logDir, `events-${reachTs.slice(0, 10)}.jsonl`), eventLogLines(1, reachTs), "utf8");
    await runInBandMint({ vault, bridgesRoot, trigger: "cli", logDir });
    assert.equal((await bridgeFiles(bridgesRoot)).length, 1);

    // 26 days later the reach is 31 days old: the pass neither rewrites nor keeps it.
    const later = new Date(Date.now() + 26 * DAY);
    const out = await runInBandMint({ vault, bridgesRoot, trigger: "daemon-interval", logDir, now: later });
    assert.equal(out.written, 0, "a born-expired candidate is not written again");
    assert.equal(out.pruned, 1);
    assert.equal((await bridgeFiles(bridgesRoot)).length, 0);
    assert.equal((await readLastMint(bridgesRoot))?.pruned, 1, "the prune count is visible in last-mint.json");
  });
});

test("#672: a second reach inside the window confirms the bridge — it outlives the TTL", async () => {
  await withMintDirs(async ({ vault, logDir, bridgesRoot }) => {
    const firstTs = new Date(Date.now() - 20 * DAY).toISOString();
    await writeFile(join(logDir, `events-${firstTs.slice(0, 10)}.jsonl`), eventLogLines(1, firstTs), "utf8");
    await runInBandMint({ vault, bridgesRoot, trigger: "cli", logDir });
    const secondTs = new Date().toISOString();
    // a second, distinct reach (own recall_id) onto the same bridge
    const lines = [
      { kind: "hook_recall", ts: secondTs, recall_id: "r2", query: "warum schließt sich mein Fenster von allein" },
      { kind: "recall_episode", ts: secondTs, recall_id: "r2", memory_id: "panel-dismiss", acted_on: true },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(join(logDir, `events-${secondTs.slice(0, 10)}.jsonl`), lines, { encoding: "utf8", flag: "a" });
    await runInBandMint({ vault, bridgesRoot, trigger: "daemon-interval", logDir });
    let [b] = await bridgeFiles(bridgesRoot);
    assert.equal(b.evidence, 2);
    assert.equal(b.first_seen, firstTs, "the expiry clock never restarts");

    // long past the TTL, and the first reach has aged out of the log: still confirmed, still there
    await rm(join(logDir, `events-${firstTs.slice(0, 10)}.jsonl`));
    const out = await runInBandMint({ vault, bridgesRoot, trigger: "daemon-interval", logDir, now: new Date(Date.now() + 60 * DAY) });
    assert.equal(out.pruned, 0);
    [b] = await bridgeFiles(bridgesRoot);
    assert.equal(b.evidence, 2, "a lower recount from a trimmed log never demotes a confirmed bridge");
  });
});

test("#672: the prune leaves pre-#672 files and contributed bridges alone", async () => {
  await withMintDirs(async ({ vault, logDir, bridgesRoot }) => {
    const dir = join(bridgesRoot, "bridges", "de");
    await mkdir(dir, { recursive: true });
    const old = new Date(Date.now() - 90 * DAY).toISOString();
    await writeFile(join(dir, "legacy.json"), JSON.stringify({ id: "legacy", lang: "de", trigger_terms: ["a1b"], expansion_terms: ["x"], evidence: 1 }), "utf8");
    await writeFile(join(dir, "contrib.json"), JSON.stringify({ id: "contrib", lang: "de", trigger_terms: ["a1b"], expansion_terms: ["x"], evidence: 1, first_seen: old, verifier: "v" }), "utf8");
    await writeFile(join(dir, "mine.json"), JSON.stringify({ id: "mine", lang: "de", trigger_terms: ["a1b"], expansion_terms: ["x"], evidence: 1, first_seen: old }), "utf8");
    const out = await runInBandMint({ vault, bridgesRoot, trigger: "cli", logDir });
    assert.equal(out.pruned, 1);
    assert.deepEqual((await readdir(dir)).sort(), ["contrib.json", "legacy.json"]);
  });
});
