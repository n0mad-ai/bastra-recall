/**
 * The hook transport, in every thin client (thin-client.ts, the compiled stub,
 * hook.ts, prompt-hook.ts):
 *
 *   · timeoutMs is a deadline, not the socket-idle timer — a response that
 *     drips a byte every 100ms never goes idle;
 *   · an https:// daemon URL speaks TLS instead of plain HTTP;
 *   · an IPv6 literal (`http://[::1]:port`) connects instead of handing
 *     "[::1]" to the resolver.
 *
 * Runner: npm test (never `npx tsx --test` directly — that bypasses
 * scripts/test-env.mjs and writes into the real telemetry log).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { postLane } from "../src/thin-client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = resolve(HERE, "..");

/** A daemon stand-in that counts the requests it could parse as HTTP. */
async function daemon(host: string, drip = false): Promise<{ server: Server; port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (!drip) {
        res.end("{}");
        return;
      }
      let n = 0;
      const iv = setInterval(() => {
        res.write(" ");
        if (++n >= 20) {
          clearInterval(iv);
          res.end("{}");
        }
      }, 100);
      res.on("close", () => clearInterval(iv));
    });
  });
  await new Promise<void>((ok, ko) => {
    server.once("error", ko);
    server.listen(0, host, () => ok());
  });
  const addr = server.address();
  return { server, port: typeof addr === "object" && addr ? addr.port : 0, hits };
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((ok) => server.close(() => ok()));
}

test("thin client: timeoutMs is a deadline — a dripping response is cut off", async (t) => {
  const d = await daemon("127.0.0.1", true);
  t.after(() => close(d.server));
  const started = Date.now();
  await assert.rejects(postLane(`http://127.0.0.1:${d.port}`, "/hook/stop", { payload: {} }, 400), /timeout/);
  const took = Date.now() - started;
  assert.ok(took < 1500, `rejected after ${took}ms, the drip runs 2000ms`);
});

test("thin client: an https:// URL speaks TLS, a plain-HTTP server never sees a request", async (t) => {
  const d = await daemon("127.0.0.1");
  t.after(() => close(d.server));
  await assert.rejects(postLane(`https://127.0.0.1:${d.port}`, "/hook/stop", { payload: {} }, 2000));
  assert.deepEqual(d.hits, []);
});

/** A host or container without IPv6 loopback cannot run the IPv6 cases. */
async function v6Daemon(t: { skip: (msg: string) => void }): Promise<Awaited<ReturnType<typeof daemon>> | null> {
  try {
    return await daemon("::1");
  } catch {
    t.skip("no IPv6 loopback on this host");
    return null;
  }
}

test("thin client: an IPv6 literal connects", async (t) => {
  const d = await v6Daemon(t);
  if (!d) return;
  t.after(() => close(d.server));
  assert.equal(await postLane(`http://[::1]:${d.port}`, "/hook/stop", { payload: {} }, 2000), "{}");
  assert.deepEqual(d.hits, ["/hook/stop"]);
});

/** Run one hook entry point against `url`; resolves with its exit code. */
function runHook(
  args: string[],
  url: string,
  logDir: string,
  stdin: unknown | null,
  env: Record<string, string> = {},
): Promise<number | null> {
  return new Promise((ok, ko) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...args], {
      cwd: DAEMON,
      env: { ...process.env, BASTRA_LOG_PATH: logDir, BASTRA_DAEMON_URL: url, BASTRA_TELEMETRY: "on", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.on("error", ko);
    child.on("close", (code) => ok(code));
    // null keeps stdin open: the hook waits on it until its kill switch fires.
    if (stdin !== null) child.stdin.end(JSON.stringify(stdin));
  });
}

const CLIENTS: Array<{ name: string; args: string[]; payload: unknown; path: string }> = [
  {
    name: "stub",
    args: ["stub/bastra-hook.ts", "prompt"],
    payload: { session_id: "s", hook_event_name: "UserPromptSubmit", prompt: "hello" },
    path: "/hook/prompt",
  },
  {
    name: "prompt-hook.ts",
    args: ["src/prompt-hook.ts"],
    payload: { session_id: "s", hook_event_name: "UserPromptSubmit", prompt: "hello" },
    path: "/hook/prompt",
  },
  {
    name: "hook.ts",
    args: ["src/hook.ts"],
    payload: { session_id: "s", hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/repo/src/a.ts", content: "x" } },
    path: "/hook/write",
  },
];

for (const c of CLIENTS) {
  test(`${c.name}: reaches a daemon on an IPv6 literal, and an https:// URL never goes out as plain HTTP`, async (t) => {
    const v6 = await v6Daemon(t);
    if (!v6) return;
    const logDir = await mkdtemp(join(tmpdir(), "bastra-hook-transport-"));
    const v4 = await daemon("127.0.0.1");
    t.after(async () => {
      await close(v6.server);
      await close(v4.server);
      await rm(logDir, { recursive: true, force: true });
    });
    await runHook(c.args, `http://[::1]:${v6.port}`, logDir, c.payload);
    assert.deepEqual(v6.hits, [c.path], `${c.name} did not reach http://[::1]`);
    await runHook(c.args, `https://127.0.0.1:${v4.port}`, logDir, c.payload);
    assert.deepEqual(v4.hits, [], `${c.name} sent an https:// call as plain HTTP`);
  });
}

for (const c of CLIENTS) {
  test(`${c.name}: timeoutMs is a deadline — a dripping response ends in a timeout row`, async (t) => {
    const logDir = await mkdtemp(join(tmpdir(), "bastra-hook-transport-"));
    const d = await daemon("127.0.0.1", true);
    t.after(async () => {
      await close(d.server);
      await rm(logDir, { recursive: true, force: true });
    });
    // The drip runs 2000ms. Without a deadline the call outlives its budget
    // and only the kill switch ends it, which writes no row.
    await runHook(c.args, `http://127.0.0.1:${d.port}`, logDir, c.payload, { BASTRA_HOOK_TIMEOUT_MS: "800" });
    assert.deepEqual(d.hits, [c.path]);
    const files = (await readdir(logDir)).filter((f) => f.startsWith("events-"));
    const rows = (
      await Promise.all(files.map(async (f) => (await readFile(join(logDir, f), "utf8")).split("\n")))
    )
      .flat()
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { status?: string });
    assert.ok(
      rows.some((r) => r.status === "timeout"),
      `${c.name}: no timeout row, got ${JSON.stringify(rows.map((r) => r.status))}`,
    );
  });
}
