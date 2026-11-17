/**
 * #1524 — installer backups are private from the first write.
 *
 * `backupConfig` is the one helper every client adapter (Codex, Claude Code,
 * Claude Desktop, Cursor) calls before rewriting a config. It used `copyFile`,
 * which carries the source mode over: a 0644 hooks.json produced a 0644
 * backup.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupConfig } from "../src/cli/helpers.js";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-backup-mode-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("backupConfig writes a 0600 backup of a 0644 config", { skip: process.platform === "win32" }, async () => {
  await withDir(async (dir) => {
    const config = join(dir, "hooks.json");
    await writeFile(config, '{"hooks":{}}\n', { encoding: "utf8", mode: 0o644 });

    const backup = await backupConfig(config);
    assert.ok(backup);
    assert.match(backup, /hooks\.json\.bak-/);
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
    assert.equal(await readFile(backup, "utf8"), '{"hooks":{}}\n');
    assert.equal((await stat(config)).mode & 0o777, 0o644, "the original keeps its mode");
  });
});

test("backupConfig never replaces an earlier backup made in the same instant", async (t) => {
  // Freeze the clock so both calls derive the same timestamped name.
  mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 17, 12) });
  t.after(() => mock.timers.reset());
  await withDir(async (dir) => {
    const config = join(dir, "config.toml");
    await writeFile(config, "original\n", "utf8");
    const first = await backupConfig(config);
    await writeFile(config, "intermediate\n", "utf8");
    const second = await backupConfig(config);
    assert.ok(first && second);
    assert.notEqual(first, second);
    assert.equal(await readFile(first, "utf8"), "original\n");
    assert.equal(await readFile(second, "utf8"), "intermediate\n");
  });
});

test(
  "backupConfig does not write through a symlink planted at the backup name",
  { skip: process.platform === "win32" },
  async (t) => {
    const now = Date.UTC(2026, 10, 17, 12);
    mock.timers.enable({ apis: ["Date"], now });
    t.after(() => mock.timers.reset());
    await withDir(async (dir) => {
      const config = join(dir, "config.json");
      const victim = join(dir, "victim");
      await writeFile(config, "{}\n", "utf8");
      await writeFile(victim, "untouched\n", "utf8");
      const ts = new Date(now).toISOString().replace(/[:.]/g, "-");
      await symlink(victim, `${config}.bak-${ts}`);

      const backup = await backupConfig(config);
      assert.ok(backup);
      assert.equal(backup, `${config}.bak-${ts}-1`);
      assert.equal(await readFile(victim, "utf8"), "untouched\n");
      assert.equal(await readFile(backup, "utf8"), "{}\n");
    });
  }
);
