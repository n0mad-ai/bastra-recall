/**
 * #1571: which /ui routes answer while the web UI is switched off.
 *
 * Every /ui route is gated on ui.enabled, with two written exceptions:
 *   - /ui/health — the same payload as the loopback /health route, which
 *     answers with the web UI off as well; a gate would hide nothing.
 *   - /ui/assistant-address/refresh — the CLI calls it after an address change.
 * /ui/vault-image and /ui/import-count follow the setting; the hook's own
 * /hook/import keeps answering.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
import { settingsFilePath, setUiEnabled } from "../src/settings.js";

test("#1571: with the web UI off, only the two documented /ui exceptions answer", async (t) => {
  assert.ok(process.env.BASTRA_TEST_RUN_ROOT, "requires isolated test profile");
  const root = await mkdtemp(join(tmpdir(), "ui-disabled-routes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = settingsFilePath();
  await mkdir(join(settingsPath, ".."), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ ui: { enabled: false } }));
  const runtimeDir = join(root, "runtime");
  await mkdir(runtimeDir);
  await writeFile(join(root, "hosts"), "127.0.0.1 localhost\n");
  const vaultDir = join(root, "vault");
  await mkdir(vaultDir);
  // A vault image exists, so a 404 below is the gate and not a missing file.
  await writeFile(join(vaultDir, "vault-image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const vault = new Vault(vaultDir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: vaultDir },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
    assistantAddress: {
      port: 0,
      settingsPath,
      hostsPath: join(root, "hosts"),
      helperPath: join(root, "helper.plist"),
      runtimeDir,
      firefoxRoot: join(root, "firefox"),
      home: root,
      uid: String(process.getuid?.() ?? 0),
      username: "fixture",
      platform: "darwin",
      ensureRuntime: async () => {},
      openBrowser: async () => {},
      runAdmin: async () => {
        throw new Error("no system change in this test");
      },
    },
  });
  t.after(async () => {
    await handle.close();
    search.stop();
    await vault.stop?.();
  });
  const base = `http://127.0.0.1:${handle.port}`;
  const get = (path: string) => fetch(base + path, { headers: { Connection: "close" } });

  // Gated: the emblem and the nav badge's count.
  const image = await get("/ui/vault-image");
  assert.equal(image.status, 404);
  assert.deepEqual(await image.json(), { error: "ui disabled" });
  const count = await get("/ui/import-count");
  assert.equal(count.status, 404);
  assert.deepEqual(await count.json(), { error: "ui disabled" });
  // The hook's own route stays open.
  assert.equal((await get("/hook/import")).status, 200);

  // Exception: /ui/health is /health under another name.
  const uiHealth = await get("/ui/health");
  const health = await get("/health");
  assert.equal(uiHealth.status, 200);
  assert.deepEqual(
    Object.keys((await uiHealth.json()) as object).sort(),
    Object.keys((await health.json()) as object).sort()
  );

  // Exception: the CLI's refresh; the address page itself stays gated.
  assert.equal((await get("/ui/assistant-address")).status, 404);
  const refresh = await fetch(base + "/ui/assistant-address/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: "{}",
  });
  assert.notEqual(refresh.status, 404, await refresh.text());

  // With the UI on, the gated routes answer again.
  await setUiEnabled(true, settingsPath);
  const shown = await get("/ui/vault-image");
  assert.equal(shown.status, 200, await shown.text());
  assert.equal((await get("/ui/import-count")).status, 200);
});
