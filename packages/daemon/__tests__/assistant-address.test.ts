import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeAssistantName,
  assistantUrls,
  deriveAssistantAddress,
  readableAssistantName,
  normalizeAssistantDisplayName,
} from "../src/assistant-address-name.js";
import { patchAssistantHosts, patchFirefoxUserJs } from "../src/assistant-address-files.js";
import { getAssistantName, setAssistantName } from "../src/assistant-address-settings.js";
import { setUiEnabled, readSettings } from "../src/settings.js";

test("#1332: DNS name validation rejects injection, reserved/IP-like labels and normalizes the address", () => {
  assert.equal(normalizeAssistantName(" Jarvis "), "jarvis");
  for (const value of [
    "localhost",
    "wpad",
    "dev",
    "app",
    "com",
    "home",
    "corp",
    "lan",
    "internal",
    "localdomain",
    "xn--jarvis",
    "127",
    "a.b",
    "a/b",
    "-name",
    "name-",
    "x".repeat(64),
    "a\nroot",
    "$(id)",
    "http://name",
  ])
    assert.throws(() => normalizeAssistantName(value), { name: "Error" }, value);
  assert.equal(normalizeAssistantName("a"), "a");
  assert.equal(assistantUrls("Jarvis").local, "http://jarvis.localhost/ui/");
  assert.equal(assistantUrls("Jarvis").bare, "http://jarvis/ui/");
});
test("#1555: IDN top-level domains in the blocklist stay whole, also where the snapshot used to wrap them", () => {
  // `xn--3ds443g` (在线) and `xn--80adxhks` (москва) were split across lines in
  // the snapshot and so slipped past the lookup.
  for (const [label, unicode] of [
    ["xn--3ds443g", "在线"],
    ["xn--80adxhks", "москва"],
    ["xn--p1ai", "рф"],
  ]) {
    assert.throws(() => normalizeAssistantName(label), { name: "Error" }, label);
    assert.equal(deriveAssistantAddress(unicode), null, unicode);
    // The display name itself stays allowed; only the address is unavailable.
    assert.equal(normalizeAssistantDisplayName(unicode), unicode);
  }
});
test("address derivation: any language yields an IDNA A-label or no address, never an unsafe label", () => {
  const cases: Array<[string, string | null]> = [
    ["Jarvis", "jarvis"],
    [" JARVIS ", "jarvis"],
    ["Jürgen", "xn--jrgen-kva"],
    ["Mein Jarvis", "mein-jarvis"],
    ["José  María!", "xn--jos-mara-d1a8b"],
    ["Ñandú", "xn--and-6ma2c"],
    ["Straße", "xn--strae-oqa"], // UTS #46 nontransitional: ß stays ß
    ["İsmail", "xn--ismail-pyd"], // Unicode case mapping, no Turkish table
    ["ısık", "xn--sk-gpab"],
    ["東京", "xn--1lqs71d"],
    ["محمد", "xn--sgbe8db"], // right-to-left
    ["שלום", "xn--9dbne9b"],
    ["नमस्ते", "xn--h2bhs4b8d8a"],
    ["abcمحمد", null], // mixed directions fail the IDNA bidi rule
    ["🤖", null],
    ["🤖 Jarvis", "jarvis"],
    ["!!!", null],
    ["   ", null],
    ["a.b", "a-b"],
    ["abc--d", "abc--d"], // typed hyphens stay as typed
    ["ab--cd", null], // hyphens in positions 3 and 4 are reserved for A-labels (RFC 5890 §2.3.1)
    ["xn--jrgen-kva", "xn--jrgen-kva"], // an A-label is already its own address
    ["XN--JRGEN-KVA", "xn--jrgen-kva"],
    ["xn--abc", null], // not a valid A-label
    ["xn--jarvis", null],
    ["a".repeat(63), "a".repeat(63)],
    ["a".repeat(64), null],
    ["ü".repeat(60), null], // the A-label would exceed 63 characters
    ["localhost", null],
    ["Com", null], // TLD
    ["123", null],
    ["$(id); rm", "id-rm"],
    ["a\nroot", "a-root"],
  ];
  for (const [input, expected] of cases) {
    const address = deriveAssistantAddress(input);
    assert.equal(address, expected, input);
    if (address !== null) {
      assert.match(address, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, `only a checked ASCII label: ${input}`);
      assert.equal(normalizeAssistantName(address), address, "strict check accepts its own result");
      assert.equal(deriveAssistantAddress(address), address, "derivation is stable");
    }
  }
  assert.equal(deriveAssistantAddress("Jarvis", ["Jarvis.local"]), null, "the machine's own host name stays reserved");
  assert.equal(readableAssistantName("xn--jrgen-kva"), "jürgen");
  assert.equal(readableAssistantName("jarvis"), "jarvis");
  assert.equal(assistantUrls("xn--jrgen-kva").bare, "http://xn--jrgen-kva/ui/");
  assert.throws(() => assistantUrls("Jürgen"), /Assistentenname/, "URLs only from a checked address name");
});
test("A-labels: only a lossless round trip counts, whatever this Node version's domainToASCII does", () => {
  // Node 22 maps invalid xn-- labels to "", Node 24.22+/26 (Ada 4) return them unchanged; the result must not differ.
  for (const label of ["xn--mnchen-3ya", "xn--jrgen-kva", "xn--zca", "xn--1lqs71d"])
    assert.equal(normalizeAssistantName(label), label, label);
  for (const label of [
    "xn--abc", // undecodable
    "xn--jarvis",
    "xn--a",
    "xn--ab--cd",
    "xn--abc-", // decodes to the ASCII label "abc"
    "ab--cd", // reserved hyphens without the A-label prefix
    "zz--top",
  ]) {
    assert.throws(() => normalizeAssistantName(label), { name: "Error" }, label);
    assert.equal(deriveAssistantAddress(label), null, label);
  }
  // Decodes on Node 22 to "mnchen-3ya", never back to itself; derivation trims the hyphen first.
  assert.throws(() => normalizeAssistantName("xn--mnchen-3ya-"), { name: "Error" });
  assert.equal(deriveAssistantAddress("xn--mnchen-3ya-"), "xn--mnchen-3ya");
});

test("display name: free spelling in any script, only technical limits", () => {
  assert.equal(normalizeAssistantDisplayName("  Mein Jarvis "), "Mein Jarvis");
  assert.equal(normalizeAssistantDisplayName("Ju\u0308rgen"), "Jürgen", "NFC");
  for (const ok of ["Jürgen", "🤖", "محمد", "東京", "x".repeat(64), "👨‍👩‍👧‍👦".repeat(9)])
    assert.equal(normalizeAssistantDisplayName(ok), ok, ok);
  for (const bad of ["", "   ", "x".repeat(65), "a\nb", "a\rb", "a\tb", "a\u0007b", "a\u2028b", "a\ud800b"])
    assert.throws(() => normalizeAssistantDisplayName(bad), /Assistentenname/, JSON.stringify(bad));
});

test("#1332: name persists across unrelated settings writes without touching user text", async (t) => {
  const d = await mkdtemp(join(tmpdir(), "assistant-setting-"));
  t.after(() => rm(d, { recursive: true, force: true }));
  const path = join(d, "settings.json");
  await setAssistantName("Jarvis", path);
  await setUiEnabled(true, path);
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
  assert.doesNotMatch(renamed, /jarvis/);
  assert.ok(renamed.startsWith(foreign));
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
  assert.throws(
    () => patchFirefoxUserJs('user_pref("browser.fixup.domainwhitelist.jarvis", false);\n', "jarvis", "501"),
    /foreign|conflict/i
  );
});

test("#1332: address CLI flags/help cover consent and a dry-run does not install anything", async () => {
  const { parseArgs } = await import("../src/cli/commands.js"),
    { COMMAND_HELP } = await import("../src/cli/help-text.js");
  assert.deepEqual(parseArgs(["address", "setup", "Jarvis", "--yes", "--dry-run"]).errors, []);
  assert.match(COMMAND_HELP.address, /browser|Browser/);
  assert.match(COMMAND_HELP.address, /--yes/);
  assert.deepEqual(parseArgs(["config", "set", "assistant.name", "Jarvis"]).errors, []);
});

test("address CLI: setup takes names with special characters through the same derivation", async () => {
  const { parseArgs } = await import("../src/cli/commands.js"),
    { cmdAddress } = await import("../src/cli/address-cmd.js");
  const run = async (name: string) => {
    let out = "";
    const write = process.stdout.write,
      error = process.stderr.write;
    process.stdout.write = ((chunk: string) => ((out += chunk), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => ((out += chunk), true)) as typeof process.stderr.write;
    try {
      return { code: await cmdAddress(parseArgs(["address", "setup", name, "--dry-run"])), out };
    } finally {
      process.stdout.write = write;
      process.stderr.write = error;
    }
  };
  const idn = await run("Jürgen");
  assert.equal(idn.code, 0);
  assert.match(idn.out, /http:\/\/xn--jrgen-kva\.localhost\/ui\//);
  const none = await run("🤖");
  assert.equal(none.code, 1, "setup needs an address");
  assert.match(none.out, /keine lokale Adresse bilden/);
});

test("release D: UID prefixes in foreign hosts and Firefox markers remain foreign", () => {
  const foreign = patchAssistantHosts("", "ruby", "10001");
  assert.equal(patchAssistantHosts(foreign, null, "1000"), foreign);
  const prefs = patchFirefoxUserJs("", "ruby", "10001");
  assert.equal(patchFirefoxUserJs(prefs, null, "1000"), prefs);
});
test("release D: missing passwd entry does not prevent address defaults", async () => {
  const { assistantAddressOptions } = await import("../src/assistant-address.js");
  const options = assistantAddressOptions({
    usernameLookup: () => {
      throw Error("uv_os_get_passwd ENOENT");
    },
  } as any);
  assert.equal(options.username, "");
});

test("dual helper: next setup restores both loopback aliases and accepts legacy IPv4 blocks", async () => {
  const { managedAssistantHostsName } = await import("../src/assistant-address-files.js");
  const legacy =
      "# bastra-recall assistant-address 501 begin\n127.0.0.1 jarvis jarvis.localhost\n::1 jarvis jarvis.localhost\n# bastra-recall assistant-address 501 end\n",
    foreign = "10.0.0.3 foreign\n";
  assert.equal(managedAssistantHostsName(foreign + legacy, "501"), "jarvis");
  const updated = patchAssistantHosts(foreign + legacy.replace("::1 jarvis jarvis.localhost\n", ""), "jarvis", "501");
  assert.match(updated, /::1 jarvis/);
  assert.equal(managedAssistantHostsName(updated, "501"), "jarvis");
  assert.equal(patchAssistantHosts(updated, null, "501"), foreign);
  assert.throws(() => managedAssistantHostsName(legacy.replace("::1 jarvis", "::1 foreign"), "501"), /modified/);
});
