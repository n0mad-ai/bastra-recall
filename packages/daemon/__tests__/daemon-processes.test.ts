/**
 * Tests for the extra-daemon detection.
 *
 * The port keeps the production daemon single by construction — two processes
 * cannot bind 6723. What nothing noticed was a daemon on ANOTHER port: a
 * measurement harness from 21 July ran for six days on 6799 holding its own
 * vault index, invisible to /health, `status` and `doctor` alike.
 *
 * Run: npx tsx --test packages/daemon/__tests__/daemon-processes.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { parseDaemonProcesses, formatExtraDaemons, daemonPort } from "../src/cli/daemon-processes.js";

const PS = `  PID     ELAPSED COMMAND
15445       30:00 /opt/homebrew/bin/node /Users/x/bastra-recall/packages/daemon/dist/index.js
86207 06-14:02:02 node /Users/x/bastra-recall/packages/daemon/dist/index.js
66296    13:32:02 node /Users/x/bastra-recall/packages/daemon/dist/mcp-forwarder.js
 4602       00:00 node /Users/x/bastra-recall/packages/statusline/dist/index.mjs --style=powerline
47236 57-12:03:31 /opt/homebrew/Cellar/postgresql@17/bin/postgres -D /Users/x/db -p 5432`;

test("finds the daemons and nothing else", () => {
  const procs = parseDaemonProcesses(PS, 15445);
  assert.deepEqual(procs.map((p) => p.pid), [15445, 86207]);
  // The forwarder runs once per client session and is not a daemon; the
  // statusline and postgres are not ours to report on at all.
});

test("the port holder is the primary, the other is not", () => {
  const procs = parseDaemonProcesses(PS, 15445);
  assert.equal(procs.find((p) => p.pid === 15445)?.primary, true);
  assert.equal(procs.find((p) => p.pid === 86207)?.primary, false);
});

test("elapsed time is carried through — six days is the tell", () => {
  const procs = parseDaemonProcesses(PS, 15445);
  assert.equal(procs.find((p) => p.pid === 86207)?.elapsed, "06-14:02:02");
});

test("#527 — an inert argument that merely mentions the entry point is not a daemon", () => {
  // The same weak criterion the Finder uninstaller used: a substring anywhere
  // in argv. What counts is the script the process executes, not what it was
  // handed as data.
  const withDecoy =
    `${PS}\n77777       00:05 node /Users/x/tool/worker.js note:/some/daemon/dist/index.js`;
  assert.deepEqual(parseDaemonProcesses(withDecoy, 15445).map((p) => p.pid), [15445, 86207]);
});

test("#527 — the entry point as argv[0] (a bin shim) still counts", () => {
  const shim = "  PID ELAPSED COMMAND\n31000 00:10 /opt/homebrew/Cellar/bastra-recall/1.0.0/libexec/packages/daemon/dist/index.js";
  assert.deepEqual(parseDaemonProcesses(shim, null).map((p) => p.pid), [31000]);
});

test("#527 — node options before the script do not hide it", () => {
  const opts = "  PID ELAPSED COMMAND\n31001 00:10 node --enable-source-maps /x/packages/daemon/dist/index.js";
  assert.deepEqual(parseDaemonProcesses(opts, null).map((p) => p.pid), [31001]);
});

test("a grep line for the same pattern is not a process", () => {
  const withGrep = `${PS}\n99999       00:01 grep daemon/dist/index.js`;
  assert.equal(parseDaemonProcesses(withGrep, 15445).length, 2);
});

test("no listener known → nothing is primary, and the report stays honest", () => {
  const procs = parseDaemonProcesses(PS, null);
  assert.equal(procs.filter((p) => p.primary).length, 0);
  // With no primary identified, both count as "other" — better to name one
  // process too many than to stay silent about a second daemon.
  const msg = formatExtraDaemons(procs);
  assert.ok(msg);
  assert.match(msg, /2 further daemon/);
});

test("one daemon says nothing", () => {
  const single = parseDaemonProcesses(
    "  PID ELAPSED COMMAND\n15445 30:00 node /x/packages/daemon/dist/index.js",
    15445,
  );
  assert.equal(formatExtraDaemons(single), null);
});

test("no daemon at all says nothing — the daemon line already covers that", () => {
  assert.equal(formatExtraDaemons([]), null);
});

test("the message names the pids and how to stop them", () => {
  const msg = formatExtraDaemons(parseDaemonProcesses(PS, 15445));
  assert.ok(msg);
  assert.match(msg, /pid 86207 \(06-14:02:02\)/);
  assert.match(msg, /kill 86207/);
  assert.doesNotMatch(msg, /15445/); // never suggest killing the live one
});

test("daemonPort honours the env, falls back to 6723", () => {
  const before = process.env.BASTRA_HTTP_PORT;
  try {
    delete process.env.BASTRA_HTTP_PORT;
    assert.equal(daemonPort(), 6723);
    process.env.BASTRA_HTTP_PORT = "6799";
    assert.equal(daemonPort(), 6799);
    process.env.BASTRA_HTTP_PORT = "nonsense";
    assert.equal(daemonPort(), 6723);
  } finally {
    if (before === undefined) delete process.env.BASTRA_HTTP_PORT;
    else process.env.BASTRA_HTTP_PORT = before;
  }
});
