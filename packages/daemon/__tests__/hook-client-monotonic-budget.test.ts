/**
 * #1674 — a hook client hands the daemon what remains of its budget, measured
 * on a monotonic clock. Measured with `Date.now()`, a system clock set back
 * during the call made the elapsed time negative and the remainder larger
 * than the budget itself; the HTTP deadline then outlived the kill switch.
 *
 * Each client runs for real against a daemon that answers at once, with a
 * preload that sets the system clock back by a second on every read and logs
 * the deadline timer armed for the request. No wall clock: the assertion is on
 * that timer's value, never on how long the call took. Before the fix every
 * client armed it beyond its budget, past the kill switch (budget + 50 ms).
 *
 * Runner: npm test (scripts/test-env.mjs isolates HOME and the logs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const BUDGET_MS = 400;

const PRELOAD = `
import { writeFileSync } from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
let system = 1_800_000_000_000;
Date.now = () => (system -= 1000);
let lastDelay = null;
const deadlines = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  lastDelay = Number(ms ?? 0);
  return realSetTimeout(fn, ms, ...args);
};
// hook-transport.ts arms the request's deadline right before it opens it.
const realRequest = http.request;
http.request = (...args) => {
  deadlines.push(lastDelay);
  return realRequest(...args);
};
syncBuiltinESMExports();
process.on("exit", () => writeFileSync(process.env.BASTRA_1674_TIMERS, JSON.stringify(deadlines)));
`;

const PAYLOAD: Record<string, Record<string, unknown>> = {
  gate: { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/tmp/bastra-1674/app.ts" } },
  write: {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/bastra-1674/app.ts", content: "export const a = 1;\n" },
  },
  prompt: { hook_event_name: "UserPromptSubmit", prompt: "und was war da nochmal" },
  "bash-pre": { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
  "bash-fail": {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls /nope" },
    tool_response: { exit_code: 2 },
  },
  stop: { hook_event_name: "Stop", transcript_path: "/tmp/bastra-1674/missing.jsonl" },
  session: { hook_event_name: "SessionStart", source: "startup" },
  todo: {
    hook_event_name: "PostToolUse",
    tool_name: "TodoWrite",
    tool_input: { todos: [{ content: "measure the lane", status: "pending" }] },
  },
};

const NODE_CLIENT: Record<string, string> = {
  gate: "gate-hook.ts",
  write: "hook.ts",
  prompt: "prompt-hook.ts",
  "bash-pre": "bash-pre-hook.ts",
  "bash-fail": "bash-fail-hook.ts",
  stop: "stop-hook.ts",
  session: "session-hook.ts",
  todo: "todo-hook.ts",
};

/** The session lane's budget carries its own 100 ms on top (session-hook.ts). */
const budgetOf = (lane: string) => BUDGET_MS + (lane === "session" ? 100 : 0);

async function timersOf(script: string[], lane: string): Promise<{ deadlines: number[]; posted: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-1674-"));
  const posted: string[] = [];
  const server = createServer((req, res) => {
    posted.push(req.url ?? "");
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  try {
    const preload = join(dir, "clock-back.mjs");
    const timers = join(dir, "timers.json");
    await writeFile(preload, PRELOAD);
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((ok, ko) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--import", pathToFileURL(preload).href, ...script], {
        cwd: PKG,
        env: {
          ...process.env,
          BASTRA_DAEMON_URL: `http://127.0.0.1:${port}`,
          BASTRA_HOOK_TIMEOUT_MS: String(BUDGET_MS),
          BASTRA_STOP_HOOK_TIMEOUT_MS: String(BUDGET_MS),
          BASTRA_LOG_PATH: dir,
          BASTRA_1674_TIMERS: timers,
        },
        stdio: ["pipe", "ignore", "inherit"],
      });
      child.on("error", ko);
      child.on("close", () => ok());
      child.stdin.end(JSON.stringify({ session_id: `s1674-${lane}`, ...PAYLOAD[lane] }));
    });
    return { deadlines: JSON.parse(await readFile(timers, "utf8")) as number[], posted };
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
    await rm(dir, { recursive: true, force: true });
  }
}

const SHAPES = Object.keys(PAYLOAD).flatMap((lane) => [
  { name: `node/${lane}`, lane, script: [join(PKG, "src", NODE_CLIENT[lane]!)] },
  { name: `stub/${lane}`, lane, script: [join(PKG, "stub", "bastra-hook.ts"), lane] },
]);

for (const { name, lane, script } of SHAPES) {
  test(`#1674 ${name}: a system clock set back during the call does not extend the budget`, async () => {
    const { deadlines, posted } = await timersOf(script, lane);
    assert.deepEqual(posted, [`/hook/${lane}`], "the call reached the daemon");
    assert.equal(deadlines.length, 1, `${name}: one request, deadlines ${JSON.stringify(deadlines)}`);
    const budget = budgetOf(lane);
    assert.ok(
      deadlines[0]! > 0 && deadlines[0]! <= budget,
      `${name}: deadline ${deadlines[0]} ms, budget ${budget} ms`
    );
  });
}
