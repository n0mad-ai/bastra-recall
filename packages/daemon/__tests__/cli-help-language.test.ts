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
import { USAGE_BLOCK_WORDS, usageBlocksIn, type UsageBlockWords } from "../src/cli/usage-block-words.js";
import { MEMORY_CMD_WORDS } from "../src/cli/memory-cmd-words.js";
import { COMPLETION_WORDS, cmdCompletion, completionWordsIn } from "../src/cli/completion.js";
import { ARCHIVE_WORDS, archiveWordsIn, cmdArchive } from "../src/cli/archive-cmd.js";
import { TRASH_WORDS, cmdTrash, trashWordsIn } from "../src/cli/trash-cmd.js";
import { SKILLS_WORDS, cmdSkills, skillsWordsIn } from "../src/cli/skills-cmd.js";
import { cmdRecall, cmdSave } from "../src/cli/memory-cmd.js";
import { cmdRules } from "../src/cli/rules-cmd.js";
import { cmdPatches } from "../src/cli/patches-cmd.js";
import { cmdOnboard } from "../src/cli/onboard-cmd.js";
import { cmdImport } from "../src/cli/import-cmd.js";
import { cmdFeedback } from "../src/cli/feedback-cmd.js";
import { cmdReconcile } from "../src/cli/reconcile-cmd.js";
import { parseArgs } from "../src/cli/commands.js";
import { printAssistantAddressNote } from "../src/cli/doctor-address-note.js";

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

function runCli(args: string[], home: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((ok, ko) => {
    const child = spawn("npx", ["tsx", CLI_PATH, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, BASTRA_TELEMETRY: "off" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", ko);
    child.on("close", (code) => ok({ stdout, stderr, code: code ?? -1 }));
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

test("the real CLI: `bastra recall --load` reports the missing ID in language.primary", async () => {
  const de = await homeWith("de");
  const unset = await homeWith(null);
  try {
    const german = await runCli(["recall", "--load", "--json"], de);
    assert.deepEqual(german, {
      code: 2,
      stdout: "",
      stderr: "Die Option '--load' braucht eine ID\nAufruf: bastra recall --load <ID> [--json]\n",
    });
    const english = await runCli(["recall", "--load="], unset);
    assert.deepEqual(english, {
      code: 2,
      stdout: "",
      stderr: "option '--load' needs a value\nusage: bastra recall --load <id> [--json]\n",
    });
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

/** Every text of a words table, functions called with sample arguments. */
function texts(words: object): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(words)) {
    if (typeof value === "function") out.set(key, String((value as (...a: unknown[]) => unknown)("X1", "Y2")));
    else out.set(key, String(value));
  }
  return out;
}

const WORD_TABLES: [string, Readonly<Record<string, object>>, (language: string | undefined) => object][] = [
  ["usage blocks", USAGE_BLOCK_WORDS, usageBlocksIn],
  ["recall/save", MEMORY_CMD_WORDS, (l) => MEMORY_CMD_WORDS[l ?? "en"] ?? MEMORY_CMD_WORDS.en],
  ["completion", COMPLETION_WORDS, completionWordsIn],
  ["archive", ARCHIVE_WORDS, archiveWordsIn],
  ["trash", TRASH_WORDS, trashWordsIn],
  ["skills", SKILLS_WORDS, skillsWordsIn],
];

test("every CLI words table has each text in English and German, and English for an unlisted language", () => {
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
  const en = texts(USAGE_BLOCK_WORDS.en),
    de = texts(USAGE_BLOCK_WORDS.de);
  for (const [key, english] of en) {
    assert.match(english, /^usage: bastra /, `${key}: the English block is the usage block it always was`);
    assert.match(de.get(key) ?? "", /^Aufruf: bastra /, `${key}: no German usage block`);
  }
});

/** stdout + stderr (console included) of `run` with the home pointed at `home`. */
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

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
type Expected = (blocks: UsageBlockWords, lines: ReturnType<typeof usageWordsIn>, language: string) => string;

test("each command's usage error follows language.primary; the English one is the line it was", async () => {
  const vault = await mkdtemp(join(tmpdir(), "usage-language-vault-"));
  const homes = { de: await homeWith("de"), unset: await homeWith(null), other: await homeWith("ru") };
  const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const repo = "https://github.com/n0mad-ai/bastra-recall";
  const cases: [string, () => Promise<unknown>, Expected, string][] = [
    [
      "archive",
      () => cmdArchive(parseArgs(["archive", "put"])),
      (b) => `${b.archive}\n`,
      "usage: bastra archive put <path>... ",
    ],
    ["trash", () => cmdTrash(parseArgs(["trash", "restore"])), (b) => `${b.trash}\n`, "usage: bastra trash list "],
    ["skills", () => cmdSkills(parseArgs(["skills", "add"])), (b) => b.skills, "usage: bastra skills list\n"],
    ["rules", () => cmdRules(parseArgs(["rules"])), (b) => b.rules, "usage: bastra rules proposals "],
    ["patches", () => cmdPatches(parseArgs(["patches", "help"])), (b) => b.patches, "usage: bastra patches [list|"],
    ["onboard", () => cmdOnboard(parseArgs(["onboard", "--vault", vault])), (b) => b.onboard, "usage: bastra onboard "],
    [
      "import vault",
      () => cmdImport(parseArgs(["import", "vault"])),
      (b) => b.importVault,
      "usage: bastra import vault <dir>",
    ],
    [
      "feedback",
      () => cmdFeedback(parseArgs(["feedback"])),
      (b) => b.feedback(repo),
      "usage: bastra feedback <bug|idea>\n",
    ],
    ["recall", () => cmdRecall(["recall"]), (_b, u) => `${u.recall}\n`, 'usage: bastra recall "<question>" '],
    [
      "completion",
      () => cmdCompletion(null),
      (_b, _u, l) => completionWordsIn(l).whichShell("bash|zsh|fish"),
      "error: which shell? usage: bastra completion <bash|zsh|fish>\n",
    ],
  ];
  try {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    for (const [name, run, expected, englishStart] of cases) {
      const german = expected(usageBlocksIn("de"), usageWordsIn("de"), "de");
      const english = expected(usageBlocksIn("en"), usageWordsIn("en"), "en");
      assert.ok(english.startsWith(englishStart), `${name}: the English line changed`);
      assert.equal(await captured(homes.de, run), german, `${name}: not German with language.primary=de`);
      assert.equal(await captured(homes.unset, run), english, `${name}: not English without a language`);
      assert.equal(await captured(homes.other, run), english, `${name}: not English for 'ru'`);
    }
    // the plain import's block shows only on a terminal
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const plainImport = () => cmdImport(parseArgs(["import", "--vault", vault]));
    assert.equal(await captured(homes.de, plainImport), usageBlocksIn("de").import);
    assert.equal(await captured(homes.unset, plainImport), usageBlocksIn("en").import);
    assert.ok(usageBlocksIn("en").import.startsWith("usage: bastra import <file|-> [chatgpt|claude|gemini|text]\n"));
    // reconcile: the reason line comes first, the usage block follows the language
    const reconcile = () => cmdReconcile(parseArgs(["reconcile", "--yes"]));
    assert.match(await captured(homes.de, reconcile), new RegExp(`\\n${escapeRe(usageBlocksIn("de").reconcile)}\\n$`));
    assert.match(
      await captured(homes.unset, reconcile),
      new RegExp(`\\n${escapeRe(usageBlocksIn("en").reconcile)}\\n$`)
    );
    assert.ok(usageBlocksIn("en").reconcile.startsWith("usage: bastra reconcile [--vault <this-store>] "));
  } finally {
    if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    for (const home of [...Object.values(homes), vault]) await rm(home, { recursive: true, force: true });
  }
});

test("recall/save, completion, archive and skills messages follow language.primary; English unchanged", async () => {
  const homes = { de: await homeWith("de"), unset: await homeWith(null) };
  const scratch = await mkdtemp(join(tmpdir(), "usage-language-skills-"));
  const savedSkills = process.env.BASTRA_SKILLS_PATH;
  process.env.BASTRA_SKILLS_PATH = join(scratch, "skills.json");
  const noDaemon = (async () => assert.fail("must not call the daemon")) as never;
  const noStdin = { stdin: async () => undefined };
  const cases: [string, () => Promise<unknown>, string, string][] = [
    [
      "recall --limit",
      () => cmdRecall(["recall", "q", "--limit", "0"], noDaemon),
      `--limit muss eine ganze Zahl von 1 bis 20 sein\n${usageWordsIn("de").recall}\n`,
      `--limit must be a whole number from 1 to 20\n${usageWordsIn("en").recall}\n`,
    ],
    [
      "recall --load mixed modes",
      () => cmdRecall(["recall", "--load", "note-id", "--type", "lesson"], noDaemon),
      `--load lässt sich nicht mit einer Suchfrage, --limit, --scope oder --type kombinieren\n${usageWordsIn("de").recallLoad}\n`,
      `--load cannot be combined with a search question, --limit, --scope or --type\n${usageWordsIn("en").recallLoad}\n`,
    ],
    [
      "recall --load missing memory",
      () =>
        cmdRecall(["recall", "--load", "missing"], async () => {
          throw new Error("memory not found: missing");
        }),
      'bastra recall: "missing" konnte nicht geladen werden (Notiz nicht gefunden)\n',
      'bastra recall: could not load "missing" (memory not found)\n',
    ],
    [
      "save required",
      () => cmdSave(["save", "--type", "lesson", "x"], noDaemon, noStdin),
      `--title, --type und --scope sind Pflicht\n${usageWordsIn("de").save}\n`,
      `--title, --type and --scope are required\n${usageWordsIn("en").save}\n`,
    ],
    [
      "recall no hits",
      () => cmdRecall(["recall", "q"], (async () => ({ hits: [] })) as never),
      "keine passenden Memories\n",
      "no matching memories\n",
    ],
    [
      "completion unknown",
      () => cmdCompletion("tcsh"),
      "Fehler: keine Vervollständigung für 'tcsh' — unterstützte Shells: bash, zsh, fish\n",
      "error: no completion for 'tcsh' — supported shells: bash, zsh, fish\n",
    ],
    [
      "skills remove",
      () => cmdSkills(parseArgs(["skills", "remove", "never-declared"])),
      "nicht deklariert: never-declared\n",
      "not declared: never-declared\n",
    ],
  ];
  try {
    for (const [name, run, german, english] of cases) {
      assert.equal(await captured(homes.de, run), german, `${name}: German`);
      assert.equal(await captured(homes.unset, run), english, `${name}: English as before`);
    }
  } finally {
    if (savedSkills === undefined) delete process.env.BASTRA_SKILLS_PATH;
    else process.env.BASTRA_SKILLS_PATH = savedSkills;
    for (const dir of [...Object.values(homes), scratch]) await rm(dir, { recursive: true, force: true });
  }
});

test("doctor's assistant address lines follow language.primary (the pending one was German-only)", async () => {
  const homes = { de: await homeWith("de"), unset: await homeWith(null) };
  const pending = async () => ({ pending: true, repair: "REPAIR" });
  const named = async () => ({
    name: "ember",
    ready: false,
    urls: { local: "http://ember.localhost" },
    registeredName: "ember",
    firefoxProfiles: 2,
    bareNameNotice: "NOTICE",
  });
  const note = (status: () => Promise<object>) => () => printAssistantAddressNote(status as never);
  try {
    assert.equal(
      await captured(homes.de, note(pending)),
      "→ Assistenten-Adresse: Systemeinrichtung ausstehend\n  REPAIR\n"
    );
    assert.equal(await captured(homes.unset, note(pending)), "→ assistant address: system setup pending\n  REPAIR\n");
    assert.equal(
      await captured(homes.de, note(named)),
      "→ Assistenten-Adresse: nicht bereit — bastra address setup ember --yes ausführen\n  http://ember.localhost\n" +
        "  hosts: aktuell; 2 Firefox-Profil(e)\n  NOTICE\n"
    );
    assert.equal(
      await captured(homes.unset, note(named)),
      "→ assistant address: not ready — run bastra address setup ember --yes\n  http://ember.localhost\n" +
        "  hosts: current; 2 Firefox profile(s)\n  NOTICE\n"
    );
  } finally {
    for (const dir of Object.values(homes)) await rm(dir, { recursive: true, force: true });
  }
});
