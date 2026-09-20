/**
 * #368: "the bridge never reconciles — it starts watching and trusts the
 * watcher." bridge.ts called vault.startWatching() and nothing else, so
 * anything the fs watcher missed while the (long-lived) bridge process was
 * up — an external write on a cloud mount, or any change at all once the
 * watcher itself died — stayed missed until the app restarted. The daemon
 * already runs this job as `startVaultReconcile` (daemon-jobs.ts); the fix
 * is the bridge reusing that SAME exported function, not a copy, so the
 * shared BASTRA_VAULT_RECONCILE_MS knob (0 disables) behaves identically in
 * both places.
 *
 * Two halves:
 *  - behavior: startVaultReconcile itself starts a periodic vault.reconcile()
 *    and BASTRA_VAULT_RECONCILE_MS=0 turns it off — against a fake vault, no
 *    real fs, no waiting on the wall clock.
 *  - wiring: bridge.ts's source actually calls the shared function after
 *    startWatching() and clears the handle on its one shutdown path (stdin
 *    close). bridge.ts runs a stdio RPC loop as a side effect of import
 *    (and exits the process if BASTRA_VAULT_PATH is unset), so a structural
 *    pin is used here instead of spawning it — same reasoning as
 *    scripts-typecheck-wiring.test.ts: pin the wiring, exercise the
 *    behavior where it is cheap and deterministic to isolate.
 *
 * Run: node --import tsx --import ../../scripts/test-env.mjs --test __tests__/bridge-vault-reconcile.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Vault } from "@bastra-recall/core";
import { startVaultReconcile } from "../src/daemon-jobs.js";

const SRC = join(import.meta.dirname, "..", "src");

/**
 * The interval startVaultReconcile creates is deliberately unref()'d (so it
 * never blocks process exit), which means a bare `await` on a promise that
 * only the interval resolves leaves the event loop with nothing to hold it
 * open. Node 22 then cancels the pending test — "Promise resolution is
 * still pending but the event loop has already resolved" — while Node 24
 * tolerates it (see lesson: node-22-bricht-tests-ab-die-auf-ein-ereignis-
 * aus-einem-unref-ten-timer-warten). This sleep is a REF'd timer used only
 * to poll; the exit condition below is always the observed call count,
 * never elapsed time.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(1);
  }
}

function fakeVault(): { vault: Vault; calls: () => number } {
  let calls = 0;
  const vault = {
    reconcile: async () => {
      calls++;
      return 0;
    },
  } as unknown as Vault;
  return { vault, calls: () => calls };
}

function withReconcileMs<T>(value: string, fn: () => T): T {
  const prev = process.env.BASTRA_VAULT_RECONCILE_MS;
  process.env.BASTRA_VAULT_RECONCILE_MS = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.BASTRA_VAULT_RECONCILE_MS;
    else process.env.BASTRA_VAULT_RECONCILE_MS = prev;
  }
}

test("startVaultReconcile: runs vault.reconcile() repeatedly on the configured interval", async () => {
  const { vault, calls } = fakeVault();
  const timer = withReconcileMs("5", () => startVaultReconcile(vault));
  try {
    assert.ok(timer !== null, "an enabled interval must return a handle the caller can stop later");
    // Two passes, not one — proves it repeats instead of firing once.
    await waitUntil(() => calls() >= 2, 2000);
  } finally {
    if (timer) clearInterval(timer);
  }
});

test("startVaultReconcile: BASTRA_VAULT_RECONCILE_MS=0 disables it, in the bridge exactly as in the daemon", async () => {
  const { vault, calls } = fakeVault();
  const timer = withReconcileMs("0", () => startVaultReconcile(vault));
  try {
    assert.equal(timer, null, "a disabled reconcile has no handle to clear");
    await sleep(50);
    assert.equal(calls(), 0, "no interval means no reconcile pass, however long we wait");
  } finally {
    if (timer) clearInterval(timer);
  }
});

test("bridge.ts wiring: starts the shared reconcile after startWatching() and clears it on shutdown (#368)", () => {
  const src = readFileSync(join(SRC, "bridge.ts"), "utf8");
  assert.match(
    src,
    /import\s*\{\s*startVaultReconcile\s*\}\s*from\s*"\.\/daemon-jobs\.js"/,
    "must reuse the daemon's function, not a bridge-local copy",
  );
  const watchIdx = src.indexOf("vault.startWatching();");
  const startIdx = src.indexOf("startVaultReconcile(vault)");
  assert.ok(watchIdx >= 0, "vault.startWatching() must still be there");
  assert.ok(startIdx >= 0, "startVaultReconcile(vault) must be wired in");
  assert.ok(
    startIdx > watchIdx,
    "reconcile must start after the watcher is up, the same order the daemon boots it in after vault.init()",
  );
  assert.match(
    src,
    /reconcileTimer[\s\S]*?clearInterval\(reconcileTimer\)/,
    "the timer handle must be cleared on the bridge's shutdown path (stdin close), not just left to unref()",
  );
});
