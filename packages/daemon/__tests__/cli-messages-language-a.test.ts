/**
 * #1602 (part A) — the messages of install, uninstall, doctor, update and the
 * smaller setup commands follow language.primary: German for "de", English
 * when unset or for a language without its own table. English is the text the
 * commands always printed (the characterization tests pin it byte for byte).
 *
 * Each case points the home directory at a fresh folder whose settings hold
 * the language, so the settings read are the ones written here.
 *
 * Runner: `node --import tsx --test packages/daemon/__tests__/cli-messages-language-a.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { settingsFilePath } from "../src/settings-file.js";
import { cmdDoctor, cmdInstall, cmdUninstall, parseArgs } from "../src/cli/commands.js";
import { cmdUpdate } from "../src/cli/update.js";
import { INSTALL_WORDS, installWordsIn } from "../src/cli/install-words.js";
import { DOCTOR_WORDS, doctorWordsIn } from "../src/cli/doctor-words.js";
import { UPDATE_WORDS, updateWordsIn } from "../src/cli/update-words.js";
import { cmdConfig } from "../src/cli/config-cmd.js";
import { CONFIG_WORDS, configWordsIn } from "../src/cli/config-words.js";
import { cmdImport } from "../src/cli/import-cmd.js";
import { IMPORT_WORDS, importWordsIn } from "../src/cli/import-words.js";
import { cmdOnboard } from "../src/cli/onboard-cmd.js";
import { ONBOARD_WORDS, onboardWordsIn } from "../src/cli/onboard-words.js";
import { QUESTIONS } from "../src/onboarding.js";
import { ONBOARDING_WORDS } from "../src/onboarding-words.js";
import { cmdToken } from "../src/cli/token.js";
import { TOKEN_WORDS, tokenWordsIn } from "../src/cli/token-words.js";
import { cmdOAuth } from "../src/cli/oauth-cmd.js";
import { OAUTH_WORDS, oauthWordsIn } from "../src/cli/oauth-words.js";
import { EXTENSION_WORDS, extensionWordsIn } from "../src/cli/extension-words.js";
import { cmdPanel } from "../src/cli/panel.js";
import { PANEL_WORDS, panelWordsIn } from "../src/cli/panel-words.js";
import { platform } from "node:os";

/** Sample arguments where "X1"/"Y2" would not tell the languages apart. */
const SAMPLES: Record<string, unknown[]> = {
  status: ["installed"],
  modeDetail: ["brew", "installed via Homebrew", null],
  persona: ["developer", "Code & projects — I build software"],
  ask: [QUESTIONS[0]],
  hint: [QUESTIONS[0]],
};

/** Every text of a words table, functions called with sample arguments; arrays joined. */
function texts(words: object): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(words)) {
    const text =
      typeof value === "function"
        ? (value as (...a: unknown[]) => unknown)(...(SAMPLES[key] ?? ["X1", "Y2", 3]))
        : value;
    // A label table (object) compares by its contents.
    const flat = Array.isArray(text) ? text.join("") : typeof text === "object" ? JSON.stringify(text) : String(text);
    out.set(key, flat);
  }
  return out;
}

const WORD_TABLES: [string, Readonly<Record<string, object>>, (language: string | undefined) => object][] = [
  ["install", INSTALL_WORDS, installWordsIn],
  ["doctor", DOCTOR_WORDS, (l) => DOCTOR_WORDS[l ?? "en"] ?? DOCTOR_WORDS.en],
  ["update", UPDATE_WORDS, updateWordsIn],
  ["config", CONFIG_WORDS, configWordsIn],
  ["import", IMPORT_WORDS, importWordsIn],
  ["onboard", ONBOARD_WORDS, onboardWordsIn],
  ["token", TOKEN_WORDS, tokenWordsIn],
  ["oauth", OAUTH_WORDS, oauthWordsIn],
  ["extension", EXTENSION_WORDS, extensionWordsIn],
  ["panel", PANEL_WORDS, panelWordsIn],
];

test("every words table has each text in English and German, and English for an unlisted language", () => {
  for (const [name, table, pick] of WORD_TABLES) {
    assert.deepEqual(Object.keys(table).sort(), ["de", "en"], `${name}: languages`);
    const en = texts(table.en),
      de = texts(table.de);
    assert.deepEqual([...de.keys()], [...en.keys()], `${name}: the same texts in both languages`);
    for (const [key, english] of en) {
      assert.ok(english.trim(), `${name}.${key}: no English text`);
      assert.ok(de.get(key)?.trim(), `${name}.${key}: no German text`);
      assert.notEqual(de.get(key), english, `${name}.${key}: the German text is the English one`);
      assert.doesNotMatch(english, /[äöüÄÖÜß]/, `${name}.${key}: the English text carries German`);
    }
    assert.equal(pick("ru"), table.en, `${name}: unlisted language → English`);
    assert.equal(pick(undefined), table.en, `${name}: unset → English`);
    assert.equal(pick("de"), table.de, `${name}: German`);
  }
  // Every question of the catalog has its German text; English is the catalog's own.
  const en = onboardWordsIn("en"),
    de = onboardWordsIn("de");
  for (const q of QUESTIONS) {
    assert.ok(ONBOARDING_WORDS.de.questions[q.id], `onboard: no German text for question '${q.id}'`);
    assert.equal(en.ask(q), q.ask);
    assert.equal(en.hint(q), q.hint);
    assert.notEqual(de.ask(q), q.ask, `onboard: '${q.id}' asks in English`);
    assert.notEqual(de.hint(q), q.hint, `onboard: '${q.id}' hints in English`);
  }
  // doctor carries the install lines it shares.
  assert.equal(doctorWordsIn("de").config, INSTALL_WORDS.de.config);
  assert.equal(doctorWordsIn("ru").fix, DOCTOR_WORDS.en.fix);
});

/** A home whose settings hold `language.primary = code` (none for null). */
async function homeWith(code: string | null): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "messages-language-a-"));
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

/** stdout + stderr of `run` with the home pointed at `home`. */
async function captured(home: string, run: () => Promise<unknown>): Promise<string> {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const writes = { out: process.stdout.write, err: process.stderr.write };
  let text = "";
  const sink = ((chunk: string) => ((text += String(chunk)), true)) as typeof process.stdout.write;
  process.env.HOME = process.env.USERPROFILE = home;
  process.stdout.write = sink;
  process.stderr.write = sink;
  try {
    await run();
  } finally {
    process.stdout.write = writes.out;
    process.stderr.write = writes.err;
    Object.assign(process.env, saved);
  }
  return text;
}

const NPM_CLI = "/usr/local/lib/node_modules/@bastra-recall/daemon/dist/cli/update.js";

/** [command, run, German fragment, English fragment] — each run once per language. */
const RUNS: [string, () => Promise<unknown>, string, string][] = [
  [
    "install --extension",
    () => cmdInstall(parseArgs(["install", "codex", "--extension"])),
    INSTALL_WORDS.de.extensionOnlyDesktop,
    INSTALL_WORDS.en.extensionOnlyDesktop,
  ],
  ["install <unknown>", () => cmdInstall(parseArgs(["install", "nowhere-1602", "--yes"])), "Fehler: ", "error: "],
  ["uninstall <unknown>", () => cmdUninstall(parseArgs(["uninstall", "nowhere-1602"])), "Fehler: ", "error: "],
  ["doctor <unknown>", () => cmdDoctor(parseArgs(["doctor", "nowhere-1602"])), "Fehler: ", "error: "],
  [
    "update --dry-run",
    () => cmdUpdate(parseArgs(["update", "--dry-run"]), { cliPath: NPM_CLI }),
    "→ Installationsart: über npm installiert (global)\n",
    "→ install mode: installed via npm (global)\n",
  ],
  [
    "config get <unknown>",
    () => cmdConfig(parseArgs(["config", "get", "nowhere.key"])),
    CONFIG_WORDS.de.unknownKey("nowhere.key"),
    CONFIG_WORDS.en.unknownKey("nowhere.key"),
  ],
  [
    "import <file> <unknown source>",
    () => inVault((vault) => cmdImport(parseArgs(["import", "notes.txt", "nowhere-src", "--vault", vault]))),
    "Fehler: unbekannte Quelle 'nowhere-src'",
    "error: unknown source 'nowhere-src'",
  ],
  [
    "onboard --answers <missing>",
    () =>
      inVault((vault) =>
        cmdOnboard(parseArgs(["onboard", "--vault", vault, "--answers", join(vault, "missing.json")]))
      ),
    "lässt sich nicht lesen",
    "cannot read answers file",
  ],
  [
    "token <unknown>",
    () => cmdToken({ sub: "nowhere", json: false }),
    TOKEN_WORDS.de.unknownSub("nowhere"),
    TOKEN_WORDS.en.unknownSub("nowhere"),
  ],
  [
    "oauth <unknown>",
    () => cmdOAuth({ sub: "nowhere", positional: [], json: false }),
    OAUTH_WORDS.de.unknownSub("nowhere"),
    OAUTH_WORDS.en.unknownSub("nowhere"),
  ],
  platform() === "darwin"
    ? [
        "install claude-desktop --extension --dry-run",
        () => cmdInstall(parseArgs(["install", "claude-desktop", "--extension", "--dry-run"])),
        "(Probelauf)\n",
        "(dry-run)\n",
      ]
    : [
        "install claude-desktop --extension",
        () => cmdInstall(parseArgs(["install", "claude-desktop", "--extension"])),
        EXTENSION_WORDS.de.macOnly,
        EXTENSION_WORDS.en.macOnly,
      ],
  [
    "bastra (panel)",
    () => withoutDaemon(() => cmdPanel(parseArgs([]))),
    PANEL_WORDS.de.notRunning,
    PANEL_WORDS.en.notRunning,
  ],
];

/** `run` against a fresh, empty vault folder. */
async function inVault(run: (vault: string) => Promise<unknown>): Promise<unknown> {
  const vault = await mkdtemp(join(tmpdir(), "messages-language-a-vault-"));
  try {
    return await run(vault);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
}

/** `run` with the daemon URL on a closed loopback port: never the live daemon. */
async function withoutDaemon(run: () => Promise<unknown>): Promise<unknown> {
  const saved = process.env.BASTRA_DAEMON_URL;
  process.env.BASTRA_DAEMON_URL = "http://127.0.0.1:9";
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.BASTRA_DAEMON_URL;
    else process.env.BASTRA_DAEMON_URL = saved;
  }
}

test("each command speaks language.primary; English when unset or unlisted", async () => {
  const homes = { de: await homeWith("de"), unset: await homeWith(null), other: await homeWith("ru") };
  try {
    for (const [name, run, german, english] of RUNS) {
      const de = await captured(homes.de, run);
      assert.ok(de.includes(german), `${name}: German expected, got ${JSON.stringify(de)}`);
      assert.ok(!de.includes(english), `${name}: no English line in the German run`);
      for (const home of [homes.unset, homes.other]) {
        const en = await captured(home, run);
        assert.ok(en.includes(english), `${name}: English expected, got ${JSON.stringify(en)}`);
        assert.ok(!en.includes(german), `${name}: no German line in the English run`);
      }
    }
    const plan = await captured(homes.de, () => cmdUpdate(parseArgs(["update", "--dry-run"]), { cliPath: NPM_CLI }));
    assert.ok(plan.includes(UPDATE_WORDS.de.planRegister), "update: the German plan");
  } finally {
    for (const home of Object.values(homes)) await rm(home, { recursive: true, force: true });
  }
});
