/**
 * #1637 — a short-lived Claude Code subagent can finish before the 25-call
 * cadence ever hands it the rule kernel. SubagentStart gives it the kernel at
 * launch (code.claude.com/docs/en/hooks#subagentstart: `additionalContext`
 * "added to the subagent's context at the start of its conversation").
 *
 * Synthetic host fixture only: no native Claude Code run, no real settings
 * file, no user vault. Resume and native delivery remain unobserved here.
 *
 * Runner: npm test (scripts/test-env.mjs isolates HOME and the logs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hookDefinitions, planHookEntries } from "../src/cli/adapters/claude-code-hooks.js";
import { planCodexHooks } from "../src/cli/adapters/codex-hooks.js";
import { dispatchLaneRoutes } from "../src/http-lane-routes.js";
import { runGateLane } from "../src/gate-lane.js";
import { loadSessionState, mutateSessionState } from "../src/session-state.js";
import type { KernelCandidates } from "../src/rulebook-catalog.js";

const RULE = "Follow the fixture owner rule.";
const catalog: KernelCandidates = {
  entries: [
    {
      id: "fixture-always",
      title: "Fixture",
      group: "explicit",
      body: RULE,
      updated: null,
      stale_status: "unknown",
      rulebook: "always",
      revision: null,
    },
  ],
  omitted: 0,
};
const kernel = async () => catalog;

test.before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-subagent-start-"));
  const prev = { state: process.env.BASTRA_HOOK_STATE_DIR, telemetry: process.env.BASTRA_TELEMETRY };
  process.env.BASTRA_HOOK_STATE_DIR = dir;
  process.env.BASTRA_TELEMETRY = "off";
  test.after(async () => {
    if (prev.state === undefined) delete process.env.BASTRA_HOOK_STATE_DIR;
    else process.env.BASTRA_HOOK_STATE_DIR = prev.state;
    if (prev.telemetry === undefined) delete process.env.BASTRA_TELEMETRY;
    else process.env.BASTRA_TELEMETRY = prev.telemetry;
    await rm(dir, { recursive: true, force: true });
  });
});

const DAEMON = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The /hook/session route on a bare server, with a session notice that
 *  would rewrite the envelope — as the daemon wires it (http-hook-lanes.ts). */
async function sessionRoute(t: { after: (fn: () => Promise<void>) => void }) {
  const server = createServer((req, res) =>
    dispatchLaneRoutes(
      req,
      res,
      "POST",
      "/hook/session",
      undefined,
      async (out) =>
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `${out} task-card` },
        }),
      undefined,
      () => [],
      kernel
    )
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const post = async (payload: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/hook/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
    });
    return response.text();
  };
  return Object.assign(post, { url: `http://127.0.0.1:${address.port}` });
}

/** The host side: the existing `session` subcommand of the stub source. */
function runStub(url: string, payload: unknown): Promise<string> {
  return new Promise((ok, ko) => {
    const child = spawn(process.execPath, ["--import", "tsx", "stub/bastra-hook.ts", "session"], {
      cwd: DAEMON,
      env: { ...process.env, BASTRA_DAEMON_URL: url },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", ko);
    child.on("close", () => ok(out));
    child.stdin.end(JSON.stringify(payload));
  });
}

const start = (session_id: string, extra: Record<string, unknown> = {}) => ({
  session_id,
  transcript_path: "/fixture/transcript.jsonl",
  cwd: "/fixture",
  hook_event_name: "SubagentStart",
  bastra_client: "claude-code",
  agent_id: "fixture-worker",
  agent_type: "Explore",
  ...extra,
});
const read = (session_id: string, actor: Record<string, unknown> = {}) => ({
  hook_event_name: "PreToolUse",
  session_id,
  bastra_client: "claude-code",
  tool_name: "Read",
  tool_input: { file_path: "/fixture.ts" },
  cwd: "/fixture",
  ...actor,
});

test("#1637: a short worker with three reads gets the full kernel at SubagentStart", async (t) => {
  const post = await sessionRoute(t);
  const sid = "short-worker";
  await mutateSessionState(sid, (state) => {
    state.toolCalls = 7;
  });
  const before = JSON.stringify(await loadSessionState(sid));

  const out = JSON.parse(await post(start(sid))) as {
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  };
  assert.equal(out.hookSpecificOutput?.hookEventName, "SubagentStart");
  assert.match(out.hookSpecificOutput?.additionalContext ?? "", new RegExp(RULE.replace(/\./g, "\\.")));
  assert.doesNotMatch(out.hookSpecificOutput?.additionalContext ?? "", /task-card/, "no session-start extras");
  // No fingerprint, no counter, no approval stage: the start answer writes nothing.
  assert.equal(JSON.stringify(await loadSessionState(sid)), before);

  // The worker's three reads stay as they were: below the cadence, nothing.
  const deps = { reflexPool: () => [], kernel };
  for (let i = 0; i < 3; i++) assert.equal(await runGateLane(read(sid, { agent_id: "fixture-worker" }), deps), "{}");
  // The main actor's cadence is untouched by the worker's start.
  assert.equal((await loadSessionState(sid)).toolCalls, 7);
});

test("#1637: the existing stub session subcommand carries SubagentStart to the host", async (t) => {
  const post = await sessionRoute(t);
  const out = JSON.parse(await runStub(post.url, start("stub-worker"))) as {
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  };
  assert.equal(out.hookSpecificOutput?.hookEventName, "SubagentStart");
  assert.match(out.hookSpecificOutput?.additionalContext ?? "", /Follow the fixture owner rule/);
});

test("#1637: without an agent id or a kernel source the start answers {}", async (t) => {
  const post = await sessionRoute(t);
  assert.equal(await post(start("no-agent", { agent_id: undefined })), "{}");
  const bare = createServer((req, res) => dispatchLaneRoutes(req, res, "POST", "/hook/session"));
  t.after(async () => {
    bare.closeAllConnections();
    await new Promise<void>((ok) => bare.close(() => ok()));
  });
  bare.listen(0, "127.0.0.1");
  await once(bare, "listening");
  const address = bare.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/hook/session`, {
    method: "POST",
    body: JSON.stringify({ payload: start("no-kernel") }),
  });
  assert.equal(await response.text(), "{}");
});

test("#1637: the Claude Code installer adds exactly one SubagentStart entry on the session client", () => {
  for (const includeStop of [true, false]) {
    const defs = hookDefinitions({ includeStop });
    const starts = defs.filter((d) => d.event === "SubagentStart");
    assert.equal(starts.length, 1);
    assert.equal(starts[0].matcher, undefined, "every agent type");
    assert.equal(starts[0].stubSubcommand, "session", "served by the existing stub subcommand");
    const plan = planHookEntries("install", {}, { includeStop, stubPresent: false });
    assert.equal(plan.after.SubagentStart.length, 1);
    assert.match(JSON.stringify(plan.after.SubagentStart), /session-hook\.js/);
    const removed = planHookEntries("uninstall", plan.after, { includeStop, stubPresent: false });
    assert.equal(removed.after.SubagentStart.length, 0, "uninstall removes it again");
  }
  const codex = planCodexHooks("install", {}, { includeStop: true, stubPresent: false });
  assert.equal(JSON.stringify(codex.after).includes("SubagentStart"), false, "Codex stays unchanged");
});
