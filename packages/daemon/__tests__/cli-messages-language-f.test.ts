/**
 * #1602 (part F) — the remaining single screen lines follow language.primary:
 * `bastra status` (labels, API token, vault map, semantic recall, further
 * daemons), `bastra logs` around the log lines, doctor's daemon-origin note
 * and stale-code line, `bastra codex` without Codex, `bastra feedback`, and
 * the error prefixes of recall, save, archive, trash and rules proposals.
 * German for "de", English when unset or for a language without its own
 * words; the English bytes are the ones these always printed.
 *
 * Not here, on purpose: `--json` values (status keeps English), the adapters'
 * messages, the daemon probe's detail, the local-patches line, the diagnostics
 * block of `bastra feedback` (it goes into the GitHub issue) and the
 * daemon's own stale-code log line.
 *
 * Nothing here depends on this machine: Ollama, the adapters and the daemon
 * are stand-ins; the only server is a loopback one on an ephemeral port. The
 * `bastra logs` usage errors run the built CLI (dist/cli.js) with its own HOME.
 *
 * Runner: `node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/cli-messages-language-f.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STATUS_WORDS, statusWordsIn } from "../src/cli/status-words.js";
import { DAEMON_ORIGIN_WORDS, daemonOriginWordsIn } from "../src/cli/daemon-origin-words.js";
import { LOGS_WORDS, logsWordsIn, cmdLogs } from "../src/cli/logs.js";
import { FEEDBACK_WORDS, feedbackWordsIn } from "../src/cli/feedback-cmd.js";
import { CODEX_CHAT_WORDS, codexChatWordsIn, cmdCodexChat } from "../src/cli/codex-chat.js";
import { STALE_WORDS, staleWordsIn, describeStale } from "../src/code-staleness.js";
import { TRASH_WORDS, trashWordsIn, cmdTrash } from "../src/cli/trash-cmd.js";
import { ARCHIVE_WORDS, archiveWordsIn } from "../src/cli/archive-cmd.js";
import { RULES_CMD_WORDS, rulesCmdWordsIn } from "../src/cli/rules-cmd-words.js";
import { MEMORY_CMD_WORDS } from "../src/cli/memory-cmd-words.js";
import { formatSemanticRecall, formatVaultMapLine } from "../src/cli/status.js";
import { formatExtraDaemons, type DaemonProcess } from "../src/cli/daemon-processes.js";
import { configuredState, daemonOriginLines } from "../src/cli/daemon-origin-note.js";
import { cmdRecall, cmdSave } from "../src/cli/memory-cmd.js";
import { cmdRules } from "../src/cli/rules-cmd.js";
import { parseArgs } from "../src/cli/commands.js";
import type { DaemonProbe } from "../src/cli/helpers.js";
import type { CodeStale } from "../src/code-staleness.js";
import { settingsFilePath } from "../src/settings.js";

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
  ["status", STATUS_WORDS, statusWordsIn],
  ["daemon origin", DAEMON_ORIGIN_WORDS, daemonOriginWordsIn],
  ["logs", LOGS_WORDS, logsWordsIn],
  ["feedback", FEEDBACK_WORDS, feedbackWordsIn],
  ["codex", CODEX_CHAT_WORDS, codexChatWordsIn],
  ["stale code", STALE_WORDS, staleWordsIn],
  ["trash", TRASH_WORDS, trashWordsIn],
  ["archive", ARCHIVE_WORDS, archiveWordsIn],
  ["rules", RULES_CMD_WORDS, rulesCmdWordsIn],
];
/** Texts that read the same in both languages by design. */
const SAME_IN_BOTH = new Set(["daemon origin: source"]);

test("every part-F words table has each text in English and German, and English for an unlisted language", () => {
  for (const [name, table, pick] of WORD_TABLES) {
    assert.deepEqual(Object.keys(table).sort(), ["de", "en"], `${name}: languages`);
    const en = texts(table.en),
      de = texts(table.de);
    assert.deepEqual([...de.keys()], [...en.keys()], `${name}: the same texts in both languages`);
    for (const [key, english] of en) {
      assert.ok(english.trim(), `${name}.${key}: no English text`);
      assert.ok(de.get(key)?.trim(), `${name}.${key}: no German text`);
      if (!SAME_IN_BOTH.has(`${name}: ${key}`))
        assert.notEqual(de.get(key), english, `${name}.${key}: the German text is the English one`);
      assert.doesNotMatch(english, /[äöüÄÖÜß]/, `${name}.${key}: the English text carries German`);
    }
    assert.equal(pick("ru"), table.en, `${name}: unlisted language → English`);
    assert.equal(pick(undefined), table.en, `${name}: unset → English`);
    assert.equal(pick("de"), table.de, `${name}: German`);
  }
  const memory = MEMORY_CMD_WORDS;
  assert.equal(memory.en.recallFailed("boom"), "bastra recall: boom");
  assert.equal(memory.en.saveFailed("boom"), "bastra save: boom");
  assert.equal(memory.de.recallFailed("boom"), "bastra recall: Fehler: boom");
  assert.equal(memory.de.saveFailed("boom"), "bastra save: Fehler: boom");
});

test("the English texts are the bytes these lines always printed", () => {
  const en = { ...FEEDBACK_WORDS.en, ...LOGS_WORDS.en };
  assert.equal(en.openingIdea, "opening feature-request form…\n");
  assert.equal(
    en.bugIntro,
    "This diagnostics block is prefilled into the report — and nothing else\n" +
      "(no vault content, no paths). Edit or remove it in the form as you like:\n\n"
  );
  assert.equal(en.openingBug, "\n\nopening bug-report form…\n");
  assert.equal(en.hidden(3), "… 3 earlier line(s) hidden — raise with --lines");
  assert.equal(en.following, "— following (ctrl-c to stop) —");
  assert.equal(ARCHIVE_WORDS.en.restoreFailed("gone"), "bastra archive restore: gone");
  assert.equal(TRASH_WORDS.en.failed("list", "gone"), "bastra trash list: gone");
  const status = STATUS_WORDS.en;
  assert.equal(status.tokenSet, "✓ set (browser/REST enabled)");
  assert.equal(status.tokenUnset, "· not set (loopback only)");
  assert.equal(status.failedToCheck("x"), "failed to check: x");
  assert.deepEqual(
    Object.values(status.label).map((l) => l.padEnd(15)),
    ["daemon         ", "daemons        ", "semantic recall", "api token      ", "local patches  ", "vault map      "]
  );
  const s: CodeStale = { running: "1.0.0", on_disk: "1.1.0", built_at: "T", reason: "rebuilt" };
  assert.equal(
    describeStale(s),
    "code on disk was replaced after this process started (running 1.0.0, on disk 1.1.0, built T) — restart the daemon to run it"
  );
  assert.equal(
    describeStale({ ...s, reason: "not-built" }),
    "package.json says 1.1.0, this process runs 1.0.0, and the build has not moved (built T) — run 'npm run build', then restart the daemon"
  );
  assert.match(describeStale(s, "de"), /^der Code auf der Platte wurde nach dem Start dieses Prozesses ersetzt/);
  assert.equal(describeStale(s, "ru"), describeStale(s));
});

const UP = (over: Partial<DaemonProbe>): DaemonProbe => ({ ok: true, detail: "", ...over });

test("status: semantic recall, vault map and further daemons in the run's language; English unchanged", () => {
  const ready = { ok: true, detail: "", hasModel: true };
  const noModel = { ok: true, detail: "", hasModel: false };
  const down = { ok: false, detail: "D", hasModel: false };
  const cases: [Parameters<typeof formatSemanticRecall>, string][] = [
    [["ollama", { ok: false, detail: "" }, ready], "· daemon not reachable; configured=ollama (ollama ready)"],
    [
      ["ollama", { ok: false, detail: "" }, noModel],
      "· daemon not reachable; configured=ollama (model embeddinggemma MISSING — fix: bastra embeddings on)",
    ],
    [["ollama", { ok: false, detail: "" }, down], "· daemon not reachable; configured=ollama (D)"],
    [[undefined, { ok: false, detail: "" }, undefined], "· daemon not reachable; configured=unset"],
    [[undefined, UP({}), undefined], "· (daemon predates this field — restart it to report)"],
    [
      ["ollama", UP({ semanticRecall: "on", embeddingMode: "ollama:m" }), noModel],
      "⚠ on (ollama:m) but the embeddinggemma model is MISSING — recall falls back to BM25. Fix: bastra embeddings on",
    ],
    [
      ["ollama", UP({ semanticRecall: "on", embeddingMode: "ollama:m" }), down],
      "⚠ on (ollama:m) but Ollama is unreachable (D) — recall falls back to BM25",
    ],
    [
      ["ollama", UP({ semanticRecall: "on", embeddingMode: "ollama:m", embeddingSource: "settings" }), ready],
      "✓ on (ollama:m, source: settings)",
    ],
    [[undefined, UP({ semanticRecall: "on" }), undefined], "✓ on (?)"],
    [
      [undefined, UP({ semanticRecall: "degraded", embeddingMode: "m", embeddingError: "E" }), undefined],
      "⚠ degraded (m) — last error: E — recall falls back to BM25. Check: ollama list / ollama serve",
    ],
    [
      [undefined, UP({ semanticRecall: "degraded" }), undefined],
      "⚠ degraded (?) — recall falls back to BM25. Check: ollama list / ollama serve",
    ],
    [
      ["ollama", UP({ semanticRecall: "off", embeddingSource: "env" }), undefined],
      "· off — BASTRA_EMBEDDING_PROVIDER (env) overrides your config=ollama; unset it",
    ],
    [
      ["ollama", UP({ semanticRecall: "off" }), undefined],
      "· off — configured=ollama, daemon hasn't picked it up yet; restart pending (restart your AI client, or auto after idle)",
    ],
    [
      [undefined, UP({ semanticRecall: "off" }), undefined],
      "· off — BM25 keyword search only. Enable: bastra embeddings on",
    ],
  ];
  for (const [[configured, probe, ollama], english] of cases) {
    assert.equal(formatSemanticRecall(configured, probe, ollama), english);
    assert.equal(formatSemanticRecall(configured, probe, ollama, "ru"), english);
    const german = formatSemanticRecall(configured, probe, ollama, "de");
    assert.notEqual(german, english, english);
    assert.doesNotMatch(german, /not reachable|falls back|predates|keyword search/, german);
  }

  const url = "http://127.0.0.1:6723/ui";
  assert.equal(formatVaultMapLine(false, true, url, "en"), "· off (open + enable: bastra map)");
  assert.equal(formatVaultMapLine(true, false, url, "ru"), `· ${url} (daemon down — open it with: bastra map)`);
  assert.equal(formatVaultMapLine(false, true, url, "de"), "· aus (öffnen und einschalten: bastra map)");
  assert.equal(formatVaultMapLine(true, false, url, "de"), `· ${url} (Daemon läuft nicht — öffnen mit: bastra map)`);
  assert.equal(formatVaultMapLine(true, true, url, "de"), `✓ ${url}`);

  const procs: DaemonProcess[] = [
    { pid: 1, elapsed: "1:00", primary: true } as DaemonProcess,
    { pid: 2, elapsed: "2:00", primary: false } as DaemonProcess,
  ];
  assert.equal(
    formatExtraDaemons(procs),
    "1 further daemon process(es) running on other ports: pid 2 (2:00). " +
      "Harmless for recall — the port keeps them apart — but they hold a vault index in memory. Stop with: kill 2"
  );
  assert.equal(formatExtraDaemons(procs, "ru"), formatExtraDaemons(procs));
  assert.match(formatExtraDaemons(procs, "de") ?? "", /^1 weitere\(r\) Daemon-Prozess\(e\).*pid 2 \(2:00\).*kill 2$/);
});

test("doctor's daemon-origin note speaks German for 'de' and is unchanged English otherwise", () => {
  const configured = configuredState({ BASTRA_TASKS: "1" }, { BASTRA_AUTOSTART_MANAGED: "1" }, "darwin");
  const probes: [DaemonProbe, ReturnType<typeof configuredState> | undefined][] = [
    [UP({ startedBy: "forwarder", envOrigin: "client+settings", configFingerprint: "aaa" }), configured],
    [UP({ startedBy: "forwarder", envOrigin: "client", configFingerprint: configured!.fingerprint }), configured],
    [UP({ startedBy: "launchagent", configFingerprint: "aaa" }), null],
    [UP({ startedBy: "systemd" }), undefined],
    [UP({ startedBy: "elsewhere" }), undefined],
  ];
  for (const [probe, state] of probes) {
    const english = daemonOriginLines(probe, state, "darwin");
    assert.deepEqual(daemonOriginLines(probe, state, "darwin", "en"), english);
    assert.deepEqual(daemonOriginLines(probe, state, "darwin", "ru"), english);
    const german = daemonOriginLines(probe, state, "darwin", "de");
    assert.equal(german.length, english.length);
    german.forEach((line, i) => assert.notEqual(line, english[i], line));
  }
  const differs = daemonOriginLines(probes[0][0], configured, "darwin", "de").join("\n");
  assert.match(differs, /^→ Herkunft des Daemons/);
  assert.match(
    differs,
    /weichen ab von der Umgebung des bastra-LaunchAgents \+ daemon\.env in ~\/\.bastra\/cli-settings\.json/
  );
  assert.match(
    daemonOriginLines(probes[2][0], null, "win32", "de").join("\n"),
    /weder daemon\.env-Festlegungen noch eine verwaltete Aufgabe in der Aufgabenplanung/
  );
});

/** A home whose settings hold `language.primary = code` (none for null). */
async function homeWith(code: string | null): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "messages-language-f-"));
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

/** stdout and stderr of `run` with HOME pointed at `home` and `env` set. */
async function captured(home: string, run: () => Promise<unknown>, env: Record<string, string> = {}): Promise<string> {
  const keys = ["HOME", "USERPROFILE", ...Object.keys(env)];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const out = process.stdout.write,
    err = process.stderr.write;
  let text = "";
  const sink = ((chunk: string) => ((text += String(chunk)), true)) as typeof process.stdout.write;
  Object.assign(process.env, { HOME: home, USERPROFILE: home, ...env });
  process.stdout.write = sink;
  process.stderr.write = sink;
  try {
    await run();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
  return text;
}

test("commands print their own lines in language.primary; the English output is the one they always printed", async (t) => {
  const homes = { de: await homeWith("de"), unset: await homeWith(null), other: await homeWith("ru") };
  const failing = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(500, { "Content-Type": "application/json" }).end("{}"));
  });
  await new Promise<void>((ok) => failing.listen(0, "127.0.0.1", ok));
  const { port } = failing.address() as { port: number };
  const noLogs = join(homes.unset, "no-logs-here");
  t.after(async () => {
    failing.close();
    for (const home of Object.values(homes)) await rm(home, { recursive: true, force: true });
  });
  const boom = async () => {
    throw new Error("boom");
  };
  const save = ["save", "--title", "T", "--type", "lesson", "--scope", "s", "text"];
  const runs: [string, () => Promise<unknown>, Record<string, string>, string, string][] = [
    [
      "logs",
      () => cmdLogs({ follow: false, sinceMs: 300_000, source: "hook", lines: 200 }),
      { BASTRA_LOG_PATH: noLogs },
      `(no log entries in the last 5min — try --since 1d)\n  note: ${noLogs} does not exist yet; nothing has been logged.\n`,
      `(keine Log-Einträge in den letzten 5min — versuch --since 1d)\n  Hinweis: ${noLogs} gibt es noch nicht; bisher wurde nichts geloggt.\n`,
    ],
    [
      "codex",
      () => cmdCodexChat(["--"], () => null),
      {},
      "Codex CLI is not installed. Install it, then start your chat with bastra codex.\n",
      "Die Codex-CLI ist nicht installiert. Installiere sie und starte deinen Chat dann mit bastra codex.\n",
    ],
    [
      "rules proposals",
      () => cmdRules(parseArgs(["rules", "proposals", "extra"])),
      {},
      "error: usage: bastra rules proposals\n",
      "Fehler: Aufruf: bastra rules proposals\n",
    ],
    [
      "trash",
      () => cmdTrash(parseArgs(["trash", "list"])),
      { BASTRA_DAEMON_URL: `http://127.0.0.1:${port}` },
      "bastra trash list: HTTP 500\n",
      "bastra trash list: Fehler: HTTP 500\n",
    ],
    ["recall", () => cmdRecall(["recall", "q"], boom), {}, "bastra recall: boom\n", "bastra recall: Fehler: boom\n"],
    [
      "save",
      () => cmdSave(save, boom, { stdin: async () => undefined }),
      {},
      "bastra save: boom\n",
      "bastra save: Fehler: boom\n",
    ],
  ];
  for (const [name, run, env, english, german] of runs) {
    assert.equal(await captured(homes.unset, run, env), english, `${name}: unset`);
    assert.equal(await captured(homes.other, run, env), english, `${name}: unlisted language`);
    assert.equal(await captured(homes.de, run, env), german, `${name}: German`);
  }
});

test("bastra logs: the usage errors for --since, --source and --lines follow language.primary", async (t) => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const homes = { de: await homeWith("de"), unset: await homeWith(null), other: await homeWith("ru") };
  t.after(async () => {
    for (const home of Object.values(homes)) await rm(home, { recursive: true, force: true });
  });
  const run = (home: string, args: string[]) => {
    const r = spawnSync(process.execPath, [cli, "logs", ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, BASTRA_UPDATE_CHECK: "off" },
      encoding: "utf8",
      timeout: 15_000,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const cases: [string[], string, string][] = [
    [
      ["--since", "soon"],
      "error: cannot read --since 'soon' — try 30s, 10min, 2h, 1d\n",
      "Fehler: --since 'soon' ist nicht lesbar — versuch 30s, 10min, 2h, 1d\n",
    ],
    [
      ["--source", "web"],
      "error: --source must be daemon, hook or all (got 'web')\n",
      "Fehler: --source muss daemon, hook oder all sein (war 'web')\n",
    ],
    [
      ["--lines", "0"],
      "error: --lines must be a positive number (got '0')\n",
      "Fehler: --lines muss eine positive Zahl sein (war '0')\n",
    ],
  ];
  for (const [args, english, german] of cases) {
    for (const home of [homes.unset, homes.other])
      assert.deepEqual(run(home, args), { status: 2, stdout: "", stderr: english }, args.join(" "));
    assert.deepEqual(run(homes.de, args), { status: 2, stdout: "", stderr: german }, args.join(" "));
  }
});
