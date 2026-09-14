/**
 * #543 — every gate lane must leave a client row behind when the daemon is
 * unreachable, on BOTH client shapes.
 *
 * The compiled stub and the node thin clients run the same six automatic
 * lanes. Before this, four of twelve combinations wrote a row: the stub for
 * prompt/write/bash-pre/bash-fail, the node clients for prompt/write only.
 * Since #305 every automatic lane carries a threshold, so a lane that writes
 * nothing on a transport failure loses the failed calls from BOTH halves of
 * its ratio — no failure row, and a denominator shorter by exactly the calls
 * that were lost. It then reports PASS while calls disappear, which is worse
 * than having no gate for it at all.
 *
 * The rows are produced here for real — a spawned client process against a
 * port nothing listens on — instead of being described, because the two
 * faults this lane class has had (`ea95691`: a synthetic session that could
 * not be folded; `2b7d285`: a row filed under a foreign lane) are both
 * invisible to a test that builds the row itself.
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
import { CLIENT_ROW_BASE, type ClientLane } from "../src/hook-client-telemetry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "src");
const STUB_PATH = resolve(HERE, "..", "stub", "bastra-hook.ts");

/**
 * The six automatic lanes, each with the client subcommand (stub), the node
 * client file, and the gate lane its event kind maps to.
 *
 * This map is also the drift guard: a lane added to `GATE_LANE_BY_KIND`
 * without an entry here fails the first test below, so the next new lane
 * cannot go unmeasured on either client shape the way these five did.
 */
const LANES: Array<{ lane: ClientLane; kind: string; nodeClient: string }> = [
  { lane: "write", kind: "hook_call", nodeClient: "hook.ts" },
  { lane: "todo", kind: "todo_hook_call", nodeClient: "todo-hook.ts" },
  { lane: "session", kind: "session_hook_call", nodeClient: "session-hook.ts" },
  { lane: "bash-pre", kind: "bash_hook_call", nodeClient: "bash-pre-hook.ts" },
  { lane: "bash-fail", kind: "bash_fail_hook_call", nodeClient: "bash-fail-hook.ts" },
  { lane: "stop", kind: "save_eval_call", nodeClient: "stop-hook.ts" },
];

/** The stdin one lane expects. Nothing here may be filtered out client-side,
 *  or the call would never reach the transport whose failure is under test. */
const PAYLOAD: Record<ClientLane, Record<string, unknown>> = {
  prompt: { hook_event_name: "UserPromptSubmit", prompt: "und was war da nochmal" },
  write: {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/bastra-543/app.ts", content: "export const a = 1;\n" },
  },
  "bash-pre": {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /tmp/nothing" },
  },
  "bash-fail": {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls /nope" },
    tool_response: { exit_code: 2 },
  },
  stop: { hook_event_name: "Stop", transcript_path: "/tmp/bastra-543/missing.jsonl" },
  session: { hook_event_name: "SessionStart", source: "startup" },
  todo: {
    hook_event_name: "PostToolUse",
    tool_name: "TodoWrite",
    tool_input: { todos: [{ content: "measure the lane", status: "pending" }] },
  },
};

/** A port nothing listens on, so the POST fails the way a down daemon makes it
 *  fail. Taken by binding and releasing, not guessed. */
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

/** Run one client against a dead daemon and return the rows it wrote. */
async function runClient(argv: string[], lane: ClientLane, sessionId: string): Promise<Array<Record<string, unknown>>> {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-543-"));
  const port = await closedPort();
  await new Promise<void>((ok, ko) => {
    const child = spawn("npx", ["tsx", ...argv], {
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
    child.stdin.write(JSON.stringify({ session_id: sessionId, ...PAYLOAD[lane] }));
    child.stdin.end();
  });
  const rows: Array<Record<string, unknown>> = [];
  for (const file of (await readdir(logDir)).filter((f) => f.startsWith("events-"))) {
    for (const line of (await readFile(join(logDir, file), "utf8")).split("\n")) {
      if (line.trim()) rows.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return rows;
}

test("#543: every gate lane writes one client row on both client shapes, with its own lane and session", async () => {
  // Drift guard: the table above must cover every lane the release gate reads.
  const covered = new Set(LANES.map((l) => l.kind));
  for (const kind of Object.keys(GATE_LANE_BY_KIND)) {
    assert.ok(
      covered.has(kind),
      `gate lane \`${GATE_LANE_BY_KIND[kind]}\` (${kind}) is not covered here — a new lane must write a client row on both client shapes`,
    );
  }

  const shapes = LANES.flatMap(({ lane, kind, nodeClient }) => [
    { lane, kind, shape: "stub", argv: [STUB_PATH, lane], session: `s543-stub-${lane}` },
    { lane, kind, shape: "node", argv: [resolve(SRC, nodeClient)], session: `s543-node-${lane}` },
  ]);
  const results = await Promise.all(
    shapes.map(async (s) => ({ ...s, rows: await runClient(s.argv, s.lane, s.session) })),
  );

  for (const { lane, kind, shape, session, rows } of results) {
    assert.equal(rows.length, 1, `${shape}/${lane}: expected exactly one client row, got ${rows.length}`);
    const row = rows[0]!;
    // The lane: a row filed under a foreign kind is counted against a lane the
    // failure did not happen in, and leaves the real one looking healthy.
    assert.equal(row.kind, kind, `${shape}/${lane}: wrong event kind — this row would land in another lane`);
    assert.equal(GATE_LANE_BY_KIND[String(row.kind)], GATE_LANE_BY_KIND[kind]);
    // The session: the only thing that ties this row to the daemon row for the
    // same call. A synthetic one makes the row unfoldable (#356/#305).
    assert.equal(row.session_id, session, `${shape}/${lane}: the payload's session must be stamped, not a fresh UUID`);
    assert.match(
      String(row.hook_version),
      /-(stub|thin)$/,
      `${shape}/${lane}: the row must declare itself a client row, or it cannot be folded`,
    );
    assert.ok(
      ["daemon-unreachable", "timeout", "error"].includes(String(row.status)),
      `${shape}/${lane}: a dead daemon must be recorded as a failure, got ${String(row.status)}`,
    );
    assert.equal(row.daemon_reachable, false, `${shape}/${lane}: the POST went out and got no answer`);
  }
});

test("#543: a client-side failure can turn its own lane's gate red", async () => {
  // One real row per lane and client shape, replicated to the min-N. Without
  // the fix the five silent combinations produce no row at all: the lane keeps
  // only its delivered calls, reports 0% failures and PASSES while calls are
  // being lost.
  for (const { lane, kind, nodeClient } of LANES) {
    for (const [shape, argv] of [
      ["stub", [STUB_PATH, lane]],
      ["node", [resolve(SRC, nodeClient)]],
    ] as Array<[string, string[]]>) {
      const rows = await runClient(argv, lane, `s543-gate-${shape}-${lane}`);
      assert.equal(rows.length, 1, `${shape}/${lane}: no client row to judge`);
      const gateLane = GATE_LANE_BY_KIND[kind]!;
      const window = Array.from({ length: 40 }, (_, i) => ({
        ...rows[0]!,
        session_id: `${shape}-${lane}-${i}`,
        ts: `2026-09-06T05:${String(i % 60).padStart(2, "0")}:00.000Z`,
      }));
      const rendered = renderStats(aggregate(window), 600);
      assert.match(
        rendered,
        new RegExp(`${gateLane}\\s+\\d+ms budget[^\\n]*— FAIL: 40/40 calls returned nothing`),
        `${shape}/${lane}: a client-side failure must be able to fail the ${gateLane} gate`,
      );
      assert.match(rendered, /gate: NOT MET/);
    }
  }
});

test("#543: every gate lane has a client row shape and a client that writes it", async () => {
  // The structural half of the drift guard: the spawned test above proves the
  // six lanes that exist today; this one fails the moment a SEVENTH gate lane
  // is added without a row shape or without a client writing it — the exact
  // way plan, session and stop came to be silent after #369.
  const shapesByKind = new Map(Object.values(CLIENT_ROW_BASE).map((base) => [String(base.kind), base]));
  for (const [kind, gateLane] of Object.entries(GATE_LANE_BY_KIND)) {
    assert.ok(shapesByKind.has(kind), `gate lane \`${gateLane}\` has no client row shape for \`${kind}\``);
  }

  // The stub: one subcommand per lane, and no lane excluded from logging.
  const stub = await readFile(STUB_PATH, "utf8");
  const declared = /const LANES = new Set<Lane>\(\[([\s\S]*?)\]\)/.exec(stub);
  assert.ok(declared, "could not find the stub's lane list");
  for (const lane of Object.keys(CLIENT_ROW_BASE)) {
    assert.match(declared[1]!, new RegExp(`"${lane}"`), `the stub has no \`${lane}\` subcommand`);
  }

  // The node clients: each gate lane's own file must write its own lane's row.
  for (const { lane, nodeClient } of LANES) {
    const src = await readFile(resolve(SRC, nodeClient), "utf8");
    assert.match(
      src,
      new RegExp(`writeClientTelemetry\\(\\s*\\n?\\s*(\\{[\\s\\S]{0,400}?)?"${lane}"`),
      `${nodeClient} does not write a client row for the ${lane} lane`,
    );
  }
});
