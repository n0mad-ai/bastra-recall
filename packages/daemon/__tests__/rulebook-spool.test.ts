/** The outage spool lives below tmpdir, which Linux shares between accounts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainRulebookFailures, spoolRulebookFailure } from "../src/rulebook-spool.js";

test(
  "outage spool is skipped in a foreign-writable directory and never reads a FIFO",
  { skip: process.platform === "win32" },
  async () => {
    const previous = process.env.BASTRA_HOOK_STATE_DIR;
    const base = await mkdtemp(join(tmpdir(), "spool-private-"));
    process.env.BASTRA_HOOK_STATE_DIR = base;
    const key = createHash("sha256").update("spool-sid").digest("hex").slice(0, 24);
    const fifo = `${key}-00000000-0000-0000-0000-000000000000.json`;
    try {
      await spoolRulebookFailure("spool-sid", 2);
      assert.equal(await drainRulebookFailures("spool-sid"), 2, "a private spool still works");
      execFileSync("mkfifo", [join(base, "rulebook-failures", fifo)]);
      assert.equal(await drainRulebookFailures("spool-sid"), 0, "a FIFO entry neither blocks nor counts");
      await chmod(base, 0o777);
      await spoolRulebookFailure("spool-sid", 5);
      assert.deepEqual(
        await readdir(join(base, "rulebook-failures")),
        [fifo],
        "nothing is written below a foreign-writable directory"
      );
      await chmod(base, 0o700);
      await chmod(join(base, "rulebook-failures"), 0o777);
      await spoolRulebookFailure("spool-sid", 5);
      assert.deepEqual(await readdir(join(base, "rulebook-failures")), [fifo]);
      assert.equal(await drainRulebookFailures("spool-sid"), 0);
    } finally {
      await chmod(base, 0o700);
      if (previous === undefined) delete process.env.BASTRA_HOOK_STATE_DIR;
      else process.env.BASTRA_HOOK_STATE_DIR = previous;
    }
  }
);

test(
  "a symlink planted at the spool base creates nothing where it points",
  { skip: process.platform === "win32" },
  async () => {
    const previous = process.env.BASTRA_HOOK_STATE_DIR;
    const root = await mkdtemp(join(tmpdir(), "spool-link-"));
    const target = join(root, "elsewhere");
    await mkdir(target);
    await symlink(target, join(root, "bastra-hook"));
    process.env.BASTRA_HOOK_STATE_DIR = join(root, "bastra-hook");
    try {
      await spoolRulebookFailure("spool-sid", 1);
      assert.deepEqual(await readdir(target), [], "no spool directory appears in the symlink target");
      assert.equal(await drainRulebookFailures("spool-sid"), 0);
    } finally {
      if (previous === undefined) delete process.env.BASTRA_HOOK_STATE_DIR;
      else process.env.BASTRA_HOOK_STATE_DIR = previous;
    }
  }
);
