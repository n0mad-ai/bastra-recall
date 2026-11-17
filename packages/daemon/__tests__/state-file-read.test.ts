/**
 * #1604: the update-check cache and staged marker, the task comparison
 * migration marker and the vault care list are read through one descriptor
 * that cannot follow a link or wait on a FIFO. A FIFO at one of these paths
 * used to hang the reader; now each caller gives its fail-closed answer at once.
 */
import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markStagedToday, stagedToday } from "../src/update-check.js";
import { rewriteCareNote, CARE_FILE } from "../src/vault-care.js";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { readTaskStore } from "../src/task-store.js";

const posix = process.platform !== "win32";
const mkfifo = (path: string) => execFileSync("mkfifo", [path]);

test(
  "#1604 staged-update marker: a FIFO reads as not staged and is never written through",
  { skip: !posix, timeout: 5000 },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "state-file-home-"));
    const saved = process.env.HOME;
    process.env.HOME = home;
    t.after(async () => {
      process.env.HOME = saved;
      await rm(home, { recursive: true, force: true });
    });
    // Where bastraDataDir() puts it on this platform: find it by writing once.
    await markStagedToday();
    assert.equal(await stagedToday(), true);
    const marker = execFileSync("find", [home, "-name", "update-staged.txt"], { encoding: "utf8" }).trim();
    assert.ok(marker, "the marker was written below the test HOME");
    await rm(marker);
    mkfifo(marker);
    assert.equal(await stagedToday(), false);
    await markStagedToday();
    assert.ok((await lstat(marker)).isFIFO(), "the FIFO is left in place, not replaced or written through");
  }
);

test(
  "#1604 vault care: a care list that is a FIFO or a link is refused, not read",
  { skip: !posix, timeout: 5000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "state-file-care-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const target = { id: "beta", kind: "delete" as const, date: "2026-11-02", note: "flag" };
    const fifo = join(dir, "fifo", CARE_FILE);
    await mkdir(join(dir, "fifo"));
    mkfifo(fifo);
    await assert.rejects(rewriteCareNote(fifo, target, "edited"), { code: "EUNSAFE" });
    const real = join(dir, "real.md");
    await writeFile(real, "- [ ] 2026-11-02 · delete · [[beta]] — flag\n");
    const link = join(dir, "link", CARE_FILE);
    await mkdir(join(dir, "link"));
    await symlink(real, link);
    await assert.rejects(rewriteCareNote(link, target, "edited"), { code: "ELOOP" });
  }
);

test(
  "#1604 task comparison migration: a FIFO marker fails closed instead of hanging",
  { skip: !posix, timeout: 5000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "state-file-task-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => 1000 };
    const agent = await mintTaskCredential(ctx.authPath, { actor_id: "agent", role: "agent", domains: ["personal"] });
    await callTaskCrud(ctx, `Bearer ${agent.token}`, "task_create", {
      idempotency_key: "one",
      original_request: "Review",
      goal: "Review",
      resolution_condition: "Done",
      schedule: { kind: "instant", at: 2000 },
      timezone: "Europe/Madrid",
      scope: { kind: "personal", name: "fixture" },
      owner_domains: ["personal"],
      arm: true,
      origin: { kind: "user-request", client: "test", session: "test", context: "Review" },
    });
    // A fresh path stands for an installation whose migration has not run yet.
    const path = join(root, "legacy.json");
    await writeFile(path, JSON.stringify(await readTaskStore(ctx.path)), { mode: 0o600 });
    mkfifo(`${path}.comparison-migration`);
    await assert.rejects(readTaskStore(path), { code: "corrupt" });
  }
);
