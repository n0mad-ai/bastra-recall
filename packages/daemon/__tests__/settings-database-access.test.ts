import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, request } from "node:http";
import { readRuntimeSettingsRecord } from "@bastra-recall/core/runtime-settings";
import { assistantGatewayHandler } from "../src/assistant-address-gateway.js";
import { openAppDatabase } from "../src/app-database.js";
import { readAppRecord, writeAppRecord } from "../src/app-record-store.js";
import { readSizeSettings } from "../src/file-size-check.js";
import { isRepoEnabledSync } from "../src/code-graph/enabled-repos.js";
import { runtimeFeatureSetting } from "../src/runtime-feature-settings.js";
import { mutateSettings, readSettings, settingsFileState } from "../src/settings-file.js";

const permissionSkip = process.platform === "win32" || process.getuid?.() === 0;

test("#1418 a non-directory DB parent is reported and cannot authorize a settings write", { skip: process.platform === "win32" }, async t => {
  const root = mkdtempSync(join(tmpdir(), "settings-db-notdir-"));
  const regular = join(root, "regular-file"); writeFileSync(regular, "fixture");
  const previous = process.env.BASTRA_DB_PATH;
  process.env.BASTRA_DB_PATH = join(regular, "recall.db");
  t.after(() => { if (previous === undefined) delete process.env.BASTRA_DB_PATH; else process.env.BASTRA_DB_PATH = previous; });
  const legacy = join(root, "settings.json"); writeFileSync(legacy, '{"ui":{"enabled":true}}');
  assert.deepEqual(await settingsFileState(legacy), { unreadable: "ENOTDIR" });
  let mutated = false;
  await assert.rejects(mutateSettings(legacy, current => { mutated = true; return current; }), /cannot be read \(ENOTDIR\)/);
  assert.equal(mutated, false);
  assert.equal(readFileSync(legacy, "utf8"), '{"ui":{"enabled":true}}');
  assert.equal(readFileSync(regular, "utf8"), "fixture");
});

function inaccessible(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "settings-access-"));
  const parent = join(root, "private");
  mkdirSync(parent);
  const path = join(parent, "recall.db");
  const db = openAppDatabase({ path }); db.close();
  chmodSync(parent, 0);
  t.after(() => chmodSync(parent, 0o700));
  assert.equal(existsSync(path), false, "non-root reproduction of existsSync hiding EACCES");
  return { root, parent, path };
}

test("#1418 inaccessible DB parent is reported, never classified as absent", { skip: permissionSkip }, t => {
  const { root, path } = inaccessible(t);
  let diagnostic = "";
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { diagnostic += chunk; return true; }) as typeof write;
  try {
    assert.equal(readRuntimeSettingsRecord(join(root, "settings.json"), path), null);
    assert.match(diagnostic, /settings.*EACCES/i, "failure is reported without exposing settings contents");
  } finally { process.stderr.write = write; }
});

test("#1418 inaccessible DB override cannot revive stale UI opt-in over HTTP", { skip: permissionSkip }, async t => {
  const { root, path } = inaccessible(t);
  const settingsPath = join(root, "settings.json");
  const original = JSON.stringify({ ui: { enabled: true }, assistant: { name: "jarvis" } });
  writeFileSync(settingsPath, original);
  let forwarded = 0;
  const backend = createServer((_req, res) => { forwarded++; res.end("stale-opt-in"); });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => backend.close(() => resolve())));
  const gateway = createServer(assistantGatewayHandler({ settingsPath, databasePath: path,
    hostsPath: join(root, "hosts"), daemonUrl: `http://127.0.0.1:${(backend.address() as { port: number }).port}` }));
  await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => gateway.close(() => resolve())));
  const response = await new Promise<number>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: (gateway.address() as { port: number }).port,
      path: "/ui/", headers: { Host: "jarvis.localhost" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    req.on("error", reject); req.end();
  });
  assert.equal(response, 404);
  assert.equal(forwarded, 0);
  assert.equal(readFileSync(settingsPath, "utf8"), original);
});

test("#1418 app DB and record readers preserve a DB parent access error", { skip: permissionSkip }, async t => {
  const { root, path } = inaccessible(t);
  const previous = process.env.BASTRA_DB_PATH;
  process.env.BASTRA_DB_PATH = path;
  t.after(() => { if (previous === undefined) delete process.env.BASTRA_DB_PATH; else process.env.BASTRA_DB_PATH = previous; });
  const legacy = join(root, "settings.json"); writeFileSync(legacy, '{"ui":{"enabled":true}}');
  assert.throws(() => openAppDatabase({ path }), { code: "EACCES" });
  assert.throws(() => readAppRecord("settings", legacy), { code: "EACCES" });
  let diagnostic = "";
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { diagnostic += chunk; return true; }) as typeof write;
  try {
    assert.deepEqual(await settingsFileState(legacy), { unreadable: "EACCES" });
    await readSettings(legacy);
    assert.match(diagnostic, /settings read failed \(EACCES\)/, "ordinary settings readers must not use silent defaults either");
  } finally { process.stderr.write = write; }
  assert.equal(readFileSync(legacy, "utf8"), '{"ui":{"enabled":true}}');
});

test("#1418 thin settings consumers do not reuse stale enabled repos or thresholds", { skip: permissionSkip }, async t => {
  const { root, path } = inaccessible(t);
  const previous = process.env.BASTRA_DB_PATH;
  process.env.BASTRA_DB_PATH = path;
  t.after(() => { if (previous === undefined) delete process.env.BASTRA_DB_PATH; else process.env.BASTRA_DB_PATH = previous; });
  const legacy = join(root, "settings.json");
  writeFileSync(legacy, JSON.stringify({ size: { guide: 200, critical: 400 }, code: { repos: [root] }, tasks: { enabled: true } }));
  assert.deepEqual(await readSizeSettings(legacy), {});
  assert.equal(isRepoEnabledSync(root, legacy, {}, "darwin"), false);
  assert.equal(runtimeFeatureSetting("tasks", false), false);
});

test("#1418 interrupted archive cannot silently skip an inaccessible legacy parent", { skip: permissionSkip }, t => {
  const root = mkdtempSync(join(tmpdir(), "settings-archive-access-"));
  const parent = join(root, "legacy"); mkdirSync(parent);
  const path = join(parent, "settings.json");
  const previous = process.env.BASTRA_DB_PATH;
  process.env.BASTRA_DB_PATH = join(root, "recall.db");
  t.after(() => { chmodSync(parent, 0o700); if (previous === undefined) delete process.env.BASTRA_DB_PATH; else process.env.BASTRA_DB_PATH = previous; });
  writeFileSync(path, "original");
  assert.equal(readAppRecord("settings", path), "original");
  writeFileSync(path, "retained");
  chmodSync(parent, 0);
  assert.throws(() => writeAppRecord("settings", path, "replacement"), { code: "EACCES" });
  chmodSync(parent, 0o700);
  assert.equal(readAppRecord("settings", path), "original");
});
