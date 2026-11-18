/**
 * Review of 02e4e0f7..fffff172 (P1): a settings reader that misses its
 * deadline may be stuck in a native read that terminate() cannot interrupt.
 * Until it has really exited, no further reader is started: deadline-bound
 * requests get no answer at once instead of a new thread each.
 *
 * The stuck read is simulated without a real blocking file: the worker never
 * receives the request (postMessage is swallowed) and terminate() does
 * nothing, as with a thread blocked in a native open.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { SettingsReadLate, readSettingsRecordOffThread } from "../src/settings-record-thread.js";

test("a stuck settings reader is the only one until it exits; later requests return at once", async (t) => {
  const started = new Set<Worker>();
  const realTerminate = Worker.prototype.terminate;
  t.mock.method(Worker.prototype, "postMessage", function (this: Worker) {
    started.add(this);
  });
  const terminate = t.mock.method(Worker.prototype, "terminate", async () => 0);

  const first = Date.now();
  await assert.rejects(readSettingsRecordOffThread("/nonexistent/cli-settings.json", first + 50), SettingsReadLate);
  for (let i = 0; i < 3; i++) {
    const asked = Date.now();
    await assert.rejects(readSettingsRecordOffThread("/nonexistent/cli-settings.json", asked + 50), SettingsReadLate);
    assert.ok(Date.now() - asked < 40, "a request behind a stuck reader returns before its deadline");
  }
  assert.equal(started.size, 1, "exactly one reader thread while the first one has not exited");
  assert.equal(terminate.mock.callCount(), 1, "the stuck reader is asked to stop once");

  // Once the stuck reader really exits, a replacement may start.
  const [stuck] = started;
  const exited = new Promise((resolve) => stuck.once("exit", resolve));
  await Reflect.apply(realTerminate, stuck, []);
  await exited;
  await assert.rejects(
    readSettingsRecordOffThread("/nonexistent/cli-settings.json", Date.now() + 50),
    SettingsReadLate
  );
  assert.equal(started.size, 2, "a replacement starts only after the stuck reader exited");
  t.mock.restoreAll();
  for (const worker of started) await worker.terminate();
});

test("a reader that cannot run gives a deadline-bound caller no answer instead of a blocking direct read", async (t) => {
  const started = new Set<Worker>();
  t.mock.method(Worker.prototype, "postMessage", function (this: Worker) {
    started.add(this);
    queueMicrotask(() => this.emit("error", new Error("cannot start")));
  });
  await assert.rejects(
    readSettingsRecordOffThread("/nonexistent/cli-settings.json", Date.now() + 5000),
    SettingsReadLate
  );
  // Without a deadline the direct read still counts: no record for this path.
  assert.equal(await readSettingsRecordOffThread("/nonexistent/cli-settings.json"), undefined);
  t.mock.restoreAll();
  for (const worker of started) await worker.terminate();
});
