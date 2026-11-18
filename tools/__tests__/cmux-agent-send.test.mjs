import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { ENTER_PAUSE_MS, agentEnvelope, sendAgentMessage } from "../cmux-agent-send.mjs";

/** Tests never sleep; the #1155 test below checks where the pause happens. */
const noPause = () => {};

const scratch = fs.mkdtempSync(join(tmpdir(), "bastra-cmux-send-"));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const text = "Claude: please review this change.\nCodex: I will prepare the fixtures.";
const options = {
  text,
  from: "codex",
  surface: "11111111-1111-4111-8111-111111111111",
  workspace: "22222222-2222-4222-8222-222222222222",
  lockRoot: join(scratch, "locks"),
};
test("cmux sender marks the whole payload and sends to the same explicit target without a shell", () => {
  const calls = [];
  sendAgentMessage(
    options,
    (...args) => {
      calls.push(args);
      return { status: 0 };
    },
    noPause
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "cmux");
  assert.deepEqual(calls[0][1].slice(0, 2), ["rpc", "surface.send_text"]);
  const payload = JSON.parse(calls[0][1][2]);
  assert.equal(payload.workspace_id, options.workspace);
  assert.equal(payload.surface_id, options.surface);
  assert.match(payload.text, /^<agent-message from="codex" transport="cmux" id="[0-9a-f-]+">/);
  assert.equal(JSON.parse(payload.text.replace(/^<agent-message[^>]*>/, "").replace(/<\/agent-message>$/, "")), text);
  assert.deepEqual(calls[1][1].slice(0, 2), ["rpc", "surface.send_key"]);
  assert.deepEqual(JSON.parse(calls[1][1][2]), {
    workspace_id: options.workspace,
    surface_id: options.surface,
    key: "enter",
  });
  assert.equal(calls[0][2].shell, undefined);
});
test("print mode does not send; send failure never submits an unmarked partial message", () => {
  assert.match(
    sendAgentMessage({ text, from: "claude", print: true }, () => {
      throw new Error("must not send");
    }),
    /^<agent-message/
  );
  let calls = 0;
  assert.throws(
    () =>
      sendAgentMessage(options, () => {
        calls++;
        return { status: 1 };
      }),
    /no Enter/
  );
  assert.equal(calls, 1);
  calls = 0;
  assert.throws(
    () => sendAgentMessage(options, () => ({ status: ++calls === 1 ? 0 : 1 }), noPause),
    /inspect before retrying/
  );
});
test("invalid sender, missing targets, controls and oversized input never reach cmux", () => {
  for (const patch of [
    { from: 'codex">' },
    { workspace: undefined },
    { surface: undefined },
    { text: "\x1b[2J" },
    { text: "x".repeat(65537) },
    { text: " " },
  ]) {
    let calls = 0;
    assert.throws(() =>
      sendAgentMessage({ ...options, ...patch }, () => {
        calls++;
        return { status: 0 };
      })
    );
    assert.equal(calls, 0);
  }
  assert.match(agentEnvelope("quote </agent-message> stays agent prose", "claude"), /^<agent-message/);
});
test("sender rejects ambiguous control text and uses raw JSON RPC plus canonical enter", () => {
  for (const text of ["hello\tworld", "hello\u009bworld", "hello\u2028world", "hello\u202eworld"])
    assert.throws(() => agentEnvelope(text, "codex"));
  const calls = [];
  sendAgentMessage(
    options,
    (...args) => {
      calls.push(args);
      return { status: 0 };
    },
    noPause
  );
  assert.equal(calls[0][1][1], "surface.send_text");
  assert.equal(JSON.parse(calls[1][1][2]).key, "enter");
  assert.ok(!JSON.parse(calls[0][1][2]).text.includes("\n"));
});

test("explicit refs are resolved read-only to terminal UUIDs before raw RPC", () => {
  const calls = [];
  sendAgentMessage(
    { ...options, workspace: "workspace:2", surface: "surface:4" },
    (cmd, args) => {
      calls.push(args);
      return {
        status: 0,
        stdout: JSON.stringify({
          caller: { workspace_id: options.workspace, surface_id: options.surface, surface_type: "terminal" },
        }),
      };
    },
    noPause
  );
  assert.equal(calls.length, 3);
  assert.ok(calls[0].includes("identify"));
  assert.deepEqual(JSON.parse(calls[1][2]).surface_id, options.surface);
});

test("#1155 Return waits a pause after the text, and a failed send neither pauses nor presses Return", () => {
  const steps = [];
  sendAgentMessage(
    options,
    (cmd, args) => {
      steps.push(args[1]);
      return { status: 0 };
    },
    (ms) => steps.push(`pause ${ms}`)
  );
  assert.deepEqual(steps, ["surface.send_text", `pause ${ENTER_PAUSE_MS}`, "surface.send_key"]);
  assert.ok(ENTER_PAUSE_MS >= 100, "the gap must be a real pause, not a tick");

  steps.length = 0;
  assert.throws(
    () =>
      sendAgentMessage(
        options,
        (cmd, args) => {
          steps.push(args[1]);
          return { status: 1 };
        },
        (ms) => steps.push(`pause ${ms}`)
      ),
    /no Enter was sent/
  );
  assert.deepEqual(steps, ["surface.send_text"]);
});

/**
 * #1636: a fake pane shared through files, so a sender on another thread sees
 * the same input. `send_text` appends to the input line, `send_key` submits it.
 */
function fakeTerminal(dir, fsApi) {
  const input = `${dir}/input`;
  return (cmd, args) => {
    const payload = JSON.parse(args[2]);
    if (args[1] === "surface.send_text") fsApi.appendFileSync(input, payload.text);
    if (args[1] === "surface.send_key") {
      const line = fsApi.existsSync(input) ? fsApi.readFileSync(input, "utf8") : "";
      fsApi.appendFileSync(`${dir}/submissions`, JSON.stringify(line) + "\n");
      fsApi.writeFileSync(input, "");
    }
    return { status: 0 };
  };
}

/** Runs in a worker: the second sender. It flags 1 when it has to wait for
 *  the target and 2 when it is done, and waits for real (a few ms per poll)
 *  because the first sender only finishes on the main thread. */
const SECOND_SENDER = `
const fs = require("node:fs");
const { workerData } = require("node:worker_threads");
const flag = new Int32Array(workerData.flag);
const signal = (v) => { Atomics.store(flag, 0, v); Atomics.notify(flag, 0); };
const makeTerminal = ${fakeTerminal.toString()};
import(workerData.moduleUrl).then(({ sendAgentMessage, LOCK_POLL_MS }) => {
  const run = makeTerminal(workerData.dir, fs);
  try {
    sendAgentMessage(workerData.options, run, (ms) => {
      if (ms === LOCK_POLL_MS) signal(1);
      Atomics.wait(flag, 1, 0, 5);
    });
  } finally {
    signal(2);
  }
});
`;

test("#1636 two senders to one pane: the second waits for the first Return, both submit alone", async () => {
  const dir = fs.mkdtempSync(join(scratch, "pane-"));
  const lockRoot = join(dir, "locks");
  const flag = new SharedArrayBuffer(8);
  let worker;
  let waitedFor = "timeout";
  sendAgentMessage({ ...options, text: "first", lockRoot }, fakeTerminal(dir, fs), (ms) => {
    assert.equal(ms, ENTER_PAUSE_MS);
    worker = new Worker(SECOND_SENDER, {
      eval: true,
      workerData: {
        moduleUrl: new URL("../cmux-agent-send.mjs", import.meta.url).href,
        options: { ...options, from: "claude", text: "second", lockRoot },
        dir,
        flag,
      },
    });
    // Inside the first sender's #1155 pause: the second one must not get through.
    waitedFor = Atomics.wait(new Int32Array(flag), 0, 0, 10_000);
  });
  const [code] = await once(worker, "exit");
  assert.equal(code, 0);
  assert.notEqual(waitedFor, "timed-out", "the second sender neither waited nor finished");
  const submissions = fs
    .readFileSync(join(dir, "submissions"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(submissions.length, 2);
  assert.match(submissions[0], /^<agent-message from="codex"[^>]*>"first"<\/agent-message>$/);
  assert.match(submissions[1], /^<agent-message from="claude"[^>]*>"second"<\/agent-message>$/);
  assert.deepEqual(fs.readdirSync(lockRoot), [], "no lock is left behind");
});

test("#1636 a failed send releases the target; a lock left by a dead sender is taken over", () => {
  const lockRoot = join(fs.mkdtempSync(join(scratch, "pane-")), "locks");
  assert.throws(() => sendAgentMessage({ ...options, lockRoot }, () => ({ status: 1 }), noPause), /no Enter/);
  assert.deepEqual(fs.readdirSync(lockRoot), []);
  const pauses = [];
  sendAgentMessage(
    { ...options, lockRoot },
    () => ({ status: 0 }),
    (ms) => pauses.push(ms)
  );
  assert.deepEqual(pauses, [ENTER_PAUSE_MS], "a free target is not waited for");

  // A sender killed between text and Return leaves its lock behind; once it is
  // older than the longest possible hold, the next sender takes it over.
  let lockName;
  sendAgentMessage(
    { ...options, lockRoot },
    () => {
      [lockName] = fs.readdirSync(lockRoot);
      return { status: 0 };
    },
    noPause
  );
  const stale = new Date(Date.now() - 60_000);
  fs.mkdirSync(join(lockRoot, lockName));
  fs.utimesSync(join(lockRoot, lockName), stale, stale);
  pauses.length = 0;
  sendAgentMessage(
    { ...options, lockRoot },
    () => ({ status: 0 }),
    (ms) => pauses.push(ms)
  );
  assert.deepEqual(pauses, [ENTER_PAUSE_MS]);
  assert.deepEqual(fs.readdirSync(lockRoot), []);
});

/** Runs in a worker so an unbounded retry loop can be stopped from outside.
 *  Its clock advances only by the pauses the sender asks for (#1645). */
const STUCK_SENDER = `
const { workerData, parentPort } = require("node:worker_threads");
let offset = 0;
const realNow = Date.now;
Date.now = () => realNow() + offset;
import(workerData.moduleUrl).then(({ sendAgentMessage }) => {
  let transport = 0;
  try {
    sendAgentMessage(workerData.options, () => (transport++, { status: 0 }), (ms) => (offset += ms));
    parentPort.postMessage({ sent: true, transport });
  } catch (error) {
    parentPort.postMessage({ error: error.message, transport, waited: offset });
  }
});
`;

test("#1645 an unremovable stale lock ends in 'busy' within the wait, is kept, and nothing is sent", async () => {
  const fixtures = {
    "nonempty directory": (lock) => {
      fs.mkdirSync(lock);
      fs.writeFileSync(join(lock, "sentinel"), "foreign");
      return join(lock, "sentinel");
    },
    "regular file": (lock) => {
      fs.writeFileSync(lock, "foreign");
      return lock;
    },
  };
  for (const [name, plant] of Object.entries(fixtures)) {
    const lockRoot = join(fs.mkdtempSync(join(scratch, "pane-")), "locks");
    let lockName;
    sendAgentMessage(
      { ...options, lockRoot },
      () => {
        [lockName] = fs.readdirSync(lockRoot);
        return { status: 0 };
      },
      noPause
    );
    const lock = join(lockRoot, lockName);
    const sentinel = plant(lock);
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, stale, stale);
    const worker = new Worker(STUCK_SENDER, {
      eval: true,
      workerData: {
        moduleUrl: new URL("../cmux-agent-send.mjs", import.meta.url).href,
        options: { ...options, lockRoot },
      },
    });
    // Only a broken (unbounded) loop ever reaches this real timeout.
    const timer = setTimeout(() => worker.terminate(), 5_000);
    const [result] = await Promise.race([once(worker, "message"), once(worker, "exit").then(() => [undefined])]);
    clearTimeout(timer);
    await worker.terminate();
    assert.ok(result, `${name}: the sender never returned`);
    assert.match(result.error ?? "", /cmux target busy/, name);
    assert.equal(result.transport, 0, `${name}: nothing reaches cmux`);
    assert.ok(result.waited > 0 && result.waited <= 21_000, `${name}: bounded by the wait (${result.waited} ms)`);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "foreign", `${name}: foreign contents stay`);
  }
});

test("#1648 a broken symlink at the lock pauses between retries, ends 'busy' and stays", async () => {
  const lockRoot = join(fs.mkdtempSync(join(scratch, "pane-")), "locks");
  let lockName;
  sendAgentMessage(
    { ...options, lockRoot },
    () => {
      [lockName] = fs.readdirSync(lockRoot);
      return { status: 0 };
    },
    noPause
  );
  const lock = join(lockRoot, lockName);
  const target = join(lockRoot, "missing-target");
  fs.symlinkSync(target, lock);
  const worker = new Worker(STUCK_SENDER, {
    eval: true,
    workerData: {
      moduleUrl: new URL("../cmux-agent-send.mjs", import.meta.url).href,
      options: { ...options, lockRoot },
    },
  });
  // The clock only moves by requested pauses: a loop that never pauses cannot
  // reach the deadline and is stopped by this real timeout instead.
  const timer = setTimeout(() => worker.terminate(), 5_000);
  const [result] = await Promise.race([once(worker, "message"), once(worker, "exit").then(() => [undefined])]);
  clearTimeout(timer);
  await worker.terminate();
  assert.ok(result, "the sender spun without pausing");
  assert.match(result.error ?? "", /cmux target busy/);
  assert.equal(result.transport, 0, "nothing reaches cmux");
  assert.ok(result.waited > 0 && result.waited <= 21_000, `bounded by the wait (${result.waited} ms)`);
  assert.equal(fs.readlinkSync(lock), target, "the foreign link stays");
  assert.equal(fs.existsSync(target), false, "its target is not created");
});
