/**
 * A settings reader that is still starting (thread, modules) has not begun
 * any read, so it is not stuck. On a slow machine its start-up can outlast
 * the size note's deadline: that request gets no answer in time, but the
 * reader must stay and answer the next one, instead of being terminated and
 * blocking every later request until it exits (CI, golden master #1525).
 *
 * Nor may a start-up that never finishes pile up work or keep the process
 * alive: requests whose deadline passes before the reader is ready are never
 * sent to it, and a reader without a pending request is never referenced.
 *
 * The slow start is simulated by holding back the worker's "ready" message;
 * a start that never finishes, by never delivering it.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { SettingsReadLate, readSettingsRecordOffThread, warmSettingsReader } from "../src/settings-record-thread.js";

const PATH = "/nonexistent/cli-settings.json";

/** Holds back every "ready" message of a settings worker until `release()`. */
function holdReady(t: TestContext): () => void {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const realEmit = Worker.prototype.emit;
  t.mock.method(Worker.prototype, "emit", function (this: Worker, event: string | symbol, ...args: unknown[]) {
    if (event === "message" && args[0] === "ready") {
      void held.then(() => Reflect.apply(realEmit, this, [event, ...args]));
      return true;
    }
    return Reflect.apply(realEmit, this, [event, ...args]) as boolean;
  });
  return release;
}

/** The reader does not hold the process open while it starts; a test that
 * waits for it does. */
async function warm(): Promise<void> {
  const open = setInterval(() => {}, 1000);
  await warmSettingsReader();
  clearInterval(open);
}

test("a deadline missed while the reader starts fails only that request; the reader stays", async (t) => {
  const release = holdReady(t);
  const terminate = t.mock.method(Worker.prototype, "terminate");
  const sent = t.mock.method(Worker.prototype, "postMessage");

  await assert.rejects(readSettingsRecordOffThread(PATH, Date.now() + 1), SettingsReadLate);
  assert.equal(terminate.mock.callCount(), 0, "a reader that has not started is not treated as stuck");

  // Expired requests leave no work behind: before the reader is ready nothing
  // is sent, and afterwards only requests still within their deadline are.
  for (let i = 0; i < 64; i++) {
    await assert.rejects(readSettingsRecordOffThread(PATH, Date.now() + 2), SettingsReadLate);
  }
  const live = readSettingsRecordOffThread(PATH, Date.now() + 5000);
  assert.equal(sent.mock.callCount(), 0, "nothing is sent to a reader that is not ready");
  release();
  assert.equal(await live, undefined, "a request still within its deadline is answered once the reader is ready");
  assert.equal(sent.mock.callCount(), 1, "the 65 expired requests never reached the reader");

  await warm();
  assert.equal(
    await readSettingsRecordOffThread(PATH, Date.now() + 5000),
    undefined,
    "the same reader answers the next deadline-bound request"
  );
  assert.equal(terminate.mock.callCount(), 0);
});

test("a warmed reader that never becomes ready does not keep the process alive", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-settings-warm-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, "child.mts");
  const reader = new URL("../src/settings-record-thread.ts", import.meta.url).href;
  // The child drops the "ready" message, as if the worker hung in its start-up.
  await writeFile(
    script,
    `import { Worker } from "node:worker_threads";
import { warmSettingsReader } from ${JSON.stringify(reader)};
const emit = Worker.prototype.emit;
Worker.prototype.emit = function (event, ...args) {
  return event === "message" && args[0] === "ready" ? true : Reflect.apply(emit, this, [event, ...args]);
};
void warmSettingsReader();
console.log("warmed");
`
  );
  const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 15_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited) child.kill("SIGKILL");
  assert.equal(out.trim(), "warmed");
  assert.ok(exited, "the process ends on its own while the warmed reader is still starting");
});
