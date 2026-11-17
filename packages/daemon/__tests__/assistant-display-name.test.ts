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
import { renameAssistant, needsSystemStep, addressErrorReply } from "../src/http-assistant-address.js";
import { AssistantAddressError, type AssistantAddressErrorCode } from "../src/assistant-address-name.js";
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
  for (const bad of ["", "a\u0007b", "a\nb", "x".repeat(65)])
    await assert.rejects(setAssistantDisplayName(bad, path), { code: "invalid_name" }, bad);
  assert.equal(await getAssistantDisplayName(path), "ruby", "rejected input changes nothing");
  for (const free of ["Jürgen", "Mein Jarvis", "!!!", "localhost", "🤖"]) {
    await setAssistantDisplayName(free, path);
    assert.equal(await getAssistantDisplayName(path), free, "any spelling is kept as typed");
    assert.equal(await getAssistantName(path), "ruby", "the address does not change through the display name");
  }
  await setAssistantDisplayName("Jürgen", path);
  await setAssistantName("xn--jrgen-kva", path);
  assert.equal(await getAssistantDisplayName(path), "Jürgen", "coupling uses the same derivation, not lower case");
  // Externally edited data is validated on read.
  await mutateSettings(path, (s) => ({ ...s, assistant: { name: "ruby", displayName: "Ru\nby" } }) as never);
  assert.equal((await readSettings(path)).assistant?.displayName, undefined);
  assert.equal(await getAssistantDisplayName(path), "ruby");
  await mutateSettings(path, (s) => ({ ...s, assistant: { name: "xn--jrgen-kva" } }) as never);
  assert.equal(await getAssistantDisplayName(path), "jürgen", "without a display name the address reads as typed");
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

test("#1621 settings save: the invalid-name message follows language.primary, the code stays", async (t) => {
  const { options } = await fixture(t, "linux");
  const save = (name: string) => renameAssistant(name, { ...options, systemConsent: true });
  await assert.rejects(save("a\nb"), {
    code: "invalid_name",
    message: "Assistant name: 1–64 characters, no control characters or line breaks.",
  });
  await mutateSettings(options.settingsPath, (current) => ({ ...current, language: { primary: "de" } }));
  await assert.rejects(save("a\nb"), {
    code: "invalid_name",
    message: "Assistentenname: 1–64 Zeichen, ohne Steuerzeichen oder Zeilenumbrüche.",
  });
  await mutateSettings(options.settingsPath, (current) => ({ ...current, language: { primary: "ru" } }));
  await assert.rejects(save(""), { code: "invalid_name", message: /^Assistant name: / }, "unlisted → English");
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
  for (const bad of ["", "   ", "a\nb", "x".repeat(65)])
    await assert.rejects(renameAssistant(bad, { ...options, systemConsent: true }), { code: "invalid_name" }, bad);
  assert.equal(await getAssistantName(options.settingsPath), null);
  assert.equal(await getAssistantDisplayName(options.settingsPath), null);
  assert.deepEqual(await renameAssistant("Jarvis", { ...options, systemConsent: true }), { warning: undefined });
  assert.equal(admin.calls, 0);
  assert.equal(await getAssistantName(options.settingsPath), "jarvis");
  assert.equal(await getAssistantDisplayName(options.settingsPath), "Jarvis");
});

test("settings save without consent keeps the existing consent gate for a set-up address", async (t) => {
  const { options, admin } = await fixture(t);
  await renameAssistant("jarvis", { ...options, systemConsent: true });
  await assert.rejects(renameAssistant("Ruby", options), /consent|Zustimmung/i);
  await assert.rejects(renameAssistant("Ruby", options), { code: "system_consent_required" });
  assert.equal(admin.calls, 1);
  assert.equal(await getAssistantDisplayName(options.settingsPath), "jarvis");
});

test("#1556: the address outcome is decided by the error code, never by words in the message", () => {
  const coded = (code: AssistantAddressErrorCode) => new AssistantAddressError(code, "Something went wrong.");
  // The code decides even when the text carries none of the former words …
  assert.equal(needsSystemStep(coded("system_consent_required")), true);
  assert.equal(needsSystemStep(coded("partial_needs_consent")), true);
  assert.equal(needsSystemStep(coded("settings_conflict")), true);
  assert.deepEqual(addressErrorReply(coded("system_consent_required")), {
    status: 409,
    body: { error: "Something went wrong.", code: "system_consent_required" },
  });
  assert.deepEqual(addressErrorReply(coded("invalid_name")), {
    status: 400,
    body: { error: "Something went wrong.", code: "invalid_name" },
  });
  // … and those words without the code decide nothing.
  for (const text of ["consent Zustimmung Systemfreigabe", "Assistentenname: x"]) {
    assert.equal(needsSystemStep(new Error(text)), false, text);
    assert.deepEqual(addressErrorReply(new Error(text)), {
      status: 400,
      body: { error: text, code: "address_setup_failed" },
    });
  }
  // A pending operation stays a setup failure that the rename must not swallow.
  assert.equal(needsSystemStep(coded("address_pending")), false);
  assert.equal(addressErrorReply(coded("address_pending")).body.code, "address_setup_failed");
});

test("settings save: a name with special characters sets up its A-label address and keeps the spelling", async (t) => {
  const { options, admin, hostsPath } = await fixture(t);
  await renameAssistant("Jürgen", { ...options, systemConsent: true });
  assert.equal(admin.calls, 1);
  assert.equal(await getAssistantName(options.settingsPath), "xn--jrgen-kva");
  assert.equal(await getAssistantDisplayName(options.settingsPath), "Jürgen");
  assert.match(await readFile(hostsPath, "utf8"), /^127\.0\.0\.1 xn--jrgen-kva xn--jrgen-kva\.localhost$/m);
  const hosts = await readFile(hostsPath, "utf8");
  await renameAssistant("JÜRGEN", { ...options, systemConsent: true });
  assert.equal(admin.calls, 1, "same derived address: nothing is set up again");
  assert.equal(await readFile(hostsPath, "utf8"), hosts);
  assert.equal(await getAssistantDisplayName(options.settingsPath), "JÜRGEN");
});

test("settings save: a name without derivable address is kept; the set-up address stays untouched", async (t) => {
  const { options, admin, hostsPath } = await fixture(t);
  assert.deepEqual(await renameAssistant("🤖", { ...options, systemConsent: true }), { warning: undefined });
  assert.equal(admin.calls, 0, "no address, no system step");
  assert.equal(await getAssistantName(options.settingsPath), null, "still no address");
  assert.equal(await getAssistantDisplayName(options.settingsPath), "🤖");
  await renameAssistant("Jarvis", { ...options, systemConsent: true });
  assert.equal(admin.calls, 1);
  const hosts = await readFile(hostsPath, "utf8");
  for (const name of ["🤖", "!!!", "localhost", "a".repeat(64)]) {
    assert.deepEqual(await renameAssistant(name, { ...options, systemConsent: true }), { warning: undefined }, name);
    assert.equal(await getAssistantDisplayName(options.settingsPath), name);
    assert.equal(await getAssistantName(options.settingsPath), "jarvis", "the previous address still applies");
  }
  assert.equal(admin.calls, 1);
  assert.equal(await readFile(hostsPath, "utf8"), hosts);
  await assert.doesNotReject(renameAssistant("🤖", options), "without consent too: nothing to set up");
});

test("security: only the checked ASCII label reaches hosts, Firefox and the admin plan", async (t) => {
  const { options, hostsPath } = await fixture(t);
  const plans: any[] = [];
  const runAdmin = options.runAdmin;
  options.runAdmin = async (plan: any) => {
    plans.push(plan);
    await runAdmin(plan);
  };
  await mkdir(join(options.firefoxRoot, "p.default"));
  await writeFile(join(options.firefoxRoot, "profiles.ini"), "[Profile0]\nPath=p.default\nIsRelative=1\n");
  const typed = "Mein $(Jarvis) `id`; Jürgen | x & y > z";
  await renameAssistant(typed, { ...options, systemConsent: true });
  const name = await getAssistantName(options.settingsPath);
  assert.match(name ?? "", /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
  assert.equal(await getAssistantDisplayName(options.settingsPath), typed);
  const hosts = await readFile(hostsPath, "utf8");
  assert.ok(hosts.includes(`127.0.0.1 ${name} ${name}.localhost\n`));
  const userJs = await readFile(join(options.firefoxRoot, "p.default", "user.js"), "utf8");
  assert.ok(userJs.includes(`browser.fixup.domainwhitelist.${name}"`), userJs);
  // Everything that may carry the name: hosts, Firefox prefs, the admin plan (helper plists name no one).
  const helpers = plans.map((p) => `${p.helperAfter ?? ""}${p.companion?.after ?? ""}`).join("");
  assert.ok(!helpers.includes(name!) && !helpers.includes("Jarvis"), "the helper arguments do not carry the name");
  for (const text of [hosts, userJs, plans.map((p) => p.hostsAfter).join("")])
    for (const bad of ["$(", "`", "|", " & ", "ü", "Jarvis", "Mein "]) assert.ok(!text.includes(bad), bad);
  assert.ok(!hosts.includes(";"));
});
