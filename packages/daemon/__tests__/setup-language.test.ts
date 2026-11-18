/**
 * #1602 — the language of the setup: `bastra install` asks for it once
 * (English or German, preselected from the system locale) unless a language is
 * already stored, writes it only when the setup executes, and the chat delivery
 * consent is worded in it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { askSetupLanguage, saveSetupLanguage, systemLanguage } from "../src/cli/wizard-language.js";
import { finishTaskChatConsent } from "../src/cli/task-chat-setup.js";
import { taskCliWords } from "../src/cli/task-cli-words.js";
import { wizardWords, type WizardWords } from "../src/cli/wizard-words.js";
import { defaultVaultOption, memoryCountPhrase, vaultMapQuestion } from "../src/cli/wizard.js";
import { settingsFilePath } from "../src/settings-file.js";
import { getPrimaryLanguage } from "../src/settings.js";

/** Runs `fn` with the home directory at a fresh folder (settings optionally pre-written;
 *  the settings store imports that file on first read). */
async function inHome<T>(settings: object | null, fn: () => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "setup-language-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  try {
    const path = settingsFilePath();
    if (settings) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(settings));
    }
    return await fn();
  } finally {
    Object.assign(process.env, saved);
    await rm(home, { recursive: true, force: true });
  }
}

/** Every word of the wizard as text: functions are called with sample arguments. */
function wordTexts(w: WizardWords): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(w))
    out[key] = typeof value === "function" ? (value as (...a: unknown[]) => string)("X", 2) : String(value);
  return out;
}

test("the setup wizard's own words exist in English and German; German is the chosen language's", () => {
  const en = wordTexts(wizardWords("en")),
    de = wordTexts(wizardWords("de"));
  assert.deepEqual(Object.keys(de), Object.keys(en));
  for (const key of Object.keys(en)) {
    assert.ok(de[key]?.trim(), `${key}: no German text`);
    assert.notEqual(de[key], en[key], `${key}: the German text is the English one`);
    assert.doesNotMatch(en[key], /[äöüÄÖÜß]/, `${key}: English text carries German`);
  }
  assert.equal(wizardWords("ru"), wizardWords("en"), "unlisted: English");
  assert.equal(wizardWords(undefined), wizardWords("en"));
  // the exported question builders speak the language they are handed; English stays the default
  assert.equal(memoryCountPhrase(1), "1 memory");
  assert.equal(memoryCountPhrase(2, wizardWords("de")), "2 Memories");
  assert.equal(defaultVaultOption({ exists: false, memoryCount: 0 }, "~/V", wizardWords("de")).label, "~/V anlegen");
  assert.equal(vaultMapQuestion("u", true, true, wizardWords("de")).options[1]?.label, "Aus");
});

test("the preselection follows the system locale where the CLI has its texts, English otherwise", () => {
  assert.equal(systemLanguage("de-DE"), "de");
  assert.equal(systemLanguage("de-AT"), "de");
  assert.equal(systemLanguage("de_CH.UTF-8"), "de");
  assert.equal(systemLanguage("en-GB"), "en");
  assert.equal(systemLanguage("fr-FR"), "en", "no French texts yet: English");
  assert.equal(systemLanguage(""), "en");
});

test("a stored language stands: not asked, nothing written", async () => {
  await inHome({ language: { primary: "ru" } }, async () => {
    const choice = await askSetupLanguage("de-DE");
    assert.deepEqual(choice, { language: "ru", save: false });
    await saveSetupLanguage(choice as { language: string; save: boolean });
    assert.equal(await getPrimaryLanguage(), "ru", "the stored language is not overwritten");
  });
});

test("the pick is written as language.primary when the setup executes", async () => {
  await inHome(null, async () => {
    assert.equal(await getPrimaryLanguage(), undefined);
    await saveSetupLanguage({ language: "de", save: true });
    assert.equal(await getPrimaryLanguage(), "de");
  });
});

test("the chat delivery consent exists in English and German and is answered in the chosen language", async () => {
  const en = taskCliWords("en"),
    de = taskCliWords("de");
  assert.notEqual(de.chatConsentQuestion, en.chatConsentQuestion);
  for (const answer of ["accepted", "blocked", "declined"] as const) {
    assert.ok(de.chatConsentResult[answer]);
    assert.notEqual(de.chatConsentResult[answer], en.chatConsentResult[answer], answer);
  }
  assert.equal(taskCliWords("ru").chatConsentQuestion, en.chatConsentQuestion, "unlisted: English");
  const root = await mkdtemp(join(tmpdir(), "setup-language-consent-"));
  try {
    const paths = {
      settingsPath: join(root, "bastra.json"),
      userPath: join(root, "claude.json"),
      managedPath: join(root, "managed.json"),
      managedPolicyPaths: [] as string[],
    };
    assert.equal(await finishTaskChatConsent(false, paths, "de"), de.chatConsentResult.declined);
    // the answer is kept: a second run reports the same decision, worded in English this time
    assert.equal(await finishTaskChatConsent(true, paths, "en"), en.chatConsentResult.declined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
