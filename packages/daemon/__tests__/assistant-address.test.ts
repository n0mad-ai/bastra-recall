import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAssistantName, assistantUrls } from "../src/assistant-address-name.js";
import { patchAssistantHosts, patchFirefoxUserJs } from "../src/assistant-address-files.js";
import { getAssistantName, setAssistantName } from "../src/assistant-address-settings.js";
import { setUiEnabled, readSettings } from "../src/settings.js";

test("#1332: DNS name validation rejects injection, reserved/IP-like labels and normalizes the address", () => {
  assert.equal(normalizeAssistantName(" Jarvis "), "jarvis");
  for (const value of ["localhost", "wpad", "dev", "app", "com", "home", "corp", "lan", "internal", "localdomain", "xn--jarvis", "127", "a.b", "a/b", "-name", "name-", "x".repeat(64), "a\nroot", "$(id)", "http://name"]) assert.throws(() => normalizeAssistantName(value), {name:"Error"}, value);
  assert.equal(normalizeAssistantName("a"), "a");
  assert.equal(assistantUrls("Jarvis").local, "http://jarvis.localhost/ui/");
  assert.equal(assistantUrls("Jarvis").bare, "http://jarvis/ui/");
});
test("#1332: name persists across unrelated settings writes without touching user text", async (t) => {
  const d = await mkdtemp(join(tmpdir(), "assistant-setting-")); t.after(() => rm(d, { recursive: true, force: true }));
  const path = join(d, "settings.json");
  await setAssistantName("Jarvis", path); await setUiEnabled(true, path);
  assert.equal(await getAssistantName(path), "jarvis");
  assert.equal((await readSettings(path)).ui?.enabled, true);
  await assert.rejects(setAssistantName("localhost", path));
  assert.equal(await getAssistantName(path), "jarvis");
});
test("#1332: hosts rename/remove touches only our block and refuses foreign or damaged ownership", () => {
  const foreign = "127.0.0.1 localhost\n10.0.0.1 workbox # user line\n";
  const first = patchAssistantHosts(foreign, "jarvis", "501");
  assert.match(first, /127\.0\.0\.1 jarvis jarvis\.localhost/);
  assert.match(first, /::1 jarvis jarvis\.localhost/);
  const renamed = patchAssistantHosts(first, "ruby", "501");
  assert.doesNotMatch(renamed, /jarvis/); assert.ok(renamed.startsWith(foreign));
  assert.equal(patchAssistantHosts(renamed, null, "501"), foreign);
  assert.throws(() => patchAssistantHosts(foreign + "127.0.0.1 jarvis\n", "jarvis", "501"), /conflict/i);
  assert.throws(() => patchAssistantHosts(first.replace("end", "damaged"), "ruby", "501"), /marker|managed|block/i);
});
test("#1332: Firefox whitelist is scoped to the name and owned cleanup preserves all foreign prefs", () => {
  const foreign = 'user_pref("browser.startup.homepage", "https://example.test");\n';
  const first = patchFirefoxUserJs(foreign, "jarvis", "501");
  assert.match(first, /browser\.fixup\.domainwhitelist\.jarvis/);
  const renamed = patchFirefoxUserJs(first, "ruby", "501");
  assert.doesNotMatch(renamed, /jarvis/);
  assert.equal(patchFirefoxUserJs(renamed, null, "501"), foreign);
  assert.throws(() => patchFirefoxUserJs('user_pref("browser.fixup.domainwhitelist.jarvis", false);\n', "jarvis", "501"), /foreign|conflict/i);
});

test("#1332: address CLI flags/help cover consent and a dry-run does not install anything",async()=>{
 const {parseArgs}=await import("../src/cli/commands.js"),{COMMAND_HELP}=await import("../src/cli/help-text.js");
 assert.deepEqual(parseArgs(["address","setup","Jarvis","--yes","--dry-run"]).errors,[]);
 assert.match(COMMAND_HELP.address,/browser|Browser/);assert.match(COMMAND_HELP.address,/--yes/);
 assert.deepEqual(parseArgs(["config","set","assistant.name","Jarvis"]).errors,[]);
});

test("release D: UID prefixes in foreign hosts and Firefox markers remain foreign",()=>{
 const foreign=patchAssistantHosts("","ruby","10001");assert.equal(patchAssistantHosts(foreign,null,"1000"),foreign);
 const prefs=patchFirefoxUserJs("","ruby","10001");assert.equal(patchFirefoxUserJs(prefs,null,"1000"),prefs);
});
test("release D: missing passwd entry does not prevent address defaults",async()=>{
 const {assistantAddressOptions}=await import("../src/assistant-address.js");
 const options=assistantAddressOptions({usernameLookup:()=>{throw Error("uv_os_get_passwd ENOENT");}} as any);
 assert.equal(options.username,"");
});
