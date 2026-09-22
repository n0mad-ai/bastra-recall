/**
 * Tests for the THIN prompt-hook client (#343).
 *
 * The pipeline moved daemon-side (prompt-lane.ts, covered in
 * prompt-lane.test.ts). What is left in prompt-hook.ts is the contract that
 * must hold in the hook process itself, and that is what gets pinned here:
 *
 *   1. the response body reaches stdout VERBATIM — the client must not parse,
 *      re-serialize or "fix" what the daemon returns, because Claude Code
 *      parses stdout as exactly one JSON document
 *   2. the request carries `client_ppid` — the one fact only the hook process
 *      owns (its position in the Claude session's process tree, #74/#51);
 *      lose it and every session's statusline feed collapses onto one file
 *   3. daemon down → `{}` and exit 0 — the fail-open contract, unchanged
 *      from the fat client (a hook must never break the turn)
 *
 * Spawned via tsx like the old CLI tests, because process behaviour (stdout,
 * exit code) IS the unit under test.
 */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = resolve(__dirname, "..", "src", "prompt-hook.ts");

function startMockDaemon(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  return new Promise<{ port: number; close: () => Promise<void> }>((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      ok({
        port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function runHook(
  payload: object,
  env: Record<string, string>,
): Promise<{ stdout: string; code: number }> {
  return new Promise((ok, ko) => {
    const child = spawn("npx", ["tsx", HOOK_PATH], {
      env: { ...process.env, ...env, BASTRA_TELEMETRY: "off" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.on("error", ko);
    child.on("close", (code) => ok({ stdout, code: code ?? -1 }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

test("thin client: response body reaches stdout verbatim, request carries payload + client_ppid", async () => {
  // Deliberately non-canonical JSON (spacing) — byte-identical passthrough is
  // the assertion, so any parse/re-stringify in the client would fail it.
  const daemonDoc = '{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "<recall-hints>x</recall-hints>"} }';
  // #542: named rather than inline so the cast below doesn't go through
  // `typeof received` — received is only ever assigned inside the mock
  // daemon's request handler (a separate control-flow container), so TS's
  // flow analysis can't see that assignment and narrows `typeof received`
  // to `null` at the cast site, making `NonNullable<typeof received>` `never`.
  interface Received {
    url: string | undefined;
    body: { payload?: { prompt?: string }; client_ppid?: unknown };
  }
  let received: Received | null = null;

  const daemon = await startMockDaemon((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      received = { url: req.url, body: JSON.parse(body) };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(daemonDoc);
    });
  });

  try {
    const { stdout, code } = await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: "such mal meinen Strafzettel" },
      { BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}` },
    );
    assert.equal(code, 0);
    assert.equal(stdout, daemonDoc, "body must reach stdout verbatim — no parse, no reserialize");

    assert.ok(received, "daemon must have been called");
    const r = received as Received;
    assert.equal(r.url, "/hook/prompt");
    assert.equal(r.body.payload?.prompt, "such mal meinen Strafzettel", "original payload rides inside `payload`");
    assert.ok(
      Number.isInteger(r.body.client_ppid) && (r.body.client_ppid as number) > 1,
      `client_ppid must be the hook's real ppid, got ${String(r.body.client_ppid)}`,
    );
  } finally {
    await daemon.close();
  }
});

test("thin client: daemon down → {} and exit 0 (fail-open)", async () => {
  // Port 1 refuses connections without a server — the ECONNREFUSED path.
  const { stdout, code } = await runHook(
    { hook_event_name: "UserPromptSubmit", prompt: "such mal meinen Strafzettel" },
    { BASTRA_HTTP_URL: "http://127.0.0.1:1" },
  );
  assert.equal(code, 0, "a hook must never fail the turn");
  assert.equal(stdout.trim(), "{}");
});

test("thin client: HTTP error from the daemon degrades to {} (never forwards an error body)", async () => {
  const daemon = await startMockDaemon((_req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end('{"error":"boom"}');
  });
  try {
    const { stdout, code } = await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: "such mal meinen Strafzettel" },
      { BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}` },
    );
    assert.equal(code, 0);
    assert.equal(stdout.trim(), "{}", "an error body must never reach Claude Code's stdout parser");
  } finally {
    await daemon.close();
  }
});

test("thin client: invalid stdin JSON → {} without contacting the daemon", async () => {
  let called = false;
  const daemon = await startMockDaemon((_req, res) => {
    called = true;
    res.writeHead(200);
    res.end("{}");
  });
  try {
    const result = await new Promise<{ stdout: string; code: number }>((ok, ko) => {
      const child = spawn("npx", ["tsx", HOOK_PATH], {
        env: {
          ...process.env,
          BASTRA_HTTP_URL: `http://127.0.0.1:${daemon.port}`,
          BASTRA_TELEMETRY: "off",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += c.toString()));
      child.on("error", ko);
      child.on("close", (code) => ok({ stdout, code: code ?? -1 }));
      child.stdin.write("not json {");
      child.stdin.end();
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "{}");
    assert.equal(called, false, "garbage stdin must not produce a request");
  } finally {
    await daemon.close();
  }
});
