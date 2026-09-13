/**
 * #305 — which lane a CLIENT row says it belongs to.
 *
 * The stub writes its own telemetry row for the calls the daemon cannot log,
 * and that row names a lane. Twice now that name was wrong, with the same
 * consequence both times: a failure counted against a lane it did not happen
 * in, and the lane it DID happen in looking healthy.
 *
 *   · the prompt branch wrote `detected_mode: "none"`, so every client-side
 *     prompt failure landed in the silent lane (fixed earlier in #305)
 *   · `bash-pre` and `bash-fail` fell into the write lane's branch and wrote
 *     `kind: "hook_call"`, so every client-side failure of the two Bash lanes
 *     was filed under Write/Edit — and the two Bash gates, which #305 had just
 *     armed, could not turn red for anything the client sees
 *
 * The stub is compiled with `deno compile`, but the file runs unchanged on
 * node, so the row is produced here for real instead of being described.
 *
 * Runner: npm test (never `npx tsx --test` directly — that bypasses
 * scripts/test-env.mjs and writes into the real telemetry log).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { aggregate, renderStats, GATE_LANE_BY_KIND } from "../src/cli/log-stats.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB_PATH = resolve(HERE, "..", "stub", "bastra-hook.ts");

/** A port nothing listens on, so the stub's POST fails the way a down daemon
 *  makes it fail. Taken by binding and releasing, not guessed. */
async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      ok(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  await new Promise<void>((ok) => server.close(() => ok()));
  return port;
}

/** Run one stub lane against a dead daemon and return the row it wrote. */
async function runLane(lane: string, sessionId: string): Promise<Record<string, unknown>> {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-stub-telemetry-"));
  const port = await closedPort();
  await new Promise<void>((ok, ko) => {
    const child = spawn("npx", ["tsx", STUB_PATH, lane], {
      env: {
        ...process.env,
        BASTRA_LOG_PATH: logDir,
        BASTRA_DAEMON_URL: `http://127.0.0.1:${port}`,
        BASTRA_TELEMETRY: "on",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.on("error", ko);
    child.on("close", () => ok());
    child.stdin.write(
      JSON.stringify({
        session_id: sessionId,
        hook_event_name: lane === "bash-pre" ? "PreToolUse" : "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/nothing" },
      }),
    );
    child.stdin.end();
  });
  const files = (await readdir(logDir)).filter((f) => f.startsWith("events-"));
  assert.equal(files.length, 1, `${lane}: expected exactly one event file, got ${files.join(", ") || "none"}`);
  const lines = (await readFile(join(logDir, files[0]), "utf8")).split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 1, `${lane}: expected exactly one client row`);
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

test("#305: a client-side Bash failure is written into the Bash lane, not the write lane", async () => {
  const pre = await runLane("bash-pre", "session-bash-pre");
  const post = await runLane("bash-fail", "session-bash-post");

  assert.equal(pre.kind, "bash_hook_call", "a PreToolUse Bash failure is not a Write/Edit call");
  assert.equal(post.kind, "bash_fail_hook_call", "a PostToolUse Bash failure is not a Write/Edit call");
  assert.equal(pre.session_id, "session-bash-pre");
  assert.equal(post.session_id, "session-bash-post");
  for (const row of [pre, post]) {
    assert.match(String(row.hook_version), /-stub$/, "the row must declare itself a client row, or it cannot be folded");
    assert.ok(
      ["daemon-unreachable", "timeout", "error"].includes(String(row.status)),
      `a dead daemon must be recorded as a failure, got ${String(row.status)}`,
    );
  }

  // …and arriving in the right lane is what lets that lane's gate go red.
  const rows = (row: Record<string, unknown>, mode: string): Array<Record<string, unknown>> =>
    Array.from({ length: 40 }, (_, i) => ({
      ...row,
      session_id: `${mode}-${i}`,
      ts: `2026-09-06T05:${String(i % 60).padStart(2, "0")}:00.000Z`,
    }));
  const rendered = renderStats(aggregate([...rows(pre, "pre"), ...rows(post, "post")]), 600);
  assert.match(rendered, /bash-pre\s+500ms budget[^\n]*— FAIL: 40\/40 calls returned nothing/);
  assert.match(rendered, /bash-post\s+500ms budget[^\n]*— FAIL: 40\/40 calls returned nothing/);
  assert.match(rendered, /gate: NOT MET/);
});

test("#305: no two stub lanes write the same event kind", async () => {
  // Drift guard over the whole table, not just the two lanes that were wrong.
  // Sharing one kind is precisely how a Bash failure came to be counted as a
  // Write/Edit one, and the next lane added to the stub would inherit it from
  // whatever branch it fell into.
  const src = await readFile(STUB_PATH, "utf8");
  const table = /const CLIENT_ROW_BASE: Record<string, Record<string, unknown>> = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(table, "could not find CLIENT_ROW_BASE in stub/bastra-hook.ts");
  const entries = [...table[1].matchAll(/^ {2}"?([a-z-]+)"?:[\s\S]*?kind: "([a-z_]+)"/gm)].map((m) => [m[1], m[2]]);
  assert.equal(entries.length, 4, `expected one row shape per client-logging lane, got ${JSON.stringify(entries)}`);
  const kinds = entries.map(([, kind]) => kind);
  assert.equal(new Set(kinds).size, kinds.length, `two lanes share one event kind: ${JSON.stringify(entries)}`);
  for (const [lane, kind] of entries) {
    // Every client kind must be one the readout counts as a lane; the prompt
    // hook is the one that splits into trigger classes instead.
    assert.ok(
      kind === "prompt_hook_call" || GATE_LANE_BY_KIND[kind] !== undefined,
      `${lane} writes \`${kind}\`, which no lane of the release gate counts`,
    );
  }
});
