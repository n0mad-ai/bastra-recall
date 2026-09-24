/**
 * Tests für den API-Token-Lifecycle in cli-settings.json (ensureApiToken /
 * getApiToken / setApiToken). Alle gegen ein Temp-File, nie das echte
 * ~/.bastra/cli-settings.json.
 *
 * Runner: `tsx --test __tests__/settings-token.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureApiToken,
  getApiToken,
  clearApiToken,
  readSettings,
  setUpdateMode,
} from "../src/settings.js";

async function withTempSettings(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-token-test-"));
  const path = join(dir, "cli-settings.json");
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("getApiToken: undefined when no token issued yet", async () => {
  await withTempSettings(async (path) => {
    assert.equal(await getApiToken(path), undefined);
  });
});

test("ensureApiToken: mints, persists, and is idempotent without rotate", async () => {
  await withTempSettings(async (path) => {
    const t1 = await ensureApiToken({}, path);
    assert.equal(typeof t1, "string");
    assert.ok(t1.length >= 32, "256-bit base64url is ~43 chars");
    // persisted + re-read identically
    assert.equal(await getApiToken(path), t1);
    // second call returns the SAME token (no rotation)
    const t2 = await ensureApiToken({}, path);
    assert.equal(t2, t1);
  });
});

test("ensureApiToken: rotate issues a fresh token, invalidating the old", async () => {
  await withTempSettings(async (path) => {
    const t1 = await ensureApiToken({}, path);
    const t2 = await ensureApiToken({ rotate: true }, path);
    assert.notEqual(t2, t1);
    assert.equal(await getApiToken(path), t2);
  });
});

test("setApiToken/ensureApiToken merge: other settings survive", async () => {
  await withTempSettings(async (path) => {
    await setUpdateMode("auto", path);
    await ensureApiToken({}, path);
    const s = await readSettings(path);
    assert.equal(s.update.mode, "auto", "token write must not clobber update.mode");
    assert.ok(s.api?.token);
  });
});

test("clearApiToken: removes a set token and reports it removed", async () => {
  await withTempSettings(async (path) => {
    await ensureApiToken({}, path);
    assert.ok(await getApiToken(path), "precondition: token exists");
    const removed = await clearApiToken(path);
    assert.equal(removed, true);
    assert.equal(await getApiToken(path), undefined);
  });
});

test("clearApiToken: returns false when no token was set", async () => {
  await withTempSettings(async (path) => {
    assert.equal(await clearApiToken(path), false);
    assert.equal(await getApiToken(path), undefined);
  });
});

test("clearApiToken: other settings survive the clear", async () => {
  await withTempSettings(async (path) => {
    await setUpdateMode("auto", path);
    await ensureApiToken({}, path);
    await clearApiToken(path);
    const s = await readSettings(path);
    assert.equal(s.update.mode, "auto", "clearing the token must not clobber update.mode");
    assert.equal(s.api, undefined, "the api block is gone");
  });
});

test("token file is written 0600 (owner-only)", async () => {
  await withTempSettings(async (path) => {
    await ensureApiToken({}, path);
    const { mode } = await (await import("node:fs/promises")).stat(path);
    assert.equal(mode & 0o777, 0o600);
    // sanity: it really contains the token
    assert.match(await readFile(path, "utf8"), /"token":/);
  });
});
