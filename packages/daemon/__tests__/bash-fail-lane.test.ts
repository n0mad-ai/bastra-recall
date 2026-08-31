import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises";
import {
  invokesOwnBinary,
  readExitCode,
  extractErrorContext,
  extractCommandHead,
  extractErrorKeywords,
  formatHintBlock,
  normalizeToolResponse,
  isThrottled,
  markThrottle,
  throttleFile,
  runBashFailLane,
} from "../src/bash-fail-lane.js";

const SESSION = "test-session-fail-hook";

async function clearThrottle(): Promise<void> {
  try {
    await unlink(throttleFile(SESSION));
  } catch {
    // ignore
  }
}

describe("bash-fail-hook: readExitCode", () => {
  it("reads exit_code from numeric field", () => {
    assert.equal(readExitCode({ exit_code: 1 }), 1);
  });
  it("reads from camelCase exitCode", () => {
    assert.equal(readExitCode({ exitCode: 2 }), 2);
  });
  it("parses string exit codes", () => {
    assert.equal(readExitCode({ exit_code: "127" }), 127);
  });
  it("returns null when missing", () => {
    assert.equal(readExitCode({}), null);
  });
  it("reads Codex plain-text tool responses", () => {
    assert.equal(readExitCode(normalizeToolResponse("Process exited with code 17\nError: failed")), 17);
  });
  it("reads Claude Code PostToolUseFailure's official non-zero status wording", () => {
    assert.equal(readExitCode({ error: "Command exited with non-zero status code 7" }), 7);
  });
});

describe("bash-fail-hook: extractCommandHead", () => {
  it("returns first 3 tokens of first clause", () => {
    assert.equal(extractCommandHead("npm install --save react"), "npm install --save");
  });
  it("stops at pipeline operators", () => {
    assert.equal(extractCommandHead("ls -la | grep foo"), "ls -la");
  });
});

describe("bash-fail-hook: extractErrorContext", () => {
  it("prefers error/Failed/fatal lines", () => {
    const out = extractErrorContext({
      stderr: "doing things\nthings happen\nError: ENOENT no such file\ndone",
    });
    assert.match(out, /Error: ENOENT/);
  });
  it("falls back to tail when no interesting lines", () => {
    const out = extractErrorContext({ stderr: "plain noise" });
    assert.equal(out, "plain noise");
  });
});

describe("bash-fail-hook: extractErrorKeywords", () => {
  it("extracts alpha-token keywords, deduped, capped", () => {
    const out = extractErrorKeywords("Error: ENOENT module not found react react react");
    assert.match(out, /Error/);
    assert.match(out, /ENOENT/);
    assert.match(out, /module/);
    // dedup: 'react' should appear once
    assert.equal((out.match(/react/g) ?? []).length, 1);
  });
});

describe("bash-fail-hook: formatHintBlock", () => {
  it("emits bash-fail trigger and the failure-mode wording", () => {
    const out = formatHintBlock([
      {
        id: "some-lesson",
        title: "t",
        type: "lesson",
        scope: "all",
        summary: "s",
        score: 80,
      },
    ]);
    assert.match(out, /trigger="bash-fail"/);
    assert.match(out, /failure modes/);
    assert.match(out, /some-lesson/);
  });
});

describe("bash-fail-hook: throttle", () => {
  beforeEach(async () => {
    await clearThrottle();
  });

  it("is not throttled before any markThrottle call", async () => {
    assert.equal(await isThrottled(SESSION), false);
  });

  it("is throttled immediately after markThrottle", async () => {
    await markThrottle(SESSION);
    assert.equal(await isThrottled(SESSION), true);
  });
});

// ─── #144: act-signal integration (mock daemon + spawned hook) ────────────

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";


interface SeenRequest {
  path: string;
  body: Record<string, unknown>;
}

function startRecordingDaemon(
  recallHits: Record<string, unknown>[] = [],
): Promise<{ port: number; seen: SeenRequest[]; close: () => Promise<void> }> {
  const seen: SeenRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/hook/act") res.end(JSON.stringify({ matched: 0 }));
      else res.end(JSON.stringify({ hits: recallHits, vault_size: 0, latency_ms: 1, recall_id: "t" }));
    });
  });
  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      ok({ port, seen, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

/** #343: the pipeline under test is `runBashFailLane`, in-process. The
 *  recording mock stays identical — the lane still reaches /hook/act,
 *  /hook/recall and /hook/hinted over loopback HTTP. */
async function runFailHook(payload: object, port: number): Promise<string> {
  const prev = process.env.BASTRA_TELEMETRY;
  process.env.BASTRA_TELEMETRY = "off";
  try {
    return await runBashFailLane(
      payload as Parameters<typeof runBashFailLane>[0],
      `http://127.0.0.1:${port}`,
    );
  } finally {
    if (prev === undefined) delete process.env.BASTRA_TELEMETRY;
    else process.env.BASTRA_TELEMETRY = prev;
  }
}

describe("bash-fail-hook: #144 act-signal", () => {
  it("successful command sends /hook/act only and emits {}", async () => {
    const daemon = await startRecordingDaemon();
    try {
      const stdout = await runFailHook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          session_id: `act-ok-${Date.now()}`,
          tool_input: { command: "npm test" },
          tool_response: { exit_code: 0 },
        },
        daemon.port,
      );
      assert.equal(stdout.trim(), "{}");
      const paths = daemon.seen.map((r) => r.path);
      assert.deepEqual(paths, ["/hook/act"]);
      assert.equal(daemon.seen[0].body.tool_input_excerpt, "npm test");
      assert.equal(daemon.seen[0].body.exit_code, 0);
      assert.equal(daemon.seen[0].body.client, "claude-code");
      assert.equal(daemon.seen[0].body.hook_source, "bash-fail");
    } finally {
      await daemon.close();
    }
  });

  it("PostToolUseFailure sends the act-signal and recalls from its top-level error", async () => {
    const daemon = await startRecordingDaemon([{
      id: "failure-lesson",
      title: "Known build failure",
      type: "lesson",
      scope: "all",
      summary: "Use the generated type before building.",
      score: 80,
    }]);
    try {
      const stdout = await runFailHook(
        {
          hook_event_name: "PostToolUseFailure",
          tool_name: "Bash",
          session_id: `act-failure-event-${Date.now()}`,
          tool_input: { command: "npm run build" },
          error: "Command exited with non-zero status code 1: TS2304 missing name",
          is_interrupt: false,
          duration_ms: 4187,
        },
        daemon.port,
      );
      const output = JSON.parse(stdout) as { hookSpecificOutput?: { hookEventName?: string } };
      assert.equal(output.hookSpecificOutput?.hookEventName, "PostToolUseFailure");
      assert.deepEqual(daemon.seen.map((r) => r.path), ["/hook/act", "/hook/recall", "/hook/hinted"]);
      assert.equal(daemon.seen[0].body.exit_code, 1);
      assert.equal(daemon.seen[0].body.client, "claude-code");
      assert.equal(daemon.seen[0].body.hook_source, "bash-fail");
      assert.match(String(daemon.seen[1].body.query), /missing/);
    } finally {
      await daemon.close();
    }
  });

  it("PostToolUseFailure interrupt remains silent", async () => {
    const daemon = await startRecordingDaemon();
    try {
      const stdout = await runFailHook(
        {
          hook_event_name: "PostToolUseFailure",
          tool_name: "Bash",
          session_id: `act-failure-interrupt-${Date.now()}`,
          tool_input: { command: "npm run dev" },
          error: "Interrupted by user",
          is_interrupt: true,
        },
        daemon.port,
      );
      assert.equal(stdout.trim(), "{}");
      assert.equal(daemon.seen.length, 0);
    } finally {
      await daemon.close();
    }
  });

  it("explicit Codex marker reaches hook_act dimensions", async () => {
    const daemon = await startRecordingDaemon();
    try {
      await runFailHook(
        {
          bastra_client: "codex",
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          session_id: `act-codex-${Date.now()}`,
          tool_input: { command: "git status" },
          tool_response: { exit_code: 0 },
        },
        daemon.port,
      );
      assert.equal(daemon.seen[0].body.client, "codex");
      assert.equal(daemon.seen[0].body.hook_source, "bash-fail");
    } finally {
      await daemon.close();
    }
  });

  it("failed command sends /hook/act AND the fail-recall", async () => {
    const daemon = await startRecordingDaemon();
    try {
      await runFailHook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          session_id: `act-fail-${Date.now()}`,
          tool_input: { command: "npm run build" },
          tool_response: { exit_code: 1, stderr: "Error: tsc failed with TS2304" },
        },
        daemon.port,
      );
      const paths = daemon.seen.map((r) => r.path);
      assert.deepEqual(paths, ["/hook/act", "/hook/recall"]);
      assert.equal(daemon.seen[0].body.exit_code, 1);
    } finally {
      await daemon.close();
    }
  });

  it("no-exit-code payload (current Claude Code schema) still sends /hook/act with exit_code null", async () => {
    // Audit 2026-07-10: aktuelle Payloads tragen kein Exit-Code-Feld mehr —
    // ein frühes `exitCode === null → return` machte den act-Kanal tot
    // (15 von ~7200 erwarteten Signalen in 3 Tagen).
    const daemon = await startRecordingDaemon();
    try {
      const stdout = await runFailHook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          session_id: `act-noexit-${Date.now()}`,
          tool_input: { command: "npm test" },
          tool_response: { stdout: "ok", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
        },
        daemon.port,
      );
      assert.equal(stdout.trim(), "{}");
      const paths = daemon.seen.map((r) => r.path);
      assert.deepEqual(paths, ["/hook/act"]); // act ja, fail-recall nein
      assert.equal(daemon.seen[0].body.exit_code, null);
    } finally {
      await daemon.close();
    }
  });

  it("interrupted:true (current-schema Ctrl-C) sends nothing at all", async () => {
    const daemon = await startRecordingDaemon();
    try {
      const stdout = await runFailHook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          session_id: `act-intr-${Date.now()}`,
          tool_input: { command: "npm run dev" },
          tool_response: { stdout: "", stderr: "", interrupted: true },
        },
        daemon.port,
      );
      assert.equal(stdout.trim(), "{}");
      assert.equal(daemon.seen.length, 0);
    } finally {
      await daemon.close();
    }
  });

  it("Ctrl-C (130) sends nothing at all", async () => {
    const daemon = await startRecordingDaemon();
    try {
      const stdout = await runFailHook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          session_id: `act-int-${Date.now()}`,
          tool_input: { command: "npm run dev" },
          tool_response: { exit_code: 130 },
        },
        daemon.port,
      );
      assert.equal(stdout.trim(), "{}");
      assert.equal(daemon.seen.length, 0);
    } finally {
      await daemon.close();
    }
  });
});

describe("bash-fail-hook: invokesOwnBinary (self-exclusion guard)", () => {
  it("does NOT match commands that merely contain the repo name in a path", () => {
    assert.equal(invokesOwnBinary("git -C /Users/x/Projekte/bastra-recall status"), false);
    assert.equal(invokesOwnBinary("node /tmp/claude-501/-Users-x-Projekte-bastra-recall/scratch/migrate.mjs"), false);
    assert.equal(invokesOwnBinary("grep -rn foo packages/daemon/src --include='*.ts'"), false);
    assert.equal(invokesOwnBinary("tail -5 /Users/x/Projekte/bastra-recall/README.md"), false);
  });
  it("matches actual invocations of our binaries", () => {
    assert.equal(invokesOwnBinary("bastra-recall install"), true);
    assert.equal(invokesOwnBinary("npx bastra-recall install all"), true);
    assert.equal(invokesOwnBinary("npx -y bastra-recall doctor"), true);
    assert.equal(invokesOwnBinary("node_modules/.bin/bastra-recall-hook"), true);
    assert.equal(invokesOwnBinary("FOO=1 bastra-recall status"), true);
    assert.equal(invokesOwnBinary("echo hi && bastra-recall update"), true);
    assert.equal(invokesOwnBinary("echo $(bastra-recall status)"), true);
  });
  it("does not match unrelated programs with similar prefixes", () => {
    assert.equal(invokesOwnBinary("bastra-recallish --help"), false);
    assert.equal(invokesOwnBinary("mybastra-recall run"), false);
  });
});

/** #356: read every telemetry event a lane wrote into a throwaway log dir. */
async function readTelemetryEvents(dir: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const f of (await readdir(dir)).filter((n) => n.startsWith("events-") && n.endsWith(".jsonl"))) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) {
      if (line.trim()) out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
}

describe("bash-fail-hook: telemetry session (#356)", () => {
  it("bash_fail_hook_call carries the payload session_id, not a synthetic one", async () => {
    const daemon = await startRecordingDaemon();
    const logDir = await mkdtemp(join(tmpdir(), "bastra-bashfail-telemetry-"));
    const stateDir = await mkdtemp(join(tmpdir(), "bastra-bashfail-state-"));
    const applied: Record<string, string | undefined> = {};
    const env: Record<string, string> = {
      BASTRA_TELEMETRY: "on",
      BASTRA_LOG_PATH: logDir,
      BASTRA_HOOK_STATE_DIR: stateDir,
    };
    for (const [k, v] of Object.entries(env)) {
      applied[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      await runBashFailLane(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          session_id: `bashfail-sess-356-${Date.now()}`,
          tool_input: { command: "npm test" },
          tool_response: { exit_code: 1 },
        } as Parameters<typeof runBashFailLane>[0],
        `http://127.0.0.1:${daemon.port}`,
      );
      const ev = (await readTelemetryEvents(logDir)).find((e) => e.kind === "bash_fail_hook_call");
      assert.ok(ev, "a bash_fail_hook_call event must be written");
      assert.match(String(ev.session_id), /^bashfail-sess-356-/);
    } finally {
      for (const [k, v] of Object.entries(applied)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await daemon.close();
      await rm(logDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
