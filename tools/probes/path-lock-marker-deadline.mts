/** #1207: fresh empty/remote mutation/recovery markers must heal within 5 s.
 * 32 attempts per marker/owner/lane combination, real clock and filesystem.
 * node --import tsx --import ./scripts/test-env.mjs tools/probes/path-lock-marker-deadline.mts
 */
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { withPathLock, pathLockFilePath } from "../../packages/daemon/src/path-lock.js";

const dir = await mkdtemp(join(tmpdir(), "bastra-marker-deadline-"));
let rejected = 0, failOpen = 0, acquired = 0, maxFollowupMs = 0;
try {
  const attempts: Promise<void>[] = [];
  for (const recovery of [false, true]) for (const remote of [false, true]) for (const requireLock of [false, true]) {
    for (let round = 0; round < 32; round++) {
      const state = join(dir, `${recovery}-${remote}-${requireLock}-${round}`);
      const guard = `${pathLockFilePath(state)}.mutation`;
      const body = remote ? JSON.stringify({ pid: process.pid, host: "remote", token: "remote" }) : "";
      writeFileSync(guard, recovery ? JSON.stringify({ pid: 2147483647, host: hostname(), token: "dead" }) : body, { mode: 0o600 });
      if (recovery) writeFileSync(`${guard}.recover`, body, { mode: 0o600 });
      const start = performance.now();
      attempts.push(withPathLock(state, async () => {
        if (existsSync(pathLockFilePath(state))) acquired++;
        else failOpen++;
      }, { crossProcess: true, requireLock }).catch(() => { rejected++; }).finally(() => {
        maxFollowupMs = Math.max(maxFollowupMs, performance.now() - start);
      }));
    }
  }
  await Promise.all(attempts);
  const leftovers = (await readdir(dir)).length;
  console.log(JSON.stringify({ attempts: attempts.length, acquired, rejected, failOpen, leftovers, maxFollowupMs }));
  assert.equal(rejected, 0);
  assert.equal(failOpen, 0);
  assert.equal(acquired, attempts.length);
  assert.equal(leftovers, 0);
} finally { await rm(dir, { recursive: true, force: true }); }
