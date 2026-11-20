/**
 * #1525: the timing half of the gate lane characterization. The state golden
 * (`gate-lane-state-golden.test.ts`) pins the clock and never lets the gate
 * run out of time; this file pins the fail-open path when it does: a gate
 * whose budget is spent before its locked claim passes the call, claims
 * nothing and says so in telemetry.
 *
 * No wall clock: `Date` is mocked. Time spent before the claim is injected
 * through the reflex-pool seam, which the gate calls after it read its start
 * time and before the locked mutation.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGateLane, type GateDeps } from "../src/gate-lane.js";
import { bookPendingMustLoad, loadSessionState, mutateSessionState } from "../src/session-state.js";

const T0 = 1_800_000_000_000;

interface Run {
  output: Record<string, unknown>;
  telemetry: Array<Record<string, unknown>>;
  pending: string[];
  claimed: string[];
}

/** One gate call on a session with two pending must-load hints. */
async function gateCall(t: TestContext, o: { spentBefore?: number; deadline?: number }): Promise<Run> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-1525-gate-timing-"));
  const prev = { state: process.env.BASTRA_HOOK_STATE_DIR, telemetry: process.env.BASTRA_TELEMETRY };
  process.env.BASTRA_HOOK_STATE_DIR = dir;
  process.env.BASTRA_TELEMETRY = "off";
  try {
    const sid = "gate-timing-1525";
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    await mutateSessionState(sid, (s) => bookPendingMustLoad(s, ["m1", "m2"], "prompt:test"));
    const telemetry: Array<Record<string, unknown>> = [];
    const deps: GateDeps = {
      reflexPool: () => {
        if (o.spentBefore) t.mock.timers.tick(o.spentBefore);
        return [];
      },
      telemetry: async (fields) => {
        telemetry.push(fields);
      },
      ...(o.deadline === undefined ? {} : { deadline: o.deadline }),
    };
    const out = await runGateLane(
      {
        hook_event_name: "PreToolUse",
        session_id: sid,
        tool_name: "Bash",
        tool_input: { command: "ls" },
        bastra_client: "claude-code",
      },
      deps
    );
    const state = await loadSessionState(sid);
    t.mock.timers.reset();
    return {
      output: JSON.parse(out) as Record<string, unknown>,
      telemetry,
      pending: (state.pendingMustLoad ?? []).map((e) => e.id),
      claimed: [...(state.claimedMustLoad ?? [])],
    };
  } finally {
    if (prev.state === undefined) delete process.env.BASTRA_HOOK_STATE_DIR;
    else process.env.BASTRA_HOOK_STATE_DIR = prev.state;
    if (prev.telemetry === undefined) delete process.env.BASTRA_TELEMETRY;
    else process.env.BASTRA_TELEMETRY = prev.telemetry;
    await rm(dir, { recursive: true, force: true });
  }
}

const denied = (r: Run) =>
  (r.output.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === "deny";

/**
 * #1672: at exactly 500 ms the locked write gives up (`>=` its deadline,
 * session-state/store.ts) and the label counts the same deadline, so it says
 * `gate_timeout`. The answer is fail-open either way.
 */
function assertPassedUnclaimed(r: Run, label: "gate_timeout"): void {
  assert.deepEqual(r.output, {});
  assert.deepEqual(r.claimed, []);
  assert.deepEqual(r.pending, ["m1", "m2"]);
  assert.equal(r.telemetry.length, 1);
  assert.equal(r.telemetry[0].outcome, "pass");
  assert.equal(r.telemetry[0].non_conformance, label);
  assert.deepEqual(r.telemetry[0].unclaimed_must_load_ids, ["m1", "m2"]);
}

test("#1525 timing: 1 ms inside the 500 ms gate budget the pending hints are claimed into a deny", async (t) => {
  const r = await gateCall(t, { spentBefore: 499 });
  assert.equal(denied(r), true);
  assert.deepEqual(r.claimed, ["m1", "m2"]);
  assert.deepEqual(r.pending, []);
});

test("#1525 fail-open: once the 500 ms gate budget is spent the call passes and nothing is claimed", async (t) => {
  assertPassedUnclaimed(await gateCall(t, { spentBefore: 500 }), "gate_timeout");
  assertPassedUnclaimed(await gateCall(t, { spentBefore: 501 }), "gate_timeout");
  assertPassedUnclaimed(await gateCall(t, { spentBefore: 2000 }), "gate_timeout");
});

test("#1525 fail-open: a caller's absolute deadline counts the same way, at exactly that instant", async (t) => {
  const inTime = await gateCall(t, { deadline: T0 + 1 });
  assert.equal(denied(inTime), true);
  assertPassedUnclaimed(await gateCall(t, { deadline: T0 }), "gate_timeout");
  // The earlier of the two limits wins: a far deadline does not extend the 500 ms.
  assertPassedUnclaimed(await gateCall(t, { deadline: T0 + 10_000, spentBefore: 500 }), "gate_timeout");
  assertPassedUnclaimed(await gateCall(t, { deadline: T0 + 10_000, spentBefore: 501 }), "gate_timeout");
});
