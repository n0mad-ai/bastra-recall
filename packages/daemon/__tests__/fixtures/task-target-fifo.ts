/** #1213 probes in their own process: a blocking open would wedge the whole event loop. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { finalTargetCommit } from "../../src/task-execution.js";
import { quarantineOfflineTaskLock } from "../../src/task-maintenance.js";
import { bytesHash } from "../../src/task-approval-keys.js";
import { PathLockUnavailableError } from "../../src/path-lock.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "task-target-fifo-")));
if (process.argv[2] === "target") {
  // The target was a regular file at readTaskTarget; a FIFO is swapped in before the CAS.
  const target = join(root, "note.txt"), tmp = join(root, ".bastra-task-x.tmp");
  writeFileSync(tmp, "after"); execFileSync("mkfifo", [target]);
  const lease = { id: "lease", state: "active", actor: "agent", fence: 1, holder_token_hash: bytesHash("holder"), expires_at: Number.MAX_SAFE_INTEGER, boot_id: "boot", monotonic_deadline: Number.MAX_SAFE_INTEGER };
  const store = { controls: { enabled: true, execution_stopped: false, adapters: { "local-artifact-v1": { enabled: true } } }, leases: [lease], approvals: [] };
  const intent = { lease_id: "lease", actor: "agent", approval_ids: [], before_hash: bytesHash("before") };
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), actionClock: () => ({ boot_id: "boot", monotonic: 0 }) };
  let renamed = false;
  assert.throws(() => finalTargetCommit(ctx as any, store as any, intent as any, { token: "holder", fence: 1 }, target, tmp, () => { renamed = true; }), { code: "approval_stale" });
  assert.equal(renamed, false); assert.equal(readFileSync(tmp, "utf8"), "after");
} else {
  // Offline lock recovery: a FIFO in the lock family is rejected without being read.
  const path = join(root, "tasks.json"), lock = `${path}.lock`;
  execFileSync("mkfifo", [lock]);
  assert.throws(() => quarantineOfflineTaskLock(path), PathLockUnavailableError);
  assert.ok(existsSync(lock));
  // The recovery holds the reclaim cleanup marker while it works and gives it back afterwards.
  unlinkSync(lock);
  writeFileSync(lock, JSON.stringify({ pid: 999999999, host: hostname(), token: "dead" }));
  writeFileSync(`${lock}.reclaim.cleanup`, "");
  assert.equal(quarantineOfflineTaskLock(path).quarantined, 2);
  assert.ok(!existsSync(lock) && !existsSync(`${lock}.reclaim.cleanup`) && !existsSync(`${lock}.operator`));
  assert.equal(readdirSync(root).filter(f => f.includes(".quarantine-")).length, 2);
}
process.stdout.write("probe passed\n");
