import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAssistantName,
  getAssistantDisplayName,
  setAssistantName,
  setAssistantDisplayName,
} from "../src/assistant-address-settings.js";
import { renameAssistant } from "../src/http-assistant-address.js";
import { setupAssistantAddress } from "../src/assistant-address.js";
import { mutateSettings, readSettings } from "../src/settings.js";

test("display name keeps the typed spelling; the address name derives from it", async (t) => {
  const d = await mkdtemp(join(tmpdir(), "assistant-display-"));
  t.after(() => rm(d, { recursive: true, force: true }));
  const path = join(d, "settings.json");
  await setAssistantName("jarvis", path);
  assert.equal(await getAssistantDisplayName(path), "jarvis", "older settings show the stored address name");
  await setAssistantDisplayName(" Jarvis ", path);
  assert.equal(await getAssistantDisplayName(path), "Jarvis");
  assert.equal(await getAssistantName(path), "jarvis");
  await setAssistantName("jarvis", path);
  assert.equal(await getAssistantDisplayName(path), "Jarvis", "the same address keeps the display name");
  await setAssistantName("ruby", path);
  assert.equal(await getAssistantDisplayName(path), "ruby", "a different address drops a stale display name");
  for (const bad of ["Jürgen", "Mein Jarvis", "!!!", "a\u0007b", "x".repeat(64), "localhost"])
    await assert.rejects(setAssistantDisplayName(bad, path), /Assistentenname/, bad);
  assert.equal(await getAssistantDisplayName(path), "ruby", "rejected input changes nothing");
  // Externally edited data is validated on read.
  await mutateSettings(path, (s) => ({ ...s, assistant: { name: "ruby", displayName: "Ru by" } }) as never);
  assert.equal((await readSettings(path)).assistant?.displayName, undefined);
  assert.equal(await getAssistantDisplayName(path), "ruby");
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }, platform: NodeJS.Platform = "darwin") {
  const root = await mkdtemp(join(tmpdir(), "assistant-rename-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hostsPath = join(root, "hosts"),
    helperPath = join(root, "helper.plist");
  await writeFile(hostsPath, "127.0.0.1 localhost\n");
  await mkdir(join(root, "firefox"));
  const admin = { calls: 0, fail: false };
  const options = {
    settingsPath: join(root, "settings.json"),
    hostsPath,
    helperPath,
    runtimeDir: join(root, "runtime"),
    firefoxRoot: join(root, "firefox"),
    uid: "501",
    username: "fixture",
    home: root,
    platform,
    machineNames: [],
    helperLoaded: async () => true,
    firefoxRunning: async () => false,
    ensureRuntime: async () => {},
    openBrowser: async () => {},
    runAdmin: async (plan: any) => {
      admin.calls++;
      if (admin.fail) {
        await plan.onSettled?.(false); // as the native dialog reports a cancel
        throw new Error("User canceled (-128)");
      }
      await writeFile(hostsPath, plan.hostsAfter);
      if (plan.helperAfter === null) await rm(helperPath, { force: true });
      else await writeFile(helperPath, plan.helperAfter);
      if (plan.companion) {
        if (plan.companion.after === null) await rm(plan.companion.path, { force: true });
        else await writeFile(plan.companion.path, plan.companion.after);
      }
    },
  };
  return { options, admin, hostsPath };
}

test("settings save: a case-only change keeps the address and sets nothing up again", async (t) => {
  const { options, admin, hostsPath } = await fixture(t);
  await setupAssistantAddress({ ...options, name: "jarvis", systemConsent: true });
  assert.equal(admin.calls, 1);
  const hosts = await readFile(hostsPath, "utf8");
  assert.deepEqual(await renameAssistant("Jarvis", { ...options, systemConsent: true }), { warning: undefined });
  assert.equal(admin.calls, 1, "no second admin action");
  assert.equal(await readFile(hostsPath, "utf8"), hosts);
  assert.equal(await getAssistantName(options.settingsPath), "jarvis");
  assert.equal(await getAssistantDisplayName(options.settingsPath), "Jarvis");
});

test("settings save: a new name sets up its derived address once and keeps the spelling", async (t) => {
  const { options, admin, hostsPath } = await fixture(t);
  await renameAssistant("Jarvis", { ...options, systemConsent: true });
  assert.equal(admin.calls, 1, "first name: the address is set up");
  assert.match(await readFile(hostsPath, "utf8"), /127\.0\.0\.1 jarvis jarvis\.localhost/);
  await renameAssistant("Ruby", { ...options, systemConsent: true });
  assert.equal(admin.calls, 2);
  assert.doesNotMatch(await readFile(hostsPath, "utf8"), /jarvis/);
  assert.equal(await getAssistantName(options.settingsPath), "ruby");
  assert.equal(await getAssistantDisplayName(options.settingsPath), "Ruby");
});

test("settings save: a failed address setup still applies the display name and says so", async (t) => {
  const { options, admin, hostsPath } = await fixture(t);
  await renameAssistant("jarvis", { ...options, systemConsent: true });
  const hosts = await readFile(hostsPath, "utf8");
  admin.fail = true;
  const result = await renameAssistant("Ruby", { ...options, systemConsent: true });
  assert.match(result.warning ?? "", /abgebrochen/);
  assert.equal(await getAssistantDisplayName(options.settingsPath), "Ruby");
  assert.equal(await getAssistantName(options.settingsPath), "jarvis", "the set-up address stays in place");
  assert.equal(await readFile(hostsPath, "utf8"), hosts);
  admin.fail = false;
  await renameAssistant("Ruby", { ...options, systemConsent: true });
  assert.equal(await getAssistantName(options.settingsPath), "ruby", "saving again completes the address");
  assert.equal(await getAssistantDisplayName(options.settingsPath), "Ruby");
});

test("settings save: invalid names write nothing; without macOS no admin step runs", async (t) => {
  const { options, admin } = await fixture(t, "linux");
  for (const bad of ["Jürgen", "Mein Jarvis", "---", ""])
    await assert.rejects(renameAssistant(bad, { ...options, systemConsent: true }), /Assistentenname/, bad);
  assert.equal(await getAssistantName(options.settingsPath), null);
  assert.deepEqual(await renameAssistant("Jarvis", { ...options, systemConsent: true }), { warning: undefined });
  assert.equal(admin.calls, 0);
  assert.equal(await getAssistantName(options.settingsPath), "jarvis");
  assert.equal(await getAssistantDisplayName(options.settingsPath), "Jarvis");
});

test("settings save without consent keeps the existing consent gate for a set-up address", async (t) => {
  const { options, admin } = await fixture(t);
  await renameAssistant("jarvis", { ...options, systemConsent: true });
  await assert.rejects(renameAssistant("Ruby", options), /consent|Zustimmung/i);
  assert.equal(admin.calls, 1);
  assert.equal(await getAssistantDisplayName(options.settingsPath), "jarvis");
});
