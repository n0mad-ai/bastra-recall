/**
 * A settings reader that is still starting (thread, modules) has not begun
 * any read, so it is not stuck. On a slow machine its start-up can outlast
 * the size note's deadline: that request gets no answer in time, but the
 * reader must stay and answer the next one, instead of being terminated and
 * blocking every later request until it exits (CI, golden master #1525).
 *
 * The slow start is simulated by holding back the worker's "ready" message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { SettingsReadLate, readSettingsRecordOffThread, warmSettingsReader } from "../src/settings-record-thread.js";

test("a deadline missed while the reader starts fails only that request; the reader stays", async (t) => {
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
  const terminate = t.mock.method(Worker.prototype, "terminate");

  await assert.rejects(readSettingsRecordOffThread("/nonexistent/cli-settings.json", Date.now() + 1), SettingsReadLate);
  assert.equal(terminate.mock.callCount(), 0, "a reader that has not started is not treated as stuck");

  release();
  await warmSettingsReader();
  assert.equal(
    await readSettingsRecordOffThread("/nonexistent/cli-settings.json", Date.now() + 5000),
    undefined,
    "the same reader answers the next deadline-bound request"
  );
  assert.equal(terminate.mock.callCount(), 0);
});
