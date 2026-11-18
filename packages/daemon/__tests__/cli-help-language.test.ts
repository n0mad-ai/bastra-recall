/**
 * #1602 — every CLI help exists in English and German and follows
 * language.primary: German for "de", English when unset or for a language
 * without its own help (English is the default, German is complete).
 *
 * The in-process part points the home directory at a fresh folder per case,
 * so the settings file read is the one written here (never the developer's).
 * One spawned run covers the real CLI path for the text that was German-only.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/cli-help-language.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HELP_LANGUAGES, commandHelp, helpText, showHelp } from "../src/cli/help-text.js";
import { settingsFilePath } from "../src/settings-file.js";
import { USAGE_WORDS, usageWords, usageWordsIn } from "../src/cli/usage-words.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(here, "..", "src", "cli.ts");
const EN = commandHelp("en");
const DE = commandHelp("de");

/** A home whose settings hold `language.primary = code` (none for null). */
async function homeWith(code: string | null): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "help-language-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  try {
    if (code) {
      const path = settingsFilePath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ language: { primary: code } }));
    }
  } finally {
    Object.assign(process.env, saved);
  }
  return home;
}

/** What showHelp prints with the home pointed at `home`. */
async function printed(home: string, command: string | null): Promise<string> {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const write = process.stdout.write;
  let out = "";
  process.env.HOME = process.env.USERPROFILE = home;
  process.stdout.write = ((chunk: string) => ((out += chunk), true)) as typeof process.stdout.write;
  try {
    await showHelp(command);
  } finally {
    process.stdout.write = write;
    Object.assign(process.env, saved);
  }
  return out;
}

test("every help section exists in English and German, each in its own text", () => {
  assert.deepEqual([...HELP_LANGUAGES].sort(), ["de", "en"]);
  assert.deepEqual(Object.keys(DE).sort(), Object.keys(EN).sort(), "the same commands in both languages");
  for (const cmd of Object.keys(EN)) {
    assert.ok(DE[cmd]?.trim(), `${cmd}: no German section`);
    assert.notEqual(DE[cmd], EN[cmd], `${cmd}: the German section is the English one`);
    assert.match(DE[cmd], new RegExp(`bastra ${cmd}\\b`), `${cmd}: German section does not name the command`);
    assert.match(DE[cmd], /Aufruf:/, `${cmd}: German section has no usage block`);
    // the English help is English throughout (the tasks section was German-only before #1602)
    assert.doesNotMatch(EN[cmd], /[äöüÄÖÜß]/, `${cmd}: English section carries German text`);
  }
  assert.notEqual(helpText(null, "de"), helpText(null, "en"), "the global listing exists in both");
  assert.doesNotMatch(helpText(null, "en"), /[äöüÄÖÜß]/, "the English listing carries German text");
});

test("language.primary=de prints every help in German; unset or another language prints English", async () => {
  const homes = {
    de: await homeWith("de"),
    unset: await homeWith(null),
    other: await homeWith("ru"),
  };
  try {
    for (const cmd of [null, ...Object.keys(EN)]) {
      const german = helpText(cmd, "de"),
        english = helpText(cmd, "en");
      assert.equal(await printed(homes.de, cmd), german, `${cmd ?? "help"}: not German with language.primary=de`);
      assert.equal(await printed(homes.unset, cmd), english, `${cmd ?? "help"}: not English without a language`);
      assert.equal(await printed(homes.other, cmd), english, `${cmd ?? "help"}: not English for 'ru'`);
    }
    assert.match(helpText("tasks", "de"), /\nMehr: bastra help\n$/);
    assert.match(helpText("tasks", "en"), /\nMore: bastra help\n$/);
  } finally {
    for (const home of Object.values(homes)) await rm(home, { recursive: true, force: true });
  }
});

test("an unreadable settings file still answers --help, in English", async () => {
  const home = await homeWith(null);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  const path = settingsFilePath();
  Object.assign(process.env, saved);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{ not json");
  const write = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write; // the corrupt-file notice
  try {
    assert.equal(await printed(home, "tasks"), helpText("tasks", "en"));
  } finally {
    process.stderr.write = write;
    await rm(home, { recursive: true, force: true });
  }
});

function runCli(args: string[], home: string): Promise<{ stdout: string; code: number }> {
  return new Promise((ok, ko) => {
    const child = spawn("npx", ["tsx", CLI_PATH, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, BASTRA_TELEMETRY: "off" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.on("error", ko);
    child.on("close", (code) => ok({ stdout, code: code ?? -1 }));
  });
}

test("the real CLI: `bastra tasks --help` follows language.primary", async () => {
  const de = await homeWith("de"),
    unset = await homeWith(null);
  try {
    const german = await runCli(["tasks", "--help"], de);
    assert.equal(german.code, 0);
    assert.equal(german.stdout, helpText("tasks", "de"));
    const english = await runCli(["tasks", "--help"], unset);
    assert.equal(english.code, 0);
    assert.equal(english.stdout, helpText("tasks", "en"));
  } finally {
    await rm(de, { recursive: true, force: true });
    await rm(unset, { recursive: true, force: true });
  }
});

test("the one-line usage errors exist in English and German and follow language.primary", async () => {
  const en = usageWordsIn("en"),
    de = usageWordsIn("de");
  assert.deepEqual(Object.keys(USAGE_WORDS).sort(), ["de", "en"]);
  assert.deepEqual(Object.keys(de), Object.keys(en));
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    assert.match(en[key], /^\s*usage: bastra /, `${key}: the English line is the usage line it always was`);
    assert.match(de[key], /^\s*Aufruf: bastra /, `${key}: no German usage line`);
    assert.notEqual(de[key], en[key], `${key}: the German line is the English one`);
  }
  assert.equal(usageWordsIn("ru"), en, "unlisted: English");
  assert.equal(usageWordsIn(undefined), en);
  const homes = { de: await homeWith("de"), unset: await homeWith(null), other: await homeWith("ru") };
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    for (const [name, home] of Object.entries(homes)) {
      process.env.HOME = process.env.USERPROFILE = home;
      assert.equal(await usageWords(), name === "de" ? de : en, name);
    }
  } finally {
    Object.assign(process.env, saved);
    for (const home of Object.values(homes)) await rm(home, { recursive: true, force: true });
  }
});
