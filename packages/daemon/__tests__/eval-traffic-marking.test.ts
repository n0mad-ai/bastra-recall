/**
 * #619 — eval/synthetic traffic declares itself via `dimensions.client ===
 * "eval"` so the context-tax readouts (scripts/stats.ts, `bastra logs
 * --stats`) can exclude it from the default report without guessing from a
 * session-id prefix or any other heuristic.
 *
 * Three things pinned here:
 *  1. `isEvalTraffic` reads exactly that field, nothing inferred.
 *  2. A `recallHandler` call that declares itself `client: "eval"` writes
 *     that marker onto the "recall" event actually appended to the log —
 *     not just onto the in-memory dimensions object.
 *  3. The two repository probes that caused #619 (measure-recall-payload.ts,
 *     measure-recall-budget.ts) pass that option on every recallHandler call
 *     they make — a source check, because both open the REAL vault directly
 *     and a regression there would silently start polluting production logs
 *     again.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/eval-traffic-marking.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { isEvalTraffic } from "../src/telemetry-dimensions.js";
import { recallHandler, type ToolDeps } from "../src/tool-handlers.js";
import { Telemetry } from "../src/telemetry.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ── isEvalTraffic ────────────────────────────────────────────────

test("isEvalTraffic reads only dimensions.client, nothing inferred", () => {
  assert.equal(isEvalTraffic({ dimensions: { client: "eval" } }), true);
  assert.equal(isEvalTraffic({ dimensions: { client: "unknown" } }), false);
  assert.equal(isEvalTraffic({ dimensions: { client: "claude-code" } }), false);
  assert.equal(isEvalTraffic({}), false, "no dimensions at all (pre-#263) stays production");
  assert.equal(isEvalTraffic({ dimensions: undefined }), false);
  assert.equal(isEvalTraffic({ dimensions: null }), false);
});

// ── the marker survives the write path ──────────────────────────

function memoryMarkdown(id: string, title: string): string {
  return [
    "---", `id: ${id}`, `title: ${title}`, "type: reference", `summary: ${title}`,
    "topic_path:", "  - test", "tags:", "  - test", "scope: eval-marking-test",
    "recall_when:", `  - ${title}`, "created: 2026-01-01", "updated: 2026-01-01",
    "---", "", `Body for ${title}.`, "",
  ].join("\n");
}

async function readRecallEvent(logDir: string): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 40));
    let files: string[];
    try { files = await readdir(logDir); } catch { continue; }
    for (const f of files.filter((n) => n.startsWith("events-"))) {
      const raw = await readFile(join(logDir, f), "utf8");
      const line = raw.split("\n").filter((l) => l.includes('"recall"')).pop();
      if (line) return JSON.parse(line) as Record<string, unknown>;
    }
  }
  return null;
}

test("#619: recallHandler(..., {client: 'eval'}) writes dimensions.client = 'eval' onto the appended event", async () => {
  const vaultDir = await mkdtemp(join(tmpdir(), "bastra-619-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-619-logs-"));
  await writeFile(join(vaultDir, "alpha.md"), memoryMarkdown("alpha", "alpha bravo charlie"), "utf8");
  const vault = new Vault(vaultDir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const prevLog = process.env.BASTRA_LOG_PATH;
  process.env.BASTRA_LOG_PATH = logDir;
  const telemetry = new Telemetry();
  if (prevLog === undefined) delete process.env.BASTRA_LOG_PATH;
  else process.env.BASTRA_LOG_PATH = prevLog;
  const deps: ToolDeps = { vault, search, telemetry, vaultPath: vaultDir };
  try {
    await recallHandler(deps, { query: "alpha bravo charlie", k: 3 }, { client: "eval" });
    const row = await readRecallEvent(logDir);
    assert.ok(row, "a recall event should have been appended");
    const dims = row!.dimensions as Record<string, unknown>;
    assert.equal(dims.client, "eval");
    assert.equal(isEvalTraffic(row!), true);
  } finally {
    search.stop();
    await vault.stop?.();
    await rm(vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ── the two probes that caused #619 mark every call they make ────

for (const script of ["measure-recall-payload.ts", "measure-recall-budget.ts"]) {
  test(`#619: ${script} marks every recallHandler call as eval traffic`, async () => {
    const src = await readFile(join(REPO_ROOT, "packages/daemon/scripts", script), "utf8");
    const callCount = (src.match(/recallHandler\(/g) ?? []).length;
    const markedCount = (src.match(/\{ client: "eval" \}/g) ?? []).length;
    assert.ok(callCount > 0, `expected at least one recallHandler call in ${script}`);
    assert.equal(
      markedCount,
      callCount,
      `${script}: ${callCount} recallHandler call(s) but only ${markedCount} marked {client: "eval"} — a regression here would silently pollute production telemetry again`,
    );
  });
}
