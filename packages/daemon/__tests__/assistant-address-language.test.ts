/**
 * #1602 — the assistant address speaks language.primary: English by default and
 * for an unlisted language, German complete and unchanged from before #1602.
 * The language is read from the settings file the options name (never the
 * developer's); the messages are output only, no code decides on them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ADDRESS_WORDS, addressWords, type AddressWords } from "../src/assistant-address-words.js";
import { assistantAddressStatus, setupAssistantAddress } from "../src/assistant-address.js";
import { normalizeAssistantName, requireAssistantAddress } from "../src/assistant-address-name.js";
import { runMacAddressAdmin, type AddressAdminPlan } from "../src/assistant-address-admin.js";
import { setAssistantName } from "../src/assistant-address-settings.js";
import { cmdAddress } from "../src/cli/address-cmd.js";
import { unavailableAddressStatusPort } from "./assistant-address-status-fixture.js";
import { parseArgs } from "../src/cli/commands.js";

/** Every word as text: functions are called with sample arguments. */
function texts(w: AddressWords): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(w))
    out[key] = typeof value === "function" ? (value as (...a: unknown[]) => string)("X", "Y") : String(value);
  return out;
}

async function fixture(t: test.TestContext, language: string | null) {
  const root = await mkdtemp(join(tmpdir(), "address-language-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const o = {
    settingsPath: join(root, "settings"),
    hostsPath: join(root, "hosts"),
    helperPath: join(root, "helper"),
    runtimeDir: join(root, "runtime"),
    firefoxRoot: join(root, "firefox"),
    home: root,
    uid: "501",
    username: "fixture",
    platform: "darwin" as const,
    systemConsent: true,
    gatewayPort: await unavailableAddressStatusPort(t),
    ensureRuntime: async () => {},
    runAdmin: async (p: AddressAdminPlan) => {
      await p.onSettled?.(false);
      throw Error("User canceled (-128)");
    },
  };
  await writeFile(o.settingsPath, JSON.stringify(language ? { language: { primary: language } } : {}));
  await writeFile(o.hostsPath, "127.0.0.1 localhost\n");
  await setAssistantName("Jarvis", o.settingsPath);
  return o;
}

/** What `bastra address <args>` writes to stdout and stderr with these options. */
async function cli(t: test.TestContext, args: string[], o: Awaited<ReturnType<typeof fixture>>) {
  let out = "";
  t.mock.method(process.stdout, "write", (chunk: string) => ((out += chunk), true));
  t.mock.method(process.stderr, "write", (chunk: string) => ((out += chunk), true));
  const code = await cmdAddress(parseArgs(["address", ...args]), o);
  t.mock.restoreAll();
  return { code, out };
}

test("every address message exists in English and German, each in its own text", () => {
  const en = texts(addressWords("en")),
    de = texts(addressWords("de"));
  assert.deepEqual(Object.keys(ADDRESS_WORDS).sort(), ["de", "en"]);
  assert.deepEqual(Object.keys(de), Object.keys(en));
  for (const key of Object.keys(en)) {
    assert.ok(de[key]?.trim(), `${key}: no German text`);
    assert.notEqual(de[key], en[key], `${key}: the German text is the English one`);
    assert.doesNotMatch(en[key], /[äöüÄÖÜß]/, `${key}: English text carries German`);
  }
  assert.equal(addressWords("ru"), addressWords("en"), "unlisted: English");
  assert.equal(addressWords(undefined), addressWords("en"));
});

test("the name check's message follows the language it is handed, English otherwise", () => {
  const message = (language?: string) => {
    try {
      requireAssistantAddress("🤖", [], language);
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };
  assert.equal(
    message("de"),
    "Assistentenname: Aus diesem Namen lässt sich keine lokale Adresse bilden (Buchstaben oder Ziffern nötig, höchstens 63 Zeichen in Adressform, kein reservierter Name)."
  );
  assert.match(message(), /^Assistant name: no local address can be formed/);
  assert.equal(message("ru"), message());
  assert.throws(() => normalizeAssistantName("localhost", [], "de"), { message: /^Assistentenname:/ });
  assert.throws(() => normalizeAssistantName("localhost"), { message: /^Assistant name:/ });
});

test("language.primary=de keeps the German status, dry run and cancel texts unchanged", async (t) => {
  const o = await fixture(t, "de");
  const status = await cli(t, ["status"], o);
  assert.equal(status.code, 0);
  assert.ok(status.out.includes("\nAdresse noch nicht eingerichtet oder Dienst nicht erreichbar\n"), status.out);
  assert.ok(
    status.out.includes(
      "Einzelne Wörter können je nach Browser als Suche gelten. Adresse einmal öffnen; Firefox nach Einrichtung neu starten. <name>/ oder <name>.localhost bleibt die eindeutige Eingabe."
    )
  );
  const dry = await cli(t, ["setup", "--dry-run"], o);
  assert.equal(
    dry.out,
    "Würde lokale Adresse einrichten: gespeicherter Name. hosts und eigener Socket-Helfer brauchen Systemfreigabe; nur eigene Firefox-Prefs werden verändert.\n"
  );
  const cancel = await cli(t, ["setup", "--yes"], o);
  assert.equal(cancel.code, 1);
  assert.equal(cancel.out, "Systemeinrichtung abgebrochen, nichts geändert.\n");
  assert.equal(
    (await assistantAddressStatus(o)).bareNameNotice,
    "Einzelne Wörter können je nach Browser als Suche gelten. Adresse einmal öffnen; Firefox nach Einrichtung neu starten. <name>/ oder <name>.localhost bleibt die eindeutige Eingabe."
  );
});

test("unset or unlisted language.primary answers in English", async (t) => {
  for (const language of [null, "ru"]) {
    const o = await fixture(t, language);
    const status = await cli(t, ["status"], o);
    assert.ok(status.out.includes("\nAddress not set up yet or service not reachable\n"), `${language}: ${status.out}`);
    const dry = await cli(t, ["remove", "--dry-run"], o);
    assert.match(dry.out, /^Would remove the local address: saved name\./);
    await assert.rejects(setupAssistantAddress(o), { message: "System setup cancelled; nothing changed." });
  }
});

test("the macOS admin dialog and its result follow the language handed with the plan", async () => {
  const plan: AddressAdminPlan = {
    hostsPath: "fixture",
    hostsBefore: "",
    hostsAfter: "",
    helperPath: "fixture",
    helperBefore: null,
    helperAfter: null,
    label: "fixture",
  };
  const run = async (language?: string) => {
    let prompt = "";
    const spawn = (_command: string, args: readonly string[]) => {
      prompt = args[1] ?? "";
      const child = Object.assign(new EventEmitter(), { pid: 0, stdout: null, stderr: new EventEmitter() });
      setImmediate(() => {
        child.stderr.emit("data", "execution error: User canceled. (-128)");
        child.emit("exit", 1);
      });
      return child as unknown as ChildProcess;
    };
    const error = await runMacAddressAdmin({ ...plan, language }, { spawn }).then(
      () => null,
      (e: Error) => e.message
    );
    return { prompt, error };
  };
  const de = await run("de"),
    en = await run();
  assert.match(de.prompt, /with prompt "Bastra: lokalen Assistentennamen und Port 80 einrichten"$/);
  assert.equal(de.error, "Systemeinrichtung abgebrochen, nichts geändert.");
  assert.match(en.prompt, /with prompt "Bastra: set up the local assistant name and port 80"$/);
  assert.equal(en.error, "System setup cancelled; nothing changed.");
});
