/**
 * #648: the local bridges pool lives in its own directory, not inside the
 * Commons checkout, and a pool minted there before the split is copied over
 * once — originals kept, idempotent, never over a pool at the new path.
 *
 * Runner: `tsx --test __tests__/bridges-path-migration.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bridgesPath, migrateBridgesPool } from "../src/cli/bridges.js";
import { commonsPath } from "../src/cli/commons.js";

function restoreEnv(saved: { c: string | undefined; b: string | undefined }): void {
  if (saved.c === undefined) delete process.env.BASTRA_COMMONS_PATH;
  else process.env.BASTRA_COMMONS_PATH = saved.c;
  if (saved.b === undefined) delete process.env.BASTRA_BRIDGES_PATH;
  else process.env.BASTRA_BRIDGES_PATH = saved.b;
}

function withRoots(fn: (commons: string, bridges: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "bastra-bridges-migrate-"));
  const saved = { c: process.env.BASTRA_COMMONS_PATH, b: process.env.BASTRA_BRIDGES_PATH };
  const commons = join(dir, "commons");
  const bridges = join(dir, "bridges-root");
  process.env.BASTRA_COMMONS_PATH = commons;
  process.env.BASTRA_BRIDGES_PATH = bridges;
  try {
    fn(commons, bridges);
  } finally {
    restoreEnv(saved);
    rmSync(dir, { recursive: true, force: true });
  }
}

function legacyPool(commons: string): void {
  mkdirSync(join(commons, "bridges", "en"), { recursive: true });
  mkdirSync(join(commons, "bridges", "archive", "de"), { recursive: true });
  writeFileSync(join(commons, "bridges", "en", "b.json"), '{"lang":"en"}');
  writeFileSync(join(commons, "bridges", "archive", "de", "a.json"), "{}");
  writeFileSync(join(commons, "last-mint.json"), '{"ts":"2026-09-01T00:00:00Z"}');
}

test("the default pool lives in ~/.bastra/bridges, not in the Commons root", () => {
  const saved = { c: process.env.BASTRA_COMMONS_PATH, b: process.env.BASTRA_BRIDGES_PATH };
  delete process.env.BASTRA_COMMONS_PATH;
  delete process.env.BASTRA_BRIDGES_PATH;
  try {
    assert.equal(bridgesPath(), join(homedir(), ".bastra", "bridges"));
    assert.notEqual(bridgesPath(), commonsPath());
  } finally {
    restoreEnv(saved);
  }
});

test("a legacy pool is copied to the new root, originals kept", () => {
  withRoots((commons, bridges) => {
    legacyPool(commons);
    assert.deepEqual(migrateBridgesPool(), ["bridges", "last-mint.json"]);
    assert.equal(readFileSync(join(bridges, "bridges", "en", "b.json"), "utf8"), '{"lang":"en"}');
    assert.ok(existsSync(join(bridges, "bridges", "archive", "de", "a.json")), "the archive moves with the pool");
    assert.equal(readFileSync(join(bridges, "last-mint.json"), "utf8"), '{"ts":"2026-09-01T00:00:00Z"}');
    assert.ok(existsSync(join(commons, "bridges", "en", "b.json")), "the original stays in place");
    assert.ok(existsSync(join(commons, "last-mint.json")));
    assert.ok(!existsSync(join(bridges, "bridges.migrating")), "no staging directory is left behind");
  });
});

test("the copy runs once: a second start copies nothing and keeps new mints", () => {
  withRoots((commons, bridges) => {
    legacyPool(commons);
    migrateBridgesPool();
    writeFileSync(join(bridges, "bridges", "en", "new.json"), "{}");
    writeFileSync(join(commons, "bridges", "en", "late.json"), "{}");
    assert.deepEqual(migrateBridgesPool(), []);
    assert.ok(existsSync(join(bridges, "bridges", "en", "new.json")));
    assert.ok(!existsSync(join(bridges, "bridges", "en", "late.json")), "the old root is not read again");
  });
});

test("a pool already at the new root is never overwritten", () => {
  withRoots((commons, bridges) => {
    legacyPool(commons);
    mkdirSync(join(bridges, "bridges", "en"), { recursive: true });
    writeFileSync(join(bridges, "bridges", "en", "b.json"), '{"mine":true}');
    assert.deepEqual(migrateBridgesPool(), []);
    assert.equal(readFileSync(join(bridges, "bridges", "en", "b.json"), "utf8"), '{"mine":true}');
  });
});

test("nothing to copy on a fresh box, and no directory is created", () => {
  withRoots((_commons, bridges) => {
    assert.deepEqual(migrateBridgesPool(), []);
    assert.ok(!existsSync(bridges));
  });
});

test("BASTRA_BRIDGES_PATH pointing at the Commons root keeps the old layout", () => {
  withRoots((commons) => {
    legacyPool(commons);
    process.env.BASTRA_BRIDGES_PATH = commons;
    assert.equal(bridgesPath(), commons);
    assert.deepEqual(migrateBridgesPool(), []);
  });
});
