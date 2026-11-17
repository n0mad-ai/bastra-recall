/**
 * #1525: golden master for what the gate lane's locked state mutation leaves
 * on disk, recorded before the callback was cut into named steps. Each
 * scenario runs `runGateLane` in-process with the clock pinned and snapshots
 * the answer and the persisted session state; only random tokens are
 * normalized.
 *
 * Update (only for an intended behaviour change):
 *   node --import tsx --import ./scripts/test-env.mjs --test --test-update-snapshots \
 *     packages/daemon/__tests__/gate-lane-state-golden.test.ts
 */
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Memory } from "@bastra-recall/core";
import { actionReflexPool, runGateLane, type GateDeps } from "../src/gate-lane.js";
import { bookPendingMustLoad, loadSessionState, mutateSessionState, type SessionState } from "../src/session-state.js";

const NOW = 1_800_000_000_000;

const RULE = {
  fm: {
    id: "rule-send",
    title: "Title rule-send",
    type: "workflow",
    scope: "all-projects",
    summary: "Summary rule-send",
    recall_mode: "reflex",
    write_origin: "user-directed",
    salience: 0.9,
    recall_when: ["fixture_send_message"],
  },
  body: "Never call fixture_send_message without an approved copy.",
} as unknown as Memory;

interface Scenario {
  name: string;
  tool: string;
  input: Record<string, unknown>;
  extra?: Record<string, unknown>;
  setup?: (s: SessionState) => void;
  deps: Omit<GateDeps, "reflexPool" | "telemetry"> & { reflex?: boolean };
  runs?: number;
}

const ACTION = { ids: ["fixture-issue-rule", "fixture-other-rule"], key: "github-action-conventions-v2:main" };

const SCENARIOS: Scenario[] = [
  {
    name: "pending must-load is claimed into a deny",
    tool: "Bash",
    input: { command: "ls" },
    setup: (s) => bookPendingMustLoad(s, ["m1", "m2"], "prompt:test"),
    deps: {},
  },
  {
    name: "a subagent leaves the pending must-load alone",
    tool: "Bash",
    input: { command: "ls" },
    extra: { agent_id: "sub-1", agent_type: "general-purpose" },
    setup: (s) => bookPendingMustLoad(s, ["m1"], "prompt:test"),
    deps: {},
  },
  {
    name: "reflex claim records denied and active conventions",
    tool: "fixture_send_message",
    input: { text: "hi" },
    deps: { reflex: true },
    runs: 2,
  },
  {
    name: "must-load, reflex and action rules in one call",
    tool: "fixture_send_message",
    input: { command: "gh issue create" },
    setup: (s) => bookPendingMustLoad(s, ["m1"], "prompt:test"),
    deps: { reflex: true, actionMustLoad: { ...ACTION, revisions: new Map([["fixture-issue-rule", "sha256:A"]]) } },
    runs: 2,
  },
  {
    name: "action rules alone become context, a stale foreign attempt is dropped",
    tool: "Bash",
    input: { command: "gh issue create" },
    setup: (s) => {
      s.constants = {
        [`${ACTION.key}:attempt:old-rule`]: JSON.stringify({ token: "x", deadline: 0, delivered: false, newClaim: true }),
        [`${ACTION.key}:scope`]: JSON.stringify(["other-context", 1]),
      };
      s.claimedMustLoad = ["old-rule"];
    },
    deps: { actionMustLoad: ACTION },
  },
  {
    name: "a tool count without a kernel only counts",
    tool: "Bash",
    input: { command: "ls" },
    setup: (s) => {
      s.toolCalls = 3;
    },
    deps: { countTool: true },
  },
];

function normalize(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("{") || value.startsWith("[")) {
      try {
        return normalize(JSON.parse(value));
      } catch {
        // plain text
      }
    }
    return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof Map) return normalize(Object.fromEntries(value));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v);
    return out;
  }
  return value;
}

for (const sc of SCENARIOS) {
  test(`#1525 gate state golden — ${sc.name}`, async (t) => {
    t.mock.method(Date, "now", () => NOW);
    const dir = await mkdtemp(join(tmpdir(), "bastra-1525-gate-"));
    const prev = { state: process.env.BASTRA_HOOK_STATE_DIR, telemetry: process.env.BASTRA_TELEMETRY };
    process.env.BASTRA_HOOK_STATE_DIR = dir;
    process.env.BASTRA_TELEMETRY = "off";
    t.after(async () => {
      if (prev.state === undefined) delete process.env.BASTRA_HOOK_STATE_DIR;
      else process.env.BASTRA_HOOK_STATE_DIR = prev.state;
      if (prev.telemetry === undefined) delete process.env.BASTRA_TELEMETRY;
      else process.env.BASTRA_TELEMETRY = prev.telemetry;
      await rm(dir, { recursive: true, force: true });
    });
    const sid = `gate-golden-${sc.name.replace(/[^a-z0-9]+/gi, "-")}`;
    if (sc.setup) await mutateSessionState(sid, sc.setup);
    const { reflex, ...deps } = sc.deps;
    const outputs: unknown[] = [];
    for (let i = 0; i < (sc.runs ?? 1); i++) {
      const out = await runGateLane(
        {
          hook_event_name: "PreToolUse",
          session_id: sid,
          tool_name: sc.tool,
          tool_input: sc.input,
          bastra_client: "claude-code",
          ...sc.extra,
        },
        { ...deps, reflexPool: () => (reflex ? actionReflexPool([RULE]) : []), telemetry: async () => {} }
      );
      outputs.push(JSON.parse(out) as unknown);
    }
    t.assert.snapshot(normalize({ outputs, state: await loadSessionState(sid) }));
  });
}
