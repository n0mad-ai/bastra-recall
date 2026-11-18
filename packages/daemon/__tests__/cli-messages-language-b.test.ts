/**
 * #1602 (part B) — the messages of `bastra code`, `patches`, `commons`,
 * `bridges`, `reconcile`, `rules`, `map`, `drafts` and `doctor --replay`
 * exist in English and German and follow language.primary: German for "de",
 * English when unset or for a language without its own words. The English
 * lines are pinned literally — they are the bytes these commands always
 * printed.
 *
 * Each case points the home directory at a fresh folder whose settings hold
 * the language, so the settings file read is the one written here.
 *
 * Runner: `node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/cli-messages-language-b.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { settingsFilePath } from "../src/settings-file.js";
import { parseArgs } from "../src/cli/commands.js";
import { CODE_CMD_WORDS, codeCmdWordsIn } from "../src/cli/code-cmd-words.js";
import { PATCHES_CMD_WORDS, patchesCmdWordsIn } from "../src/cli/patches-cmd-words.js";
import { COMMONS_WORDS, commonsWordsIn } from "../src/cli/commons-words.js";
import { BRIDGES_WORDS, bridgesWordsIn } from "../src/cli/bridges-words.js";
import { RECONCILE_CMD_WORDS, reconcileCmdWordsIn } from "../src/cli/reconcile-cmd-words.js";
import { RULES_CMD_WORDS, rulesCmdWordsIn } from "../src/cli/rules-cmd-words.js";
import { MAP_CMD_WORDS, mapCmdWordsIn } from "../src/cli/map-cmd-words.js";
import { DRAFTS_CMD_WORDS, draftsCmdWordsIn } from "../src/cli/drafts-cmd-words.js";
import { DOCTOR_REPLAY_WORDS, doctorReplayWordsIn } from "../src/cli/doctor-replay-words.js";
import { cmdCode } from "../src/cli/code-cmd.js";
import { cmdPatches } from "../src/cli/patches-cmd.js";
import { cmdCommons, commonsRepoRefusal } from "../src/cli/commons.js";
import { cmdBridges } from "../src/cli/bridges.js";
import { cmdReconcile, formatPlan } from "../src/cli/reconcile-cmd.js";
import { cmdRules } from "../src/cli/rules-cmd.js";
import { cmdMap } from "../src/cli/map-cmd.js";
import { cmdDrafts } from "../src/cli/drafts-cmd.js";
import { cmdDoctorReplay } from "../src/cli/doctor-replay.js";

/** Every text of a words table: functions called with sample arguments, nested tables flattened. */
function texts(words: object, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(words)) {
    const name = prefix + key;
    if (typeof value === "function") out.set(name, String((value as (...a: unknown[]) => unknown)("X1", "Y2")));
    else if (value && typeof value === "object") for (const [k, v] of texts(value, `${name}.`)) out.set(k, v);
    else out.set(name, String(value));
  }
  return out;
}

const WORD_TABLES: [string, Readonly<Record<string, object>>, (language: string | undefined) => object][] = [
  ["code", CODE_CMD_WORDS, codeCmdWordsIn],
  ["patches", PATCHES_CMD_WORDS, patchesCmdWordsIn],
  ["commons", COMMONS_WORDS, commonsWordsIn],
  ["bridges", BRIDGES_WORDS, bridgesWordsIn],
  ["reconcile", RECONCILE_CMD_WORDS, reconcileCmdWordsIn],
  ["rules", RULES_CMD_WORDS, rulesCmdWordsIn],
  ["map", MAP_CMD_WORDS, mapCmdWordsIn],
  ["drafts", DRAFTS_CMD_WORDS, draftsCmdWordsIn],
  ["doctor replay", DOCTOR_REPLAY_WORDS, doctorReplayWordsIn],
];

test("every part-B words table has each text in English and German, and English for an unlisted language", () => {
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
});

/** A home whose settings hold `extra` plus `language.primary = code` (none for null). */
async function homeWith(code: string | null, extra: object = {}): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "messages-language-b-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  try {
    const path = settingsFilePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ ...extra, ...(code ? { language: { primary: code } } : {}) }));
  } finally {
    Object.assign(process.env, saved);
  }
  return home;
}

/** The settings file inside `home`. */
function settingsIn(home: string): string {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  try {
    return settingsFilePath();
  } finally {
    Object.assign(process.env, saved);
  }
}

/** stdout + stderr (console included) of `run` with the home (and data paths) pointed at `home`. */
async function captured(home: string, run: (home: string) => Promise<unknown>): Promise<string> {
  const keys = ["HOME", "USERPROFILE", "BASTRA_DRAFTS_PATH", "BASTRA_BRIDGES_PATH"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const writes = { out: process.stdout.write, err: process.stderr.write };
  let text = "";
  const sink = ((chunk: string) => ((text += String(chunk)), true)) as typeof process.stdout.write;
  process.env.HOME = process.env.USERPROFILE = home;
  process.env.BASTRA_DRAFTS_PATH = join(home, "drafts.json");
  process.env.BASTRA_BRIDGES_PATH = join(home, "bridges-pool");
  process.stdout.write = sink;
  process.stderr.write = sink;
  try {
    await run(home);
  } finally {
    process.stdout.write = writes.out;
    process.stderr.write = writes.err;
    for (const k of keys)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  }
  return text;
}

test("each part-B command follows language.primary; the English line is the one it always was", async () => {
  const mapOff = { ui: { enabled: false } };
  const homes = {
    de: await homeWith("de", mapOff),
    unset: await homeWith(null, mapOff),
    other: await homeWith("ru", mapOff),
  };
  const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const missing = join(tmpdir(), "bastra-messages-b-nope-4f2a");
  const cases: [string, (home: string) => Promise<unknown>, string, string][] = [
    [
      "code",
      () => cmdCode({ sub: "bogus" }),
      "unbekannter Unterbefehl 'bogus' — möglich sind: status, enable, disable, index, rebuild\n",
      "unknown subcommand 'bogus' — try: status, enable, disable, index, rebuild\n",
    ],
    [
      "patches",
      () => cmdPatches(parseArgs(["patches", "add"])),
      "Fehler: bastra patches add <datei>\n",
      "error: bastra patches add <file>\n",
    ],
    [
      "commons",
      () => cmdCommons({ sub: "bogus" }),
      "unbekannter Commons-Unterbefehl 'bogus' — möglich sind enable|update|disable|status|verify\n",
      "unknown commons subcommand 'bogus' — use enable|update|disable|status|verify\n",
    ],
    [
      "bridges",
      () => cmdBridges({ sub: "update" }),
      "Brücken kommen mit dem Commons-Repo — 'bastra commons update' holt den neuesten Stand\n",
      "bridges sync with the Commons repo — run 'bastra commons update' to pull the latest\n",
    ],
    [
      "reconcile",
      () => cmdReconcile(parseArgs(["reconcile", tmpdir(), "--yes", "--dry-run"])),
      "bastra reconcile: --yes und --dry-run schließen sich aus\n",
      "bastra reconcile: --yes and --dry-run exclude each other\n",
    ],
    [
      "rules",
      () => cmdRules(parseArgs(["rules", "cursor", missing])),
      `Fehler: kein solcher Ordner: ${missing}\n`,
      `error: no such directory: ${missing}\n`,
    ],
    [
      "map",
      (home) => cmdMap({ settingsPath: settingsIn(home), ensureDaemon: async () => assert.fail("no daemon") }),
      "die Vault-Karte ist aus — einschalten mit: bastra config set ui.enabled true\n",
      "vault map is disabled — enable it: bastra config set ui.enabled true\n",
    ],
    ["drafts", () => cmdDrafts(parseArgs(["drafts", "list"])), "Keine lokalen Entwürfe.\n", "No local drafts.\n"],
    [
      "doctor --replay",
      () => cmdDoctorReplay(parseArgs(["doctor", "--replay", "--days", "0"])),
      "Fehler: --days braucht eine ganze Zahl von Tagen zwischen 1 und 365, erhalten: '0'\n",
      "error: --days needs a whole number of days between 1 and 365, got '0'\n",
    ],
  ];
  try {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    for (const [name, run, german, english] of cases) {
      assert.equal(await captured(homes.de, run), german, `${name}: not German with language.primary=de`);
      assert.equal(await captured(homes.unset, run), english, `${name}: not English without a language`);
      assert.equal(await captured(homes.other, run), english, `${name}: not English for 'ru'`);
    }
  } finally {
    if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    for (const home of Object.values(homes)) await rm(home, { recursive: true, force: true });
  }
});

test("the reconcile plan and the commons refusal: English by default as before, German when asked", () => {
  const plan = {
    a: { root: "/a", files: new Map([["m1", [{}]]]), unreadable: [] },
    b: { root: "/b", files: new Map(), unreadable: ["x.md"] },
    items: [{ kind: "conflict", id: "m1", reason: "duplicate-id", a: [{ rel: "m1.md" }], b: [] }],
  } as never;
  assert.equal(
    formatPlan(plan),
    [
      "this store:  /a  (1 memories)",
      "other store: /b  (0 memories)",
      "same:        0",
      "conflicts (left alone, decide by hand): 1",
      "  m1  two files with this id in one store  here:m1.md",
      "unreadable (not compared): x.md",
    ].join("\n")
  );
  assert.equal(
    formatPlan(plan, reconcileCmdWordsIn("de")),
    [
      "dieser Speicher:  /a  (1 Memories)",
      "anderer Speicher: /b  (0 Memories)",
      "gleich:           0",
      "Konflikte (unberührt, von Hand entscheiden): 1",
      "  m1  zwei Dateien mit dieser id in einem Speicher  hier:m1.md",
      "unlesbar (nicht verglichen): x.md",
    ].join("\n")
  );
  const foreign = "https://evil.example/x/y.git";
  assert.match(commonsRepoRefusal(foreign) ?? "", /^refusing commons target "evil\.example\/x\/y" — expected /);
  assert.match(commonsRepoRefusal(foreign, "de") ?? "", /^Commons-Ziel "evil\.example\/x\/y" abgelehnt/);
});
