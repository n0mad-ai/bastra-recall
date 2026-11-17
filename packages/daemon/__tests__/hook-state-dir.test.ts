/**
 * #1569 — on Linux the hook state no longer sits in the tmpdir every account
 * shares, and moving it loses nothing: rows stored by earlier versions keep
 * their namespace, and legacy files in the old tmpdir location are still
 * imported when this account owns that directory.
 *
 * The Linux default is simulated by overriding `process.platform`; TMPDIR and
 * HOME come from scripts/test-env.mjs and point into the run's temp root.
 *
 * Runner: npm test (scripts/test-env.mjs isolates HOME and the logs).
 */
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bastraDataDir } from "@bastra-recall/core/platform-paths";
import { defaultHookStateDir, legacyHookStateDir } from "../src/private-state-dir.js";
import { openAppDatabase } from "../src/app-database.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const saved: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(async () => {
  // A fresh tmpdir and data dir per case, so the module-level snapshot cache
  // (keyed by database path) never carries one case into the next.
  const root = await mkdtemp(join(tmpdir(), "hook-state-dir-"));
  setEnv("TMPDIR", join(root, "tmp"));
  setEnv("HOME", join(root, "home"));
  setEnv("BASTRA_HOOK_STATE_DIR", undefined);
  setEnv("BASTRA_DB_PATH", join(root, "recall.db"));
  await mkdir(join(root, "tmp"), { recursive: true });
  await mkdir(join(root, "home"), { recursive: true });
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(saved)) delete saved[key];
});

const asLinux = () => Object.defineProperty(process, "platform", { ...platform, value: "linux" });

test("#1569: Linux keeps hook state below the account's data directory, macOS and Windows keep tmpdir", () => {
  assert.equal(defaultHookStateDir("linux"), join(bastraDataDir(), "hook-state"));
  assert.ok(!resolve(defaultHookStateDir("linux")).startsWith(resolve(tmpdir())), "not in the shared tmpdir");
  assert.equal(defaultHookStateDir("darwin"), join(tmpdir(), "bastra-hook"));
  assert.equal(defaultHookStateDir("win32"), join(tmpdir(), "bastra-hook"));
});

test("#1569: session state stored by an earlier version under the tmpdir location is still found", async () => {
  asLinux();
  // What an earlier version committed: the namespace of the old tmpdir path.
  const suffix = createHash("sha256").update(resolve(legacyHookStateDir())).digest("hex");
  const db = openAppDatabase({ path: process.env.BASTRA_DB_PATH! });
  db.sqlite
    .prepare("INSERT INTO app_records(namespace,key,value) VALUES(?,?,?)")
    .run(
      `hook-session:${suffix}`,
      "old-session",
      JSON.stringify({ raw: '{"shown":{"memo":{"count":1,"at":1}}}', at: 1 })
    );
  db.close();
  const ss = await import("../src/session-state.js");
  assert.equal(ss.sessionStateDir(), join(bastraDataDir(), "hook-state"));
  assert.deepEqual((await ss.loadSessionState("old-session")).shown, { memo: { count: 1, at: 1 } });
});

test("#1569: a legacy state file in this account's own old tmpdir location is imported", async () => {
  asLinux();
  const legacy = legacyHookStateDir();
  await mkdir(legacy, { recursive: true, mode: 0o700 });
  await writeFile(join(legacy, "file-session.json"), '{"shown":{"filed":{"count":2,"at":5}}}', { mode: 0o600 });
  const ss = await import("../src/session-state.js");
  assert.deepEqual((await ss.loadSessionState("file-session")).shown, { filed: { count: 2, at: 5 } });
});
