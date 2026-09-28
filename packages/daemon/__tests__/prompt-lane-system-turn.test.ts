/**
 * #703: the prompt lane skips turns nobody typed — task notifications and
 * agent mail — with the same predicate the Stop lane uses (system-turn.ts).
 * Own file because prompt-lane.test.ts is past the size ceiling; the helpers
 * below are the minimal copies of its mock daemon and runner.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { runPromptLane } from "../src/prompt-lane.js";
import { isSystemInjectedTurn } from "../src/system-turn.js";

function startMockDaemon(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  return new Promise<{ port: number; close: () => Promise<void> }>((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      ok({ port, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

/** Records every request that is not reflex/hinted — i.e. every recall. */
async function startRecallMock(recall: object) {
  const bodies: { query: string }[] = [];
  const daemon = await startMockDaemon((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/hook/reflex") return void res.end('{"hits":[],"recall_id":null}');
      if (req.url === "/hook/hinted") return void res.end('{"ok":true}');
      bodies.push(JSON.parse(body) as { query: string });
      res.end(JSON.stringify({ vault_size: 10, latency_ms: 1, recall_id: "r", ...recall }));
    });
  });
  return { daemon, bodies };
}

const STRONG_HIT = { id: "strong-fact", title: "T", type: "project-fact", scope: "p", summary: "s", score: 142 };

async function runHook(payload: object, env: Record<string, string>): Promise<{ stdout: string }> {
  const applied: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    applied[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const stdout = await runPromptLane(payload as Parameters<typeof runPromptLane>[0], null, env.BASTRA_HTTP_URL!);
    return { stdout };
  } finally {
    for (const [k, v] of Object.entries(applied)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function readTelemetryEvents(dir: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const f of (await readdir(dir)).filter((n) => n.startsWith("events-") && n.endsWith(".jsonl"))) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) {
      if (line.trim()) out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
}

// ─── #703: turns nobody typed do not recall ──────────────────────────────
//
// Claude Code delivers task notifications and agent mail as user-role turns.
// The Stop lane has skipped them since #639/#649; the prompt lane recalled on
// them like owner prompts. Shapes below are the ones stop-hook.test.ts pins.

const SYSTEM_TURNS: Array<[string, string]> = [
  [
    "task-notification",
    "<task-notification>\n<task-id>b7bggcsa4</task-id>\n<summary>Agent finished: where is the lease agreement?</summary>\n</task-notification>",
  ],
  ["teammate-message", '<teammate-message teammate_id="worker" color="blue">where is the lease agreement?</teammate-message>'],
  [
    "teammate-message after wrapper",
    'Another Claude session sent a message:\n<teammate-message teammate_id="worker">where is the lease agreement?</teammate-message>',
  ],
  ["agent-message", '<agent-message from="impl-50">where is the lease agreement?</agent-message>'],
  [
    "agent-message after wrapper",
    'Another Claude session sent a message:\n<agent-message from="impl-50">where is the lease agreement?</agent-message>',
  ],
  ["cross-session-message", '<cross-session-message from="main">where is the lease agreement?</cross-session-message>'],
  [
    "cross-session-message after wrapper",
    'Another Claude session sent a message:\n<cross-session-message from="main">where is the lease agreement?</cross-session-message>',
  ],
];

for (const [shape, prompt] of SYSTEM_TURNS) {
  test(`#703 — ${shape}: no recall, no hint, telemetry marks origin system`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "bastra-703-"));
    const logDir = await mkdtemp(join(tmpdir(), "bastra-703-log-"));
    const { daemon, bodies } = await startRecallMock({ hits: [STRONG_HIT] });
    try {
      assert.equal(isSystemInjectedTurn(prompt), true);
      const { stdout } = await runHook(
        { hook_event_name: "UserPromptSubmit", session_id: "s703", prompt: `  ${prompt}`, cwd: process.cwd() },
        {
          BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}`,
          BASTRA_HOOK_STATE_DIR: stateDir,
          BASTRA_TELEMETRY: "on",
          BASTRA_LOG_PATH: logDir,
        },
      );
      assert.equal(stdout.trim(), "{}");
      assert.equal(bodies.length, 0, "the daemon was never asked to recall");
      const events = (await readTelemetryEvents(logDir)).filter((e) => e.kind === "prompt_hook_call");
      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.status, "gated");
      assert.equal(ev.gated, true);
      assert.equal(ev.gated_reason, "system-injected");
      assert.equal(ev.origin, "system");
      assert.equal(ev.hint_count, 0);
      assert.equal(ev.hint_tokens_est, 0);
      assert.equal(ev.session_id, "s703");
    } finally {
      await daemon.close();
      await rm(stateDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });
}

test("#703 — an owner prompt that quotes a tag still recalls, and its event carries no origin", async () => {
  const prompts = [
    "why did `<task-notification>` fire twice? where is the lease agreement?",
    'where is the lease agreement? the agent sent <agent-message from="x"> again',
    "Another Claude session sent a message: where is the lease agreement?",
  ];
  for (const prompt of prompts) {
    assert.equal(isSystemInjectedTurn(prompt), false, prompt);
    const stateDir = await mkdtemp(join(tmpdir(), "bastra-703-owner-"));
    const logDir = await mkdtemp(join(tmpdir(), "bastra-703-owner-log-"));
    const { daemon, bodies } = await startRecallMock({ hits: [STRONG_HIT] });
    try {
      const { stdout } = await runHook(
        { hook_event_name: "UserPromptSubmit", session_id: "s703o", prompt, cwd: process.cwd() },
        {
          BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}`,
          BASTRA_HOOK_STATE_DIR: stateDir,
          BASTRA_TELEMETRY: "on",
          BASTRA_LOG_PATH: logDir,
        },
      );
      assert.equal(bodies.length, 1, `recall ran for: ${prompt}`);
      assert.match(stdout, /strong-fact/);
      const ev = (await readTelemetryEvents(logDir)).find((e) => e.kind === "prompt_hook_call");
      assert.ok(ev);
      assert.equal(ev.origin, undefined);
      assert.notEqual(ev.status, "gated");
    } finally {
      await daemon.close();
      await rm(stateDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  }
});
