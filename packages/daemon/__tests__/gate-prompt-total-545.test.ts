/**
 * #545 — a prompt hook that never reached the daemon must be able to fail the
 * release gate.
 *
 * The counterexample this file pins was measured, not imagined: six kind-based
 * gate lanes at 40 healthy calls each, plus 40 prompt rows written by a client
 * whose POST never arrived (`status: daemon-unreachable`,
 * `detected_mode: unknown`), rendered every visible lane PASS and printed
 * `gate: MET`. The 40 lost calls appeared in no verdict at all, because the
 * prompt lane is split by trigger class and `unknown` is not one of the
 * classes that carries a threshold.
 *
 * Two halves are pinned here:
 *
 *  1. **Both client shapes say `unknown`.** The stub already did; the node
 *     prompt client stamped `none`. The fix is not the other way round: a
 *     failure whose class was never determined must not be booked into the
 *     silent lane, or assertion and retrieval losses are charged to `none` —
 *     the fault #305 already produced twice with foreign lanes and foreign
 *     sessions.
 *  2. **The gate judges every prompt call once more as one reliability lane**
 *     (`prompt-total`), where an unclassified call counts as a failure.
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

import {
  aggregate,
  renderStats,
  releaseVerdicts,
  releaseGateMet,
  PROMPT_TOTAL_LANE,
  RELEASE_THRESHOLDS,
  MIN_CALLS_FOR_VERDICT,
} from "../src/cli/log-stats.js";
import { CLIENT_ROW_BASE } from "../src/hook-client-telemetry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "src");
const STUB_PATH = resolve(HERE, "..", "stub", "bastra-hook.ts");

/** `n` rows of one kind, a minute apart, well clear of any restart window. */
function lane(kind: string, n: number, over: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    kind,
    ts: `2026-09-06T0${5 + Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}:00.000Z`,
    session_id: `${kind}-${i}`,
    status: "ok",
    hint_count: 1,
    latency_ms_total: 60,
    ...over,
  }));
}

/** The six healthy kind-based lanes of the reproduced window. */
function sixHealthyLanes(): Array<Record<string, unknown>> {
  return [
    ...lane("hook_call", 40, { latency_ms: 60 }),
    ...lane("todo_hook_call", 40, { hit_count: 1 }),
    ...lane("session_hook_call", 40),
    ...lane("bash_hook_call", 40),
    ...lane("bash_fail_hook_call", 40, { hit_count: 1 }),
    ...lane("save_eval_call", 40, { status: undefined, suggested_count: 1, latency_ms_total: 30 }),
  ];
}

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

/** Run one prompt client against a dead daemon and return the rows it wrote. */
async function runPromptClient(argv: string[], sessionId: string): Promise<Array<Record<string, unknown>>> {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-545-"));
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
    child.stdin.write(
      JSON.stringify({
        session_id: sessionId,
        hook_event_name: "UserPromptSubmit",
        prompt: "und was war da nochmal mit der assertion lane",
      }),
    );
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

test("#545: both prompt clients write `unknown`, with the payload's own lane and session", async () => {
  const shapes = [
    { shape: "stub", argv: [STUB_PATH, "prompt"], session: "s545-stub" },
    { shape: "node", argv: [resolve(SRC, "prompt-hook.ts")], session: "s545-node" },
  ];
  const results = await Promise.all(
    shapes.map(async (s) => ({ ...s, rows: await runPromptClient(s.argv, s.session) })),
  );

  for (const { shape, session, rows } of results) {
    assert.equal(rows.length, 1, `${shape}: expected exactly one client row, got ${rows.length}`);
    const row = rows[0]!;
    assert.equal(row.kind, "prompt_hook_call", `${shape}: the row must stay in the prompt lane`);
    // The heart of #545: honest about what it does not know. "none" would file
    // this failure in the silent trigger class and charge it that lane's
    // ceiling — the third repetition of the wrong-lane fault #305 was opened
    // for.
    assert.equal(
      row.detected_mode,
      "unknown",
      `${shape}: a client that never reached the daemon cannot know the trigger class`,
    );
    assert.equal(row.session_id, session, `${shape}: the payload's session must be stamped, not a fresh UUID`);
    assert.match(String(row.hook_version), /-(stub|thin)$/, `${shape}: the row must declare itself a client row`);
    assert.equal(row.status, "daemon-unreachable", `${shape}: a dead daemon is a failure, not a quiet turn`);
    assert.equal(row.daemon_reachable, false);
  }

  // Both shapes agree — the parity that was missing is what made the readout
  // depend on which client happened to be installed.
  assert.equal(results[0]!.rows[0]!.detected_mode, results[1]!.rows[0]!.detected_mode);
  assert.equal(CLIENT_ROW_BASE.prompt.detected_mode, "unknown");
});

test("#545: 40 unreachable prompt calls next to six healthy lanes cannot read `gate: MET`", () => {
  // The reproduced false green, exactly as counter-review pass 6 recorded it.
  const stats = aggregate([
    ...sixHealthyLanes(),
    ...lane("prompt_hook_call", 40, {
      status: "daemon-unreachable",
      hook_version: "0.4.0-stub",
      detected_mode: "unknown",
      hint_count: 0,
      latency_ms_total: 3,
    }),
  ]);
  const rendered = renderStats(stats, 600);

  // The six lanes really are healthy — the window is a false green, not a
  // broken fixture.
  for (const mode of ["pretooluse", "plan", "session", "bash-pre", "bash-post", "stop"]) {
    assert.match(rendered, new RegExp(`${mode}\\s+\\d+ms budget[^\\n]*— PASS`), `${mode} must be green here`);
  }
  assert.equal(stats.promptTotal.calls, 40);
  assert.equal(stats.promptTotal.errors, 40);
  assert.match(rendered, /prompt-total[^\n]*— FAIL: 40\/40 calls returned nothing/);
  assert.match(rendered, /gate: NOT MET/, "40 lost prompt calls must not render a met release gate");
});

test("#545: an unclassified prompt call fails prompt-total even without a failure status", () => {
  // A client row whose POST is recorded as anything but a failure is still a
  // call nobody classified: the lane did not serve it.
  const stats = aggregate(lane("prompt_hook_call", 40, { detected_mode: "unknown", status: "ok" }));
  assert.equal(stats.promptTotal.calls, 40);
  assert.equal(stats.promptTotal.errors, 40);
  const verdict = releaseVerdicts(stats.lanes, stats.promptTotal).find((v) => v.mode === PROMPT_TOTAL_LANE)!;
  assert.equal(verdict.verdict, "fail");
  // In the class lanes it stays what its status says — moving it there would
  // be the wrong-lane fault again, one level down.
  const unknownLane = stats.lanes.find((l) => l.mode === "unknown")!;
  assert.equal(unknownLane.errors, 0, "the unknown class lane must not be rewritten, only judged elsewhere");
});

test("#545: prompt-total is a reliability lane — no p90 target, min-N and ceiling stated", () => {
  const t = RELEASE_THRESHOLDS[PROMPT_TOTAL_LANE]!;
  assert.equal(t.p90TargetMs, null, "a p90 over mixed trigger classes measures the week's prompt mix, not the lane");
  // It counts the same calls as the class lanes, and the assertion class is
  // granted 5%. A stricter ceiling here would fail a window every class lane
  // passes.
  assert.equal(t.maxFailureRate, 0.05);
  assert.equal(
    t.maxFailureRate,
    Math.max(...Object.entries(RELEASE_THRESHOLDS).filter(([m]) => m !== PROMPT_TOTAL_LANE).map(([, v]) => v.maxFailureRate)),
    "prompt-total must not be stricter than the most permissive class lane it re-counts",
  );

  // Below the shared min-N it is NOT EVALUABLE — not a pass, and never silent.
  const thin = aggregate(lane("prompt_hook_call", MIN_CALLS_FOR_VERDICT - 1, { detected_mode: "none" }));
  const rendered = renderStats(thin, 600);
  assert.match(
    rendered,
    new RegExp(`${PROMPT_TOTAL_LANE}[^\\n]*— NOT EVALUABLE \\(29 call\\(s\\) of the min-N ${MIN_CALLS_FOR_VERDICT}\\)`),
  );
  assert.equal(releaseGateMet(releaseVerdicts(thin.lanes, thin.promptTotal)), false);
});

test("#545: prompt-total re-counts the class lanes' calls and says so, without inflating any total", () => {
  // The one place the same row is counted twice, deliberately: once in its
  // trigger class, once in the delivery series. Neither the lane table nor the
  // totals line may grow because of it.
  const window = [
    ...sixHealthyLanes(),
    ...lane("prompt_hook_call", 30, { detected_mode: "assertion", latency_ms_total: 700 }),
    ...lane("prompt_hook_call", 30, { detected_mode: "none", latency_ms_total: 80, hint_count: 0 }),
  ];
  const stats = aggregate(window);
  assert.equal(stats.totals.calls, 6 * 40 + 60, "prompt-total must not appear in the lane table or the totals");
  assert.equal(stats.lanes.some((l) => l.mode === PROMPT_TOTAL_LANE), false);
  assert.equal(stats.promptTotal.calls, 60);

  const rendered = renderStats(stats, 600);
  assert.match(rendered, /prompt delivery \(#545\) — every prompt call, all trigger classes together/);
  assert.match(rendered, /the same calls as the prompt lanes above, counted once more as one delivery series/);
  assert.match(rendered, new RegExp(`${PROMPT_TOTAL_LANE}[^\\n]*— PASS`));
  assert.match(rendered, /assertion\s+\d+ms budget · p90 ≤ \d+ms[^\n]*— PASS/, "class lanes keep their own latency bar");
  assert.match(rendered, /gate: MET/, "a healthy window must still be able to pass");
});
