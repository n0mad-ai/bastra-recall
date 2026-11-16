/**
 * The web UI default follows the account binding (owner decision 16.11.2026,
 * v1.2.0): on where the local account check runs (macOS), off elsewhere. A
 * stored `ui.enabled` always wins. The platform is simulated per test, so this
 * file says the same on a macOS development machine and in the Linux CI.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/webui-default-platform.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountBindingEnforced, webUiOnByDefault } from "../src/local-account-access.js";
import { SETTINGS_REGISTRY, settingEntry } from "../src/settings-registry.js";
import { effectiveSetting } from "../src/settings-effective.js";
import { getUiEnabled, readSettings } from "../src/settings.js";
import { readAssistantGatewayConfig } from "../src/assistant-address-gateway.js";
import { handleWebUi, resolveWebUiDir } from "../src/webui.js";
import { vaultMapQuestion } from "../src/cli/wizard.js";

async function onPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T> | T): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

/** A settings file in a fresh temp dir; `undefined` stores no ui.enabled (other settings only). */
async function withSettings<T>(stored: boolean | undefined, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "webui-default-"));
  const path = join(dir, "cli-settings.json");
  const ui = stored === undefined ? {} : { ui: { enabled: stored } };
  // An assistant name, so the assistant-address gateway has a configuration to read.
  await writeFile(path, JSON.stringify({ update: { mode: "notify" }, assistant: { name: "jarvis" }, ...ui }));
  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the default is on exactly where the account binding runs", () => {
  assert.equal(webUiOnByDefault({ platform: "darwin" }), true);
  assert.equal(webUiOnByDefault({ platform: "linux" }), false);
  assert.equal(webUiOnByDefault({ platform: "win32" }), false);
  for (const platform of ["darwin", "linux", "win32"] as const)
    assert.equal(webUiOnByDefault({ platform }), accountBindingEnforced({ platform }));
});

test("registry, settings entry and effective value show the same platform default", async () => {
  for (const [platform, expected] of [
    ["darwin", true],
    ["linux", false],
  ] as const) {
    await onPlatform(platform, () => {
      assert.equal(SETTINGS_REGISTRY.ui.enabled.default, expected, platform);
      const entry = settingEntry("ui.enabled")!;
      assert.equal(entry.default, expected, platform);
      assert.equal(entry.kind, "boolean");
      assert.equal(effectiveSetting(entry, { update: { mode: "notify" } }, {}).value, expected, platform);
    });
  }
});

test("no stored value → platform default; a stored value wins on every platform", async () => {
  const cases = [
    ["darwin", undefined, true],
    ["linux", undefined, false],
    ["darwin", false, false],
    ["linux", false, false],
    ["darwin", true, true],
    ["linux", true, true],
  ] as const;
  for (const [platform, stored, expected] of cases) {
    await withSettings(stored, (path) =>
      onPlatform(platform, async () => {
        assert.equal(await getUiEnabled(path), expected, `${platform} stored=${stored}`);
        const settings = await readSettings(path);
        assert.equal(effectiveSetting(settingEntry("ui.enabled")!, settings, {}).value, expected);
        // The assistant-address gateway reads the stored record on its own and must agree.
        assert.equal((await readAssistantGatewayConfig(path))?.enabled, expected);
      })
    );
  }
});

test("reading the default never writes a value", async () => {
  await withSettings(undefined, (path) =>
    onPlatform("darwin", async () => {
      assert.equal(await getUiEnabled(path), true);
      assert.equal((await readSettings(path)).ui, undefined, "nothing stored after a read");
    })
  );
});

test("setup wizard preselects the current state: on for a fresh Mac, off on Linux with the reason", () => {
  const mac = vaultMapQuestion("http://127.0.0.1:6723/ui/", true, true);
  assert.equal(mac.initialValue, "on");
  assert.ok(mac.options.find((o) => o.value === "off")?.hint?.includes("bastra config set ui.enabled true"));

  const linux = vaultMapQuestion("http://127.0.0.1:6723/ui/", false, false);
  assert.equal(linux.initialValue, "off");
  const offHint = linux.options.find((o) => o.value === "off")?.hint ?? "";
  assert.match(offHint, /only on macOS/);
  assert.match(offHint, /bastra config set ui\.enabled true/);

  // A Mac user who switched it off keeps "Off" preselected: Enter does not undo the choice.
  assert.equal(vaultMapQuestion("http://127.0.0.1:6723/ui/", false, true).initialValue, "off");
  // A Linux user who switched it on keeps "On".
  assert.equal(vaultMapQuestion("http://127.0.0.1:6723/ui/", true, false).initialValue, "on");
});

async function getUi(settingsPath: string): Promise<{ status: number; body: string }> {
  const server = createServer((req, res) => {
    void handleWebUi(req, res, req.url ?? "/", resolveWebUiDir(), settingsPath);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    return await new Promise((resolve, reject) => {
      const rq = request({ hostname: "127.0.0.1", port, path: "/ui/", method: "GET" }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      rq.on("error", reject);
      rq.end();
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("/ui/ serves the UI on the Mac default and the enable hint on the Linux default", async () => {
  await withSettings(undefined, async (path) => {
    const mac = await onPlatform("darwin", () => getUi(path));
    assert.equal(mac.status, 200);
    assert.match(mac.body, /<html/i);

    const linux = await onPlatform("linux", () => getUi(path));
    assert.equal(linux.status, 404);
    assert.match(linux.body, /bastra config set ui\.enabled true/);
  });
  await withSettings(false, async (path) => {
    const mac = await onPlatform("darwin", () => getUi(path));
    assert.equal(mac.status, 404, "a stored false stays off on the Mac");
    assert.match(mac.body, /bastra config set ui\.enabled true/);
  });
  await withSettings(true, async (path) => {
    assert.equal((await onPlatform("linux", () => getUi(path))).status, 200, "a stored true stays on under Linux");
  });
});
