/**
 * #1473 — an unreachable daemon is said to the user once per session, not
 * answered silently empty.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unreachableAnswer, unreachableNoticeText } from "../src/hook-unreachable-notice.js";
import { cleanupOldStates } from "../src/session-state.js";

const DAEMON = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function withStateDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-unreachable-"));
  const prev = process.env.BASTRA_HOOK_STATE_DIR;
  process.env.BASTRA_HOOK_STATE_DIR = join(dir, "state");
  t.after(async () => {
    if (prev === undefined) delete process.env.BASTRA_HOOK_STATE_DIR;
    else process.env.BASTRA_HOOK_STATE_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const notice = (text = unreachableNoticeText()) => JSON.stringify({ systemMessage: text });

test("the first failure of a session announces, every later one in it stays silent", async (t) => {
  await withStateDir(t);
  assert.equal(await unreachableAnswer("prompt", "s1"), notice());
  assert.equal(await unreachableAnswer("prompt", "s1"), "{}");
  assert.equal(await unreachableAnswer("session", "s1"), "{}");
  assert.equal(await unreachableAnswer("session", "s2"), notice());
});

test("tool-call lanes and calls without a session id stay {} and use up nothing", async (t) => {
  await withStateDir(t);
  for (const lane of ["write", "gate", "bash-pre", "bash-fail", "stop", "todo"])
    assert.equal(await unreachableAnswer(lane, "s3"), "{}", lane);
  assert.equal(await unreachableAnswer("prompt", null), "{}");
  assert.equal(await unreachableAnswer("prompt", ""), "{}");
  assert.equal(await unreachableAnswer("prompt", "s3"), notice());
});

test(
  "a state directory others may write is not used — silent instead of repeating",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = await withStateDir(t);
    const state = join(dir, "state");
    assert.equal(await unreachableAnswer("prompt", "first"), notice());
    await chmod(state, 0o777);
    assert.equal(await unreachableAnswer("prompt", "second"), "{}");
  }
);

test("#1640: the session sweep drops markers past the retention horizon and keeps fresh ones", async (t) => {
  const dir = await withStateDir(t);
  const markers = join(dir, "state", "unreachable-notice");
  for (const session of ["old-1", "old-2", "fresh"]) assert.equal(await unreachableAnswer("prompt", session), notice());
  const before = await readdir(markers);
  assert.equal(before.length, 3);
  // A marker is named by the hashed session id; age every marker but "fresh".
  const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const freshKey = createHash("sha256").update("fresh").digest("hex").slice(0, 24);
  for (const name of before) if (name !== freshKey) await utimes(join(markers, name), yearAgo, yearAgo);
  // Things the sweep did not create stay untouched, however old.
  const outside = join(dir, "outside");
  await writeFile(outside, "keep");
  await utimes(outside, yearAgo, yearAgo);
  await symlink(outside, join(markers, "a".repeat(24)));
  await writeFile(join(markers, "foreign.txt"), "keep");
  await utimes(join(markers, "foreign.txt"), yearAgo, yearAgo);

  await cleanupOldStates();

  assert.deepEqual((await readdir(markers)).sort(), ["a".repeat(24), freshKey, "foreign.txt"].sort());
  // At most once still holds for the session whose marker survived …
  assert.equal(await unreachableAnswer("prompt", "fresh"), "{}");
  // … and an expired session may announce again, exclusively once.
  assert.equal(await unreachableAnswer("prompt", "old-1"), notice());
  assert.equal(await unreachableAnswer("prompt", "old-1"), "{}");
});

test("the line follows the language, English for anything without its own text", () => {
  assert.match(unreachableNoticeText("de"), /nicht erreichbar.*`bastra doctor`/);
  assert.match(unreachableNoticeText("en"), /not reachable.*`bastra doctor`/);
  assert.equal(unreachableNoticeText("fr"), unreachableNoticeText("en"));
});

function runStub(lane: string, url: string, stateDir: string, stdin: unknown): Promise<string> {
  return new Promise((ok, ko) => {
    const child = spawn(process.execPath, ["--import", "tsx", "stub/bastra-hook.ts", lane], {
      cwd: DAEMON,
      env: { ...process.env, BASTRA_DAEMON_URL: url, BASTRA_HOOK_STATE_DIR: stateDir, LC_ALL: "de_DE.UTF-8" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", ko);
    child.on("close", () => ok(out));
    child.stdin.end(JSON.stringify(stdin));
  });
}

test("the stub: one notice per session across its lanes, in the process language", async (t) => {
  const dir = await withStateDir(t);
  const server = createServer();
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  await new Promise<void>((ok) => server.close(() => ok()));
  const url = `http://127.0.0.1:${port}`;
  const state = join(dir, "stub-state");
  const prompt = { session_id: "abc", hook_event_name: "UserPromptSubmit", prompt: "hi" };
  assert.equal(await runStub("prompt", url, state, prompt), notice(unreachableNoticeText("de")));
  assert.equal(await runStub("prompt", url, state, prompt), "{}");
  assert.equal(await runStub("session", url, state, { session_id: "abc", hook_event_name: "SessionStart" }), "{}");
});
