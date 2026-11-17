/**
 * #1604: lock and marker files in the vault folder are read without following
 * a link or waiting on a FIFO. A FIFO planted at such a path used to hang the
 * reader forever; now it is refused at once, and the callers fail closed.
 *
 * Runner: node --import tsx --test packages/core/__tests__/regular-file.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRegularFile, SMALL_FILE_MAX_BYTES } from "../src/regular-file.js";
import { readAreaMark } from "../src/area-claim.js";
import { claimIsAbandoned, releaseCommitClaim } from "../src/save-commit.js";
import { normalizeScopeKey } from "../src/scope.js";

const posix = process.platform !== "win32";
const mkfifo = (path: string) => execFileSync("mkfifo", [path]);

test(
  "#1604 readRegularFile: a regular file is read, every other kind is refused without waiting",
  { skip: !posix, timeout: 5000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "regular-file-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "ok.json"), '{"token":"a"}');
    assert.equal((await readRegularFile(join(dir, "ok.json"))).raw, '{"token":"a"}');

    mkfifo(join(dir, "fifo"));
    await assert.rejects(readRegularFile(join(dir, "fifo")), { code: "EUNSAFE" });
    await symlink(join(dir, "ok.json"), join(dir, "link"));
    await assert.rejects(readRegularFile(join(dir, "link")), { code: "ELOOP" });
    await mkdir(join(dir, "folder"));
    await assert.rejects(readRegularFile(join(dir, "folder")), { code: "EUNSAFE" });
    await writeFile(join(dir, "big"), "x".repeat(SMALL_FILE_MAX_BYTES + 1));
    await assert.rejects(readRegularFile(join(dir, "big")), { code: "EUNSAFE" });
    await assert.rejects(readRegularFile(join(dir, "missing")), { code: "ENOENT" });
  }
);

test(
  "#1604 area mark: a FIFO at the mark path is an open question, not a free name and not a hang",
  { skip: !posix, timeout: 5000 },
  async (t) => {
    const vault = await mkdtemp(join(tmpdir(), "regular-file-area-"));
    t.after(() => rm(vault, { recursive: true, force: true }));
    const areas = join(vault, ".bastra", "areas");
    await mkdir(areas, { recursive: true });
    const digest = createHash("sha256").update(normalizeScopeKey("demo")).digest("hex").slice(0, 32);
    mkfifo(join(areas, `${digest}.json`));
    await assert.rejects(
      readAreaMark(vault, "demo"),
      /cannot tell whether the area 'demo' is still in use \(EUNSAFE\)/
    );
  }
);

test(
  "#1604 commit claim: a FIFO at the lock path is never taken as abandoned and never read into",
  { skip: !posix, timeout: 5000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "regular-file-claim-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const lock = join(dir, "commit.lock");
    mkfifo(lock);
    assert.equal(await claimIsAbandoned(lock), false, "unknown is never free");
    await releaseCommitClaim(lock, "token");
    // The FIFO is left alone: release only ever removes a lock whose token it read.
    assert.equal(await claimIsAbandoned(lock), false);
  }
);
