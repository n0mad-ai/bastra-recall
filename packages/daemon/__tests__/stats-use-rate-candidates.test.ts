/**
 * The USE-rate table counted hook_recall.hits[] — the engine's raw top-k,
 * before the hook CLIs apply the score floor, scope filter and per-session
 * dedup — and called it "surfaced". telemetry.ts recordHookHints says that
 * population must not be counted as surfaced, and the word already means the
 * sidecar's actually-injected count in the exposure section. The column is
 * `candidates`.
 *
 * Run: npx tsx --test packages/daemon/__tests__/stats-use-rate-candidates.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const EVENTS = [
  {
    kind: "hook_recall",
    ts: "2026-09-15T10:00:00.000Z",
    session_id: "s1",
    recall_id: "r1",
    hits: [{ id: "a", score: 120 }, { id: "b", score: 50 }, { id: "c", score: 5 }],
  },
];

test("USE-rate labels the raw top-k population `candidates`, not `surfaced`", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-use-rate-"));
  try {
    await writeFile(
      join(logDir, "events-2026-09-15.jsonl"),
      EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
    const { stdout } = await exec(
      process.execPath,
      ["--import", "tsx", join(REPO_ROOT, "packages/daemon/scripts/stats.ts")],
      { cwd: REPO_ROOT, env: { ...process.env, BASTRA_LOG_PATH: logDir } },
    );

    const start = stdout.indexOf("## USE-rate");
    assert.notEqual(start, -1, `expected a USE-rate section:\n${stdout}`);
    const rest = stdout.slice(start + 1);
    const next = rest.indexOf("\n## ");
    const section = next === -1 ? rest : rest.slice(0, next);

    assert.match(section, /required\s+candidates\s+1\b/);
    assert.match(section, /optional\s+candidates\s+1\b/);
    assert.match(section, /below_floor\s+candidates\s+1\b/);
    assert.doesNotMatch(section, /\bsurfaced\b/, `the raw top-k must not be called surfaced:\n${section}`);
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});
