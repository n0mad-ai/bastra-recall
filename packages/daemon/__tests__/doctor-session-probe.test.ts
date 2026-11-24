/** Isolated end-to-end probe from startup hook to the client model request. */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { probeSessionStart, sessionStartRegistration } from "../src/cli/doctor-session-probe.js";
import { HOOK_STUB_BIN, SESSION_HOOK_BIN } from "../src/cli/paths.js";
import { dispatchLaneRoutes } from "../src/http-lane-routes.js";
import { DOCTOR_SESSION_PATH } from "../src/session-output.js";

test("only the installed Recall runner in SessionStart can be probed", () => {
  const forCommand = (command: string) => ({ hooks: [{ type: "command", command }], matcher: "startup|resume" });
  const valid = forCommand(`BASTRA_HOOK_CLIENT=codex BASTRA_CODEX_VERSION=0.166.0 node '${SESSION_HOOK_BIN}'`);
  const wrapped = forCommand(`BASTRA_HOOK_CLIENT=codex log-first && node '${SESSION_HOOK_BIN}'`);
  assert.deepEqual(sessionStartRegistration({ SessionStart: [wrapped, valid] }, "codex"), {
    runner: [process.execPath, SESSION_HOOK_BIN],
    matcher: "startup|resume",
  });
  assert.equal(sessionStartRegistration({ SessionEnd: [valid], SessionStart: [wrapped] }, "codex"), undefined);
  const stub = forCommand(`BASTRA_HOOK_CLIENT=claude-code '${HOOK_STUB_BIN}' session`);
  assert.deepEqual(sessionStartRegistration({ SessionStart: [stub] }, "claude-code")?.runner, [
    HOOK_STUB_BIN,
    "session",
  ]);
});

test("doctor's challenge bypasses the real session lane and its notices", async (t) => {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(req.url ?? "");
    if (
      dispatchLaneRoutes(req, res, req.method ?? "GET", req.url ?? "", undefined, async () => {
        assert.fail("doctor must not attach normal session notices");
      })
    )
      return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const challenge = "e".repeat(32);
  const response = await fetch(`${endpoint}${DOCTOR_SESSION_PATH}`, {
    method: "POST",
    body: JSON.stringify({ challenge }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `bastra-recall-doctor:${challenge}` },
  });
  assert.equal((await fetch(`${endpoint}${DOCTOR_SESSION_PATH}`, { method: "POST", body: "{}" })).status, 400);
  assert.deepEqual(calls, [DOCTOR_SESSION_PATH, DOCTOR_SESSION_PATH]);
});

test("only the marker that reaches model input proves delivery", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "recall-doctor-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const client = join(dir, "codex");
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    if (!dispatchLaneRoutes(req, res, req.method ?? "GET", req.url ?? "")) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const oldPath = process.env.PATH;
  const oldDaemon = process.env.BASTRA_DAEMON_URL;
  process.env.PATH = dir + delimiter + oldPath;
  process.env.BASTRA_DAEMON_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldDaemon === undefined) delete process.env.BASTRA_DAEMON_URL;
    else process.env.BASTRA_DAEMON_URL = oldDaemon;
  });
  const hook = {
    runner: [process.execPath, fileURLToPath(new URL("../src/session-hook.ts", import.meta.url))],
    matcher: "startup",
  };
  const program = (input: string) => `#!${process.execPath}\n(async () => {
    const base = process.env.BASTRA_DAEMON_URL;
    const request = await fetch(base + "/hook/session", {
      method: "POST", body: JSON.stringify({ payload: { hook_event_name: "SessionStart", source: "startup" } }),
    });
    const context = (await request.json()).hookSpecificOutput.additionalContext;
    await fetch(base + "/responses", { method: "POST", body: JSON.stringify(${input}) });
  })().catch(() => process.exit(1));\n`;
  await writeFile(
    client,
    program('{ input: [{ content: [{ text: "no start context" }] }], unrelated_metadata: context }')
  );
  await chmod(client, 0o700);
  assert.equal(await probeSessionStart("codex", hook), "missing");
  await writeFile(client, program("{ input: [{ content: [{ text: context }] }] }"));
  assert.equal(await probeSessionStart("codex", hook), "delivered");
  assert.deepEqual(requests, [DOCTOR_SESSION_PATH, DOCTOR_SESSION_PATH]);
});
