/**
 * #62 — repeated long multiline `save_memory` over the REAL stdio transport.
 *
 * The issue's acceptance bar is explicit: a single happy-path save proves
 * nothing. So this drives many saves, at many sizes, through the same path a
 * Claude Code session uses — our `mcp-forwarder` behind an MCP stdio client —
 * against a REAL daemon on a THROWAWAY vault, and byte-compares what landed on
 * disk with what was sent.
 *
 * It never touches the user's vault: `BASTRA_VAULT_PATH` and `HOME` both point
 * at fresh temp directories that are removed at the end.
 *
 * What it measures, per run:
 *   1. body integrity — the stored body is byte-identical to the one sent
 *      (the leading newline the writer puts between frontmatter and body is
 *      framing, not content, and is normalised away)
 *   2. no duplicates — one file per save, no memory written twice
 *   3. idempotency — re-saving the SAME title does not silently create a
 *      second memory (the id is `slug(title)`, so it collides by construction)
 *   4. truncation — a JSON-RPC frame cut mid-body is refused, never stored
 *
 * Run: node --import tsx packages/daemon/scripts/stress-save-62.mjs
 *      RUNS=70 node --import tsx packages/daemon/scripts/stress-save-62.mjs
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const RUNS = Number(process.env.RUNS ?? 70);

/** Sizes bracket the interesting boundaries: the ~600 chars the issue first
 *  saw fail, a 64 KiB stdio pipe buffer, and well past it. */
const SIZES = [600, 2_000, 8_000, 16_000, 65_536, 131_072, 200_000];

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** A body with everything the transport could stumble over: newlines, fenced
 *  code, quotes and backslashes, multibyte scripts, emoji, and one very long
 *  line with no newline in it at all. */
function makeBody(n, seed) {
  const parts = [
    `# Stress ${seed}`,
    "",
    "Ünïcödé — Straße, Grüße, 日本語テキスト, emoji 🧠🔥, кириллица, العربية.",
    "",
    "```ts",
    'const x = { a: 1, b: "quotes \\" and \\\\ backslashes" };',
    "```",
    "",
  ];
  let i = 0;
  while (parts.join("\n").length < n * 0.75) {
    parts.push(`- line ${i++} · ${"λ".repeat(20)} ${seed} ${"x".repeat(40)}`);
  }
  const remaining = Math.max(0, n - parts.join("\n").length - 2);
  parts.push("L" + "y".repeat(remaining));
  return parts.join("\n");
}

const titleFor = (seed) => `Stress 62 ${seed}`;
const seedFor = (run, size) => `r${run}-s${size}`;

function saveArgs(seed, body) {
  return {
    title: titleFor(seed),
    type: "lesson",
    summary: `Stress run ${seed}`,
    body,
    topic_path: ["stress", "issue-62"],
    tags: ["stress", "issue-62"],
    scope: "stress",
    // Unique per run: a shared trigger would (correctly) trip the claim gate
    // and refuse the save, which would measure the gate, not the transport.
    recall_when: [`stress-62-unique-${seed}`, `alpha-${seed}-beta`],
  };
}

async function waitHealth(port, ms = 40_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const vault = await mkdtemp(join(tmpdir(), "bastra62-vault-"));
const home = await mkdtemp(join(tmpdir(), "bastra62-home-"));
await mkdir(join(vault, "memories"), { recursive: true });
const port = 16_000 + Math.floor(Math.random() * 4_000);

const env = {
  ...process.env,
  HOME: home,
  BASTRA_VAULT_PATH: vault,
  BASTRA_HTTP_PORT: String(port),
  BASTRA_DAEMON_URL: `http://127.0.0.1:${port}`,
  BASTRA_FORWARDER_SPAWN: "0",
  BASTRA_TELEMETRY: "off",
  BASTRA_UPDATE_CHECK: "off",
  BASTRA_TOOL_SURFACE: "full",
};
delete env.NEXUS_VAULT_PATH;

const daemon = spawn(process.execPath, ["--import", "tsx", join(REPO, "packages/daemon/src/index.ts")], {
  env,
  cwd: REPO,
  stdio: ["ignore", "pipe", "pipe"],
});
let daemonLog = "";
daemon.stdout.on("data", (c) => (daemonLog += c));
daemon.stderr.on("data", (c) => (daemonLog += c));

const cleanup = async () => {
  daemon.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  daemon.kill("SIGKILL");
  await rm(vault, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
};

if (!(await waitHealth(port))) {
  console.error(`daemon did not start:\n${daemonLog.slice(-4000)}`);
  await cleanup();
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(REPO, "packages/daemon/src/mcp-forwarder.ts")],
  env,
  cwd: REPO,
  stderr: "pipe",
});
const client = new Client({ name: "stress-save-62", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const results = [];
let progressNotifications = 0;

for (let run = 0; run < RUNS; run++) {
  const size = SIZES[run % SIZES.length];
  const seed = seedFor(run, size);
  const body = makeBody(size, seed);

  // A `recall` between saves is what made the original failure irregular: it
  // is the call that emits `notifications/progress`, the notification the
  // upstream client choked on. Interleaving it keeps that traffic on the wire.
  await client
    .callTool({ name: "recall", arguments: { query: `stress ${seed}` } }, undefined, {
      onprogress: () => progressNotifications++,
    })
    .catch(() => undefined);

  let res;
  try {
    res = await client.callTool({ name: "save_memory", arguments: saveArgs(seed, body) }, undefined, {
      onprogress: () => progressNotifications++,
      timeout: 120_000,
    });
  } catch (err) {
    results.push({ run, size, verdict: "call-threw", detail: String(err).slice(0, 300) });
    continue;
  }
  const text = res.content?.map((c) => c.text ?? "").join("\n") ?? "";
  if (res.isError) {
    results.push({ run, size, verdict: "tool-error", detail: text.slice(0, 300) });
    continue;
  }
  results.push({ run, size, verdict: "ok", sent: body.length, sha: sha(body), raw: text.slice(0, 200) });
}

// ── Idempotency: the same title a second time, with different content ───────
// The id is `slug(title)`, so this must NOT quietly become a second memory.
const dupSeed = seedFor(0, SIZES[0]);
let idempotency = "not-run";
try {
  const again = await client.callTool(
    { name: "save_memory", arguments: saveArgs(dupSeed, makeBody(1_200, `${dupSeed}-CHANGED`)) },
    undefined,
    { timeout: 120_000 },
  );
  const text = again.content?.map((c) => c.text ?? "").join("\n") ?? "";
  idempotency = again.isError ? `refused: ${text.slice(0, 160)}` : `answered: ${text.slice(0, 160)}`;
} catch (err) {
  idempotency = `threw: ${String(err).slice(0, 160)}`;
}

await client.close().catch(() => undefined);

// ── Truncation: a JSON-RPC frame cut mid-body must never be stored ──────────
// This is the shape the upstream transport drop produces on the wire. It is
// driven against a raw forwarder process, because no well-behaved MCP client
// can be made to emit a half frame.
const truncationTitle = "Stress 62 truncated-frame";
const truncated = await new Promise((done) => {
  const fw = spawn(process.execPath, ["--import", "tsx", join(REPO, "packages/daemon/src/mcp-forwarder.ts")], {
    env,
    cwd: REPO,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  fw.stdout.on("data", (c) => (out += c));
  fw.stderr.on("data", () => undefined);
  const frame = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "save_memory", arguments: saveArgs("truncated-frame", makeBody(8_000, "truncated-frame")) },
  });
  fw.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    })}\n`,
  );
  // Half the frame, then nothing — no trailing newline, exactly what a
  // connection that drops mid-write leaves behind.
  setTimeout(() => fw.stdin.write(frame.slice(0, Math.floor(frame.length / 2))), 800);
  setTimeout(() => {
    fw.kill("SIGKILL");
    done({ stdoutHadResult: /"result"/.test(out.split("\n").slice(1).join("\n")) });
  }, 3_000);
});

// ── What actually landed on disk ────────────────────────────────────────────
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await walk(p);
    else if (entry.name.endsWith(".md")) files.push(p);
  }
}
await walk(join(vault, "memories")).catch(() => undefined);

const byTitle = new Map();
for (const file of files) {
  const raw = await readFile(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) continue;
  const title = (/^title:\s*(.*)$/m.exec(m[1])?.[1] ?? "").replace(/^["']|["']$/g, "").trim();
  const seen = byTitle.get(title);
  if (seen) seen.count++;
  else byTitle.set(title, { file, body: m[2], count: 1 });
}

let verified = 0;
let mismatched = 0;
let missing = 0;
const anomalies = [];
for (const r of results) {
  if (r.verdict !== "ok") {
    anomalies.push(`${r.verdict} run ${r.run} (${r.size} chars): ${r.detail}`);
    continue;
  }
  const seed = seedFor(r.run, r.size);
  const stored = byTitle.get(titleFor(seed));
  if (!stored) {
    missing++;
    anomalies.push(`missing on disk: ${titleFor(seed)}`);
    continue;
  }
  // The writer puts one newline between frontmatter and body; that is framing.
  const expected = makeBody(r.size, seed).trim();
  const got = stored.body.trim();
  if (got === expected) {
    verified++;
  } else {
    mismatched++;
    let i = 0;
    while (i < Math.min(expected.length, got.length) && expected[i] === got[i]) i++;
    anomalies.push(
      `body mismatch ${titleFor(seed)}: sent ${expected.length} chars (${sha(expected).slice(0, 12)}), ` +
        `stored ${got.length} chars (${sha(got).slice(0, 12)}), first difference at index ${i}`,
    );
  }
}

const duplicateTitles = [...byTitle.entries()].filter(([, v]) => v.count > 1).map(([t, v]) => `${t} ×${v.count}`);
const truncationStored = byTitle.has(truncationTitle);

const report = {
  runs: RUNS,
  sizes: SIZES,
  progressNotifications,
  saveCallsAccepted: results.filter((r) => r.verdict === "ok").length,
  saveCallsFailed: results.filter((r) => r.verdict !== "ok").length,
  bodiesVerifiedByteIdentical: verified,
  bodiesMismatched: mismatched,
  bodiesMissingOnDisk: missing,
  memoryFilesOnDisk: files.length,
  duplicateTitles,
  idempotentResaveOfSameTitle: idempotency,
  truncatedFrameProducedAResult: truncated.stdoutHadResult,
  truncatedFrameStoredAMemory: truncationStored,
  deviations: mismatched + missing + results.filter((r) => r.verdict !== "ok").length + duplicateTitles.length +
    (truncationStored ? 1 : 0),
  anomalies: anomalies.slice(0, 20),
};

console.log(JSON.stringify(report, null, 2));
await cleanup();
process.exit(report.deviations === 0 ? 0 : 1);
