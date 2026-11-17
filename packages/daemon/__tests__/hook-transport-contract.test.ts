/**
 * #1508 — characterization of what each hook client puts on the wire and
 * writes back, pinned BEFORE the clients share one transport.
 *
 * Per client: the exact request (method, path, headers that matter, body
 * bytes), the stdout answer for a 2xx (verbatim) and a non-2xx (`{}`), and the
 * telemetry status for a refused connection. The header line is the one the
 * issue calls out: `hook.ts` and the compiled stub send no task authorization
 * header, the node prompt client and the thin-client lanes do.
 *
 * Runner: npm test (scripts/test-env.mjs keeps telemetry out of the real log).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = resolve(HERE, "..");
const TOKEN = "a".repeat(43);

interface Seen {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

async function daemon(status: number, answer: string): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(answer);
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const addr = server.address();
  return { server, port: typeof addr === "object" && addr ? addr.port : 0, seen };
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((ok) => server.close(() => ok()));
}

function run(args: string[], url: string, logDir: string, stdin: unknown): Promise<string> {
  return new Promise((ok, ko) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...args], {
      cwd: DAEMON,
      env: {
        ...process.env,
        BASTRA_LOG_PATH: logDir,
        BASTRA_DAEMON_URL: url,
        BASTRA_TELEMETRY: "on",
        BASTRA_TASKS: "1",
        BASTRA_TASK_TOKEN: TOKEN,
        BASTRA_TASKS_PATH: join(logDir, "proactive-tasks.json"),
        BASTRA_HOOK_CLIENT: "codex",
        BASTRA_CODEX_VERSION: "0.0.1",
        BASTRA_HOOK_STATE_DIR: join(logDir, "hook-state"),
        LC_ALL: "en_US.UTF-8",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", ko);
    child.on("close", () => ok(out));
    child.stdin.end(JSON.stringify(stdin));
  });
}

async function statuses(logDir: string): Promise<string[]> {
  const files = (await readdir(logDir)).filter((f) => f.startsWith("events-"));
  const lines = (
    await Promise.all(files.map(async (f) => (await readFile(join(logDir, f), "utf8")).split("\n")))
  ).flat();
  return lines
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { status?: unknown; error?: unknown })
    .map((r) => `${String(r.status)}:${String(r.error)}`);
}

const PROMPT = { session_id: "s", hook_event_name: "UserPromptSubmit", prompt: "hello" };
const WRITE = {
  session_id: "s",
  hook_event_name: "PreToolUse",
  tool_name: "Write",
  tool_input: { file_path: "/repo/src/a.ts", content: "x" },
};
const STOP = { session_id: "s", hook_event_name: "Stop" };
const SESSION = { session_id: "s", hook_event_name: "SessionStart" };
/** #1473: what a prompt or session lane answers when the daemon is down. */
const NOTICE = JSON.stringify({
  systemMessage:
    "bastra-recall: the Recall service is not reachable, so this session gets no memories. Check it with `bastra doctor`.",
});

const CODEX = { bastra_client: "codex", bastra_codex_version: null };

const CLIENTS: Array<{
  name: string;
  args: string[];
  stdin: unknown;
  path: string;
  body: unknown;
  auth: boolean;
  notice?: boolean;
}> = [
  {
    name: "stub prompt",
    args: ["stub/bastra-hook.ts", "prompt"],
    stdin: PROMPT,
    path: "/hook/prompt",
    body: { payload: { ...PROMPT, ...CODEX }, client_ppid: "PPID" },
    auth: false,
    notice: true,
  },
  {
    name: "stub write",
    args: ["stub/bastra-hook.ts", "write"],
    stdin: WRITE,
    path: "/hook/write",
    body: { payload: { ...WRITE, ...CODEX } },
    auth: false,
  },
  {
    name: "prompt-hook.ts",
    args: ["src/prompt-hook.ts"],
    stdin: PROMPT,
    path: "/hook/prompt",
    body: { payload: { ...PROMPT, ...CODEX }, client_ppid: "PPID" },
    auth: true,
    notice: true,
  },
  {
    name: "hook.ts",
    args: ["src/hook.ts"],
    stdin: WRITE,
    path: "/hook/write",
    body: { payload: { ...WRITE, ...CODEX } },
    auth: false,
  },
  {
    name: "stop-hook.ts",
    args: ["src/stop-hook.ts"],
    stdin: STOP,
    path: "/hook/stop",
    body: { payload: { ...STOP, ...CODEX } },
    auth: true,
  },
  {
    name: "stub session",
    args: ["stub/bastra-hook.ts", "session"],
    stdin: SESSION,
    path: "/hook/session",
    body: { payload: { ...SESSION, ...CODEX } },
    auth: false,
    notice: true,
  },
  {
    name: "session-hook.ts",
    args: ["src/session-hook.ts"],
    stdin: SESSION,
    path: "/hook/session",
    body: { payload: { ...SESSION, ...CODEX } },
    auth: true,
    notice: true,
  },
];

for (const c of CLIENTS) {
  test(`${c.name}: request on the wire and verbatim 2xx answer`, async (t) => {
    const logDir = await mkdtemp(join(tmpdir(), "bastra-hook-contract-"));
    const d = await daemon(200, '{"answer":1}');
    t.after(async () => {
      await close(d.server);
      await rm(logDir, { recursive: true, force: true });
    });
    const out = await run(c.args, `http://127.0.0.1:${d.port}`, logDir, c.stdin);
    assert.equal(out, '{"answer":1}');
    assert.equal(d.seen.length, 1);
    const [req] = d.seen;
    assert.equal(req.method, "POST");
    assert.equal(req.path, c.path);
    assert.equal(req.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(req.headers["content-length"], String(Buffer.byteLength(req.body)));
    assert.equal(req.headers["x-bastra-task-authorization"], c.auth ? `Bearer ${TOKEN}` : undefined);
    const body = JSON.parse(req.body) as { client_ppid?: unknown };
    if ("client_ppid" in body) {
      assert.equal(typeof body.client_ppid, "number");
      body.client_ppid = "PPID";
    }
    assert.equal(JSON.stringify(body), JSON.stringify(c.body));
  });

  test(`${c.name}: a non-2xx answer becomes {} and an error row`, async (t) => {
    const logDir = await mkdtemp(join(tmpdir(), "bastra-hook-contract-"));
    const d = await daemon(500, "boom");
    t.after(async () => {
      await close(d.server);
      await rm(logDir, { recursive: true, force: true });
    });
    const out = await run(c.args, `http://127.0.0.1:${d.port}`, logDir, c.stdin);
    assert.equal(out, "{}");
    if (c.name !== "stop-hook.ts") assert.deepEqual(await statuses(logDir), ["error:HTTP 500: boom"]);
  });

  test(`${c.name}: a refused connection becomes ${c.notice ? "the notice" : "{}"} and a daemon-unreachable row`, async (t) => {
    const logDir = await mkdtemp(join(tmpdir(), "bastra-hook-contract-"));
    const d = await daemon(200, "{}");
    const port = d.port;
    await close(d.server);
    t.after(() => rm(logDir, { recursive: true, force: true }));
    const out = await run(c.args, `http://127.0.0.1:${port}`, logDir, c.stdin);
    assert.equal(out, c.notice ? NOTICE : "{}");
    if (c.name !== "stop-hook.ts") assert.deepEqual(await statuses(logDir), ["daemon-unreachable:null"]);
  });
}
