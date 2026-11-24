import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { Vault } from "@bastra-recall/core";
import { startVaultReconcile } from "../src/daemon-jobs.js";

test("periodic reconcile logs only a slow run, after that run settles", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const previous = process.env.BASTRA_VAULT_RECONCILE_MS;
  delete process.env.BASTRA_VAULT_RECONCILE_MS;
  t.after(() => {
    if (previous !== undefined) process.env.BASTRA_VAULT_RECONCILE_MS = previous;
  });
  let elapsed = 0;
  t.mock.method(performance, "now", () => elapsed);
  const log = t.mock.method(console, "error", () => {});
  let rejectSlow!: (reason: Error) => void;
  const slow = new Promise<number>((_, reject) => {
    rejectSlow = reject;
  });
  let calls = 0;
  const vault = { reconcile: () => (++calls === 1 ? slow : Promise.resolve(0)) };
  const timer = startVaultReconcile(vault as Vault);
  assert.ok(timer);
  t.after(() => clearInterval(timer));

  t.mock.timers.tick(60_000);
  elapsed = 1200;
  assert.equal(log.mock.callCount(), 0);
  rejectSlow(new Error("test reconcile failure"));
  await setImmediate();
  assert.deepEqual(
    log.mock.calls.map(({ arguments: args }) => args),
    [["[bastra-recall] slow background job: vault reconcile (1200 ms)"]]
  );
  t.mock.timers.tick(60_000);
  elapsed += 999;
  await setImmediate();
  assert.equal(calls, 2);
  assert.equal(log.mock.callCount(), 1);
});
