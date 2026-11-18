import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ensureVaultDir,
  noteVaultRootPresent,
  vaultRootFirstSeen,
  VaultRootHistoryError,
  VaultRootMissingError,
} from "../src/vault-root-guard.js";

test("a corrupt vault-root history never turns a missing known vault into a new one", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-root-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.BASTRA_VAULT_ROOTS_PATH;
  const marker = join(dir, "vault-roots.json");
  process.env.BASTRA_VAULT_ROOTS_PATH = marker;
  t.after(() => {
    if (previous === undefined) delete process.env.BASTRA_VAULT_ROOTS_PATH;
    else process.env.BASTRA_VAULT_ROOTS_PATH = previous;
  });
  await writeFile(marker, "{broken");
  const root = join(dir, "missing-vault");
  await assert.rejects(ensureVaultDir(root, join(root, "memories"), { createRoot: true }), VaultRootHistoryError);
  assert.equal(existsSync(root), false);
  assert.equal(await readFile(marker, "utf8"), "{broken", "the corrupt history is preserved for repair");
});

test("a lost marker is re-persisted and child creation stays inside the root", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-root-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.BASTRA_VAULT_ROOTS_PATH;
  const marker = join(dir, "vault-roots.json");
  process.env.BASTRA_VAULT_ROOTS_PATH = marker;
  t.after(() => {
    if (previous === undefined) delete process.env.BASTRA_VAULT_ROOTS_PATH;
    else process.env.BASTRA_VAULT_ROOTS_PATH = previous;
  });
  const root = join(dir, "vault");
  await mkdir(root);
  noteVaultRootPresent(root);
  await rm(marker);
  await ensureVaultDir(root, join(root, "memories", "projects"));
  assert.equal(existsSync(join(root, "memories", "projects")), true);
  assert.ok(JSON.parse(await readFile(marker, "utf8"))[root], "the marker was restored before the writer returned");
  await assert.rejects(ensureVaultDir(root, join(dir, "outside")), /outside vault root/);
  assert.equal(existsSync(join(dir, "outside")), false);
});

test(
  "a differently cased spelling cannot recreate a recorded root on a case-insensitive volume",
  { skip: process.platform !== "darwin" && process.platform !== "win32" },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "bastra-root-case-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const previous = process.env.BASTRA_VAULT_ROOTS_PATH;
    const marker = join(dir, "vault-roots.json");
    process.env.BASTRA_VAULT_ROOTS_PATH = marker;
    t.after(() => {
      if (previous === undefined) delete process.env.BASTRA_VAULT_ROOTS_PATH;
      else process.env.BASTRA_VAULT_ROOTS_PATH = previous;
    });
    const recorded = join(dir, "Vault");
    const alternate = join(dir, "vault");
    await mkdir(recorded);
    if (!existsSync(alternate)) {
      t.skip("temporary volume is case-sensitive");
      return;
    }
    await writeFile(marker, JSON.stringify({ [recorded]: { first_seen: "2026-10-04T00:00:00.000Z" } }));
    await rmdir(recorded);

    assert.equal(vaultRootFirstSeen(alternate), "2026-10-04T00:00:00.000Z");
    await assert.rejects(
      ensureVaultDir(alternate, join(alternate, "memories"), { createRoot: true }),
      VaultRootMissingError
    );
    assert.equal(existsSync(alternate), false);
  }
);

test("the history-unavailable stop names the marker file, the cause and the repair (#1049)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-root-history-msg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.BASTRA_VAULT_ROOTS_PATH;
  const marker = join(dir, "vault-roots.json");
  process.env.BASTRA_VAULT_ROOTS_PATH = marker;
  t.after(() => {
    if (previous === undefined) delete process.env.BASTRA_VAULT_ROOTS_PATH;
    else process.env.BASTRA_VAULT_ROOTS_PATH = previous;
  });
  await writeFile(marker, "");
  const root = join(dir, "vault");
  await mkdir(root);
  const err = await ensureVaultDir(root, root).then(
    () => null,
    (e: unknown) => e
  );
  assert.ok(err instanceof VaultRootHistoryError);
  assert.equal(
    err.message,
    `Bastra refuses every vault write: the vault-root history ${marker} is empty or corrupt. If the vault is mounted, delete that file; it is rewritten on the next save.`
  );
});

test(
  "an unwritable state directory says to fix its permissions (#1049)",
  { skip: process.getuid?.() === 0 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "bastra-root-history-perm-"));
    const state = join(dir, "state");
    await mkdir(state);
    t.after(async () => {
      await chmod(state, 0o700);
      await rm(dir, { recursive: true, force: true });
    });
    const previous = process.env.BASTRA_VAULT_ROOTS_PATH;
    const marker = join(state, "vault-roots.json");
    process.env.BASTRA_VAULT_ROOTS_PATH = marker;
    t.after(() => {
      if (previous === undefined) delete process.env.BASTRA_VAULT_ROOTS_PATH;
      else process.env.BASTRA_VAULT_ROOTS_PATH = previous;
    });
    const root = join(dir, "vault");
    await mkdir(root);
    await chmod(state, 0o500);
    const err = await ensureVaultDir(root, root).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(err instanceof VaultRootHistoryError);
    assert.equal(
      err.message,
      `Bastra refuses every vault write: the vault-root history ${marker} cannot be written. Fix the permissions of ${state}; the file is rewritten on the next save.`
    );
  }
);

/**
 * #1659: two processes register different roots against one history file.
 * Barrier files force the interleaving from the issue: both read the empty
 * history, A renames its copy, B renames its stale copy over it, then A checks.
 * Only each process's FIRST rename is held; the barriers are files, so the
 * order is fixed, not timed.
 */
const RACE_CHILD = `
import fs from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
const [role, root, barrier, guardUrl] = process.argv.slice(1);
const cell = new Int32Array(new SharedArrayBuffer(4));
const wait = (name) => {
  const until = Date.now() + 15000;
  while (!fs.existsSync(join(barrier, name))) {
    if (Date.now() > until) throw new Error("barrier " + name + " never opened");
    Atomics.wait(cell, 0, 0, 2);
  }
};
const signal = (name) => fs.writeFileSync(join(barrier, name), "");
const rename = fs.renameSync;
let held = false;
fs.renameSync = (from, to) => {
  if (held) return rename(from, to);
  held = true;
  if (role === "A") {
    wait("B-ready");
    rename(from, to);
    signal("A-renamed");
    wait("B-renamed");
  } else {
    signal("B-ready");
    wait("A-renamed");
    rename(from, to);
    signal("B-renamed");
  }
};
syncBuiltinESMExports();
const { ensureVaultDir } = await import(guardUrl);
try {
  await ensureVaultDir(root, root, { createRoot: true });
  console.log("ok");
} catch (e) {
  console.log(String(e.code) + ":" + String(e.cause));
}
`;

test("#1659: concurrent registrations of two roots keep both and let both writers save", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-root-history-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marker = join(dir, "vault-roots.json");
  const barrier = join(dir, "barrier");
  const rootA = join(dir, "TempA");
  const rootB = join(dir, "TempB");
  await Promise.all([mkdir(barrier), mkdir(rootA), mkdir(rootB), writeFile(marker, "{}\n")]);
  const guardUrl = new URL("../src/vault-root-guard.ts", import.meta.url).href;
  const run = (role: string, root: string) =>
    promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", RACE_CHILD, role, root, barrier, guardUrl],
      { timeout: 30_000, env: { ...process.env, BASTRA_VAULT_ROOTS_PATH: marker } }
    );
  const [a, b] = await Promise.all([run("A", rootA), run("B", rootB)]);
  assert.equal(b.stdout.trim(), "ok");
  assert.equal(a.stdout.trim(), "ok", "A must not be refused although the history is writable");
  const history = JSON.parse(await readFile(marker, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(history).sort(), [rootA, rootB].sort());
});

test("#1659: a history that keeps losing this root reports a concurrent-update conflict", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-root-history-conflict-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.BASTRA_VAULT_ROOTS_PATH;
  const marker = join(dir, "vault-roots.json");
  process.env.BASTRA_VAULT_ROOTS_PATH = marker;
  const other = join(dir, "other-vault");
  const stale = JSON.stringify({ [other]: { first_seen: "2026-11-18T00:00:00.000Z" } });
  const realRename = fs.renameSync;
  // Every rename of ours is immediately overwritten by another writer's stale copy.
  fs.renameSync = (from: fs.PathLike, to: fs.PathLike) => {
    realRename(from, to);
    fs.writeFileSync(to, stale);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.renameSync = realRename;
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.BASTRA_VAULT_ROOTS_PATH;
    else process.env.BASTRA_VAULT_ROOTS_PATH = previous;
  });
  const root = join(dir, "vault");
  await mkdir(root);
  const err = await ensureVaultDir(root, root).then(
    () => null,
    (e: unknown) => e
  );
  assert.ok(err instanceof VaultRootHistoryError);
  assert.equal(err.code, "VAULT_ROOT_HISTORY_UNAVAILABLE");
  assert.equal(err.cause, "conflict");
  assert.match(err.message, /other processes/);
  assert.equal(await readFile(marker, "utf8"), stale, "the other writer's history is left as it is");
});
