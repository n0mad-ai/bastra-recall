/**
 * `claimIsAbandoned`: a claim whose owner pid answers alive on this host is
 * proof of life — but only up to a ceiling. A dead writer's pid is reused by
 * the OS; without the ceiling such a claim never ages out and every save to
 * that id conflicts until the lock file is removed by hand.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { claimIsAbandoned } from "../src/save-commit.js";

async function claimFile(t: { after: (fn: () => Promise<void>) => void }, ageMs: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-save-commit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lock = join(dir, "m.commit.lock");
  // process.pid stands in for "some live process holding the owner's old pid".
  await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now() - ageMs, token: "t" }), "utf8");
  const when = new Date(Date.now() - ageMs);
  await utimes(lock, when, when);
  return lock;
}

test("a fresh claim with a live local owner is not abandoned", async (t) => {
  const lock = await claimFile(t, 60_000);
  assert.equal(await claimIsAbandoned(lock), false);
});

test("a live-owner claim past the ceiling ages out (reused pid)", async (t) => {
  const lock = await claimFile(t, 60 * 60_000);
  assert.equal(await claimIsAbandoned(lock), true);
});

for (const failures of [1, 2]) {
  test(`claim preparation tolerates EINVAL (${failures} failures)`, async t => {
    const fs = await import("node:fs/promises");
    const { syncBuiltinESMExports } = await import("node:module");
    const { acquireCommitClaim, releaseCommitClaim } = await import("../src/save-commit.js");
    const root = await mkdtemp(join(tmpdir(), "claim-einval-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const original = fs.default.open;
    let attempts = 0;
    t.mock.method(fs.default, "open", async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).includes(".publish/") && attempts++ < failures) {
        throw Object.assign(new Error("removed preparation directory"), { code: "EINVAL" });
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      const lock = join(root, "id.lock");
      if (failures === 1) {
        const token = await acquireCommitClaim(lock, "id", join(root, "id.md"));
        await releaseCommitClaim(lock, token);
      } else await assert.rejects(acquireCommitClaim(lock, "id", join(root, "id.md")), { name: "MemoryWriteConflictError" });
      assert.equal(attempts, 2);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
}
