/**
 * #1602 (part C) — the messages of `bastra embeddings`, the Ollama
 * provisioning, `bastra autostart` (with the update refresh and doctor's
 * autostart warning) exist in English and German and follow
 * language.primary: German for "de", English when unset or for a language
 * without its own words. The English lines are pinned literally — they are
 * the bytes these commands always printed.
 *
 * Each command case points the home directory at a fresh folder whose
 * settings hold the language, so the settings file read is the one written
 * here. Nothing here runs a system program or opens a connection.
 *
 * Runner: `node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/cli-messages-language-c.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { settingsFilePath } from "../src/settings-file.js";
import { EMBEDDINGS_WORDS, embeddingsWordsIn } from "../src/cli/embeddings-words.js";
import { OLLAMA_WORDS, ollamaWordsIn } from "../src/cli/ollama-words.js";
import { AUTOSTART_WORDS, autostartWordsIn } from "../src/cli/autostart-words.js";
import { cmdEmbeddings, formatEmbeddingDoctorLines } from "../src/cli/embeddings-cmd.js";
import { ensureOllama, localOllamaTarget } from "../src/cli/ollama.js";
import { autostartWarning, cmdAutostart, refreshWindowsAutostart } from "../src/cli/autostart.js";
import { installWordsIn } from "../src/cli/install-words.js";
import { doctorWordsIn } from "../src/cli/doctor-words.js";
import { panelWordsIn } from "../src/cli/panel-words.js";
import { parseArgs } from "../src/cli/commands.js";

/** Every text of a words table: functions called with sample arguments, nested tables flattened. */
function texts(words: object, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(words)) {
    const name = prefix + key;
    if (typeof value === "function")
      out.set(name, String((value as (...a: unknown[]) => unknown)("X1", "Y2", "Z3", "W4")));
    else if (value && typeof value === "object") for (const [k, v] of texts(value, `${name}.`)) out.set(k, v);
    else out.set(name, String(value));
  }
  return out;
}

const WORD_TABLES: [string, Readonly<Record<string, object>>, (language: string | undefined) => object][] = [
  ["embeddings", EMBEDDINGS_WORDS, embeddingsWordsIn],
  ["ollama", OLLAMA_WORDS, ollamaWordsIn],
  ["autostart", AUTOSTART_WORDS, autostartWordsIn],
];

test("every part-C words table has each text in English and German, and English for an unlisted language", () => {
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

test("the shared notes moved into the install, doctor and panel words keep their English bytes", () => {
  assert.equal(
    installWordsIn("en").vaultPathRequired,
    "vault path required — pass --vault <path>, set BASTRA_VAULT_PATH, or install for another surface first (vault is auto-detected from existing registrations)"
  );
  assert.match(
    installWordsIn("en").cliDeclined,
    /^No 'bastra' command was installed — this run came from the npx cache\.\n/
  );
  assert.equal(doctorWordsIn("en").driftHint, "restart your AI client to reload the daemon");
  assert.equal(panelWordsIn("en").driftHint, "restart your AI client to reload the daemon");
  for (const de of [
    installWordsIn("de").vaultPathRequired,
    installWordsIn("de").cliDeclined,
    doctorWordsIn("de").driftHint,
    panelWordsIn("de").driftHint,
  ])
    assert.match(de, /[äöüß]|Vault-Pfad|neu starten/);
});

/** A home whose settings hold `language.primary = code` (none for null). */
async function homeWith(code: string | null): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "messages-language-c-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  try {
    const path = settingsFilePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(code ? { language: { primary: code } } : {}));
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

/** stdout + stderr of `run` with the home pointed at `home` and no provider override. */
async function captured(home: string, run: (home: string) => Promise<unknown>): Promise<string> {
  const keys = ["HOME", "USERPROFILE", "BASTRA_EMBEDDING_PROVIDER"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const writes = { out: process.stdout.write, err: process.stderr.write };
  let text = "";
  const sink = ((chunk: string) => ((text += String(chunk)), true)) as typeof process.stdout.write;
  process.env.HOME = process.env.USERPROFILE = home;
  delete process.env.BASTRA_EMBEDDING_PROVIDER;
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

test("each part-C command follows language.primary; the English line is the one it always was", async () => {
  const homes = { de: await homeWith("de"), unset: await homeWith(null), other: await homeWith("ru") };
  const cases: [string, (home: string) => Promise<unknown>, string, string][] = [
    // status first: `off` below stores a provider in the same settings file
    [
      "embeddings status",
      (home) =>
        cmdEmbeddings({ sub: "status", settingsPath: settingsIn(home), probe: async () => ({ ok: false }) as never }),
      "wirksamer Anbieter: none\n  ermittelt über: Standard (nichts eingestellt)\n",
      "effective provider: none\n  resolved via: default (nothing configured)\n",
    ],
    [
      "embeddings (usage)",
      (home) => cmdEmbeddings({ sub: "bogus", settingsPath: settingsIn(home) }),
      "  off     semantische Suche ausschalten (Recall = nur Stichwortsuche BM25)\n",
      "  off     disable semantic recall (recall = BM25 keyword search only)\n",
    ],
    [
      "embeddings off",
      (home) => cmdEmbeddings({ sub: "off", settingsPath: settingsIn(home) }),
      "  semantische Suche AUS — Recall nutzt nur die Stichwortsuche (BM25). Wieder einschalten: bastra embeddings on\n",
      "  semantic recall OFF — recall is keyword-only (BM25). Re-enable: bastra embeddings on\n",
    ],
    [
      "autostart",
      () => cmdAutostart(parseArgs(["autostart", "bogus"])),
      "Fehler: unbekannter Autostart-Unterbefehl 'bogus' — möglich sind on, off oder status\n",
      "error: unknown autostart subcommand 'bogus' — use on, off or status\n",
    ],
  ];
  for (const [name, run, german, english] of cases) {
    const de = await captured(homes.de, run);
    assert.ok(de.includes(german), `${name} (de): ${JSON.stringify(de)}`);
    assert.ok(!de.includes(english), `${name} (de) still prints the English line`);
    assert.ok((await captured(homes.unset, run)).includes(english), `${name}: unset → English`);
    assert.ok((await captured(homes.other, run)).includes(english), `${name}: unlisted language → English`);
  }
});

test("Ollama provisioning, the doctor's semantic-recall block and the autostart notes print in the passed language", async () => {
  assert.equal(
    (await ensureOllama({ dryRun: true, mode: "skip", language: "de" })).message,
    ollamaWordsIn("de").skipped
  );
  assert.equal(
    (await ensureOllama({ dryRun: true, mode: "skip" })).message,
    "skipped (--no-ollama) — semantic recall uses BM25 keyword search"
  );
  const ftp = localOllamaTarget("ftp://x", ollamaWordsIn("de"));
  assert.deepEqual(ftp, { ok: false, reason: "die eingestellte Ollama-URL ist keine http(s)-URL" });

  const doctor = (words?: ReturnType<typeof embeddingsWordsIn>) =>
    formatEmbeddingDoctorLines({
      platform: "darwin",
      choice: { provider: "ollama", source: "cli-settings", requested: "ollama" } as never,
      fileProvider: "ollama",
      envValue: undefined,
      probe: { ok: true, detail: "running (1)", hasModel: false },
      words,
    });
  assert.equal(doctor()[0], "→ semantic recall");
  assert.deepEqual(doctor(embeddingsWordsIn("de")), [
    "→ semantische Suche",
    "  ⚠ eingerichtet (ollama, Quelle: cli-settings), aber das Modell embeddinggemma fehlt — Recall fällt auf BM25 zurück. Beheben: bastra embeddings on",
  ]);

  const failing = { status: async () => Promise.reject(new Error("boom")) } as never;
  const empty = await mkdtemp(join(tmpdir(), "messages-language-c-empty-"));
  assert.equal(await autostartWarning(failing, {}, empty, empty), "could not query autostart service: boom");
  assert.equal(
    await autostartWarning(failing, {}, empty, empty, autostartWordsIn("de")),
    "Autostart-Dienst ließ sich nicht abfragen: boom"
  );

  const target = { node: process.execPath, script: join(empty, "daemon.js"), version: "1" };
  await writeFile(target.script, "");
  const state = {
    exists: true,
    managed: true,
    loaded: true,
    program: [target.node, target.script],
    danglingProgram: false,
  };
  const service = { status: async () => state, install: async () => ({ ok: true, detail: "" }) } as never;
  let said = "";
  await refreshWindowsAutostart((s) => (said += s), { target, reload: true }, service, autostartWordsIn("de"));
  assert.equal(said, "  ✓ verwalteter Dienst der Aufgabenplanung mit der installierten Laufzeit neu gestartet\n");
});

test("German names the feature „Semantische Suche“ throughout, also in the uninstall note", () => {
  assert.match(installWordsIn("de").ollamaStays, /^→ semantische Suche: Ollama bleibt eingerichtet/);
  assert.match(installWordsIn("en").ollamaStays, /^→ semantic recall: Ollama stays configured/);
});
