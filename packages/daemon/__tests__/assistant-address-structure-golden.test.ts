/** Public lifecycle byte contracts, recorded before the #1532 module split. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setupAssistantAddress,
  removeAssistantAddress,
  assistantAddressStatus,
} from "../src/assistant-address.js";
import { cmdAddress } from "../src/cli/address-cmd.js";
import { parseArgs } from "../src/cli/commands.js";
import type { AddressAdminPlan } from "../src/assistant-address-admin.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "address-structure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const o = {
    home: root,
    uid: "501",
    username: "fixture",
    machineNames: ["fixture-machine"],
    platform: "darwin" as const,
    settingsPath: join(root, "settings"),
    hostsPath: join(root, "hosts"),
    runtimeDir: join(root, "runtime"),
    runtimeSourceDir: join(root, "source"),
    runtimeNode: "/fixture/node",
    helperPath: join(root, "helper.plist"),
    firefoxRoot: join(root, "firefox"),
    daemonUrl: "http://127.0.0.1:9",
    gatewayPort: 0,
    systemConsent: true,
    firefoxRunning: async () => false,
    runtimeProcesses: async () => [],
    helperLoaded: async () => true,
    runAdmin: async (p: AddressAdminPlan) => applyPlan(p),
  };
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    assert.equal(String(url), "http://127.0.0.1:0/.well-known/bastra-assistant-address");
    return Response.json({ service: "bastra-assistant-address", name: "jarvis" });
  });
  await mkdir(o.runtimeSourceDir);
  for (const name of [
    "assistant-address-bootstrap.js",
    "assistant-address-gateway.js",
    "local-account-access.js",
    "assistant-address-name.js",
    "assistant-address-files.js",
    "http-auth.js",
    "runtime-settings.js",
  ]) {
    const text = name === "assistant-address-gateway.js"
      ? 'import { readRuntimeSettings } from "@bastra-recall/core/runtime-settings";\n'
      : `// fixture ${name}\n`;
    await writeFile(join(o.runtimeSourceDir, name), text);
  }
  await writeFile(o.hostsPath, "127.0.0.1 localhost\n10.0.0.2 foreign\n");
  await mkdir(join(o.firefoxRoot, "profile"), { recursive: true });
  await writeFile(join(o.firefoxRoot, "profiles.ini"), "[Profile0]\nIsRelative=1\nPath=profile\n");
  await writeFile(join(o.firefoxRoot, "profile/user.js"), 'user_pref("foreign", true);\n');
  return o;
}
async function applyPlan(p: AddressAdminPlan) {
  await writeFile(p.hostsPath, p.hostsAfter);
  if (p.helperAfter === null) await rm(p.helperPath, { force: true });
  else await writeFile(p.helperPath, p.helperAfter);
  if (p.companion) {
    if (p.companion.after === null) await rm(p.companion.path, { force: true });
    else await writeFile(p.companion.path, p.companion.after);
  }
}
async function tree(path: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const key = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, await tree(join(path, entry.name), key + "/"));
    else result[key] = await readFile(join(path, entry.name), "utf8");
  }
  return result;
}
function canonical(value: unknown, root: string): unknown {
  // Only machine-specific fixture roots and random operation/publication IDs vary.
  return JSON.parse(JSON.stringify(value)
    .replaceAll(root, "<root>")
    .replaceAll(root.replaceAll("/", "\\/"), "<root>")
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, "<uuid>"));
}
async function capture(o: Awaited<ReturnType<typeof fixture>>) {
  const current = JSON.parse(await readFile(join(o.runtimeDir, "current.json"), "utf8"));
  assert.match(current.generation, /^[a-f0-9-]{36}$/);
  assert.match(current.version, /^[a-f0-9]{64}$/);
  const status = await assistantAddressStatus(o);
  return canonical({
    runtime: await tree(o.runtimeDir),
    hosts: await readFile(o.hostsPath, "utf8"),
    helper: await readFile(o.helperPath, "utf8"),
    companion: await readFile(o.helperPath + ".ipv6.plist", "utf8"),
    firefox: await tree(o.firefoxRoot),
    status,
  }, o.home);
}

test("#1532 assistant lifecycle preserves installer, runtime and status bytes", async (t) => {
  const o = await fixture(t);
  t.assert.snapshot(await setupAssistantAddress({ ...o, name: "Jarvis" }));
  t.assert.snapshot(await capture(o));
  const copied = await tree(o.runtimeDir);
  assert.ok(Object.values(copied).includes('import { readRuntimeSettings } from "./runtime-settings.js";\n'));
  let output = "";
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { output += String(chunk); return true; });
  assert.equal(await cmdAddress(parseArgs(["address", "status"]), o), 0);
  t.assert.snapshot(canonical(output, o.home));
  await removeAssistantAddress(o);
  t.assert.snapshot(canonical({
    hosts: await readFile(o.hostsPath, "utf8"),
    firefox: await tree(o.firefoxRoot),
    status: await assistantAddressStatus({ ...o, helperLoaded: async () => false }),
  }, o.home));
});

test("#1532 late admin recovery preserves resulting files and diagnostics", async (t) => {
  const o = await fixture(t);
  let pending: AddressAdminPlan | undefined;
  await assert.rejects(setupAssistantAddress({
    ...o,
    name: "Jarvis",
    runAdmin: async (p) => { pending = p; throw Error("fixture lost admin response"); },
  }));
  t.assert.snapshot(canonical(await assistantAddressStatus(o), o.home));
  assert.ok(pending);
  await applyPlan(pending);
  await pending.onSettled?.(true);
  t.assert.snapshot(await capture(o));
  // Repeated inspection must leave the already-published current.json byte-identical.
  const before = await readFile(join(o.runtimeDir, "current.json"), "utf8");
  await assistantAddressStatus(o);
  assert.equal(await readFile(join(o.runtimeDir, "current.json"), "utf8"), before);
});
