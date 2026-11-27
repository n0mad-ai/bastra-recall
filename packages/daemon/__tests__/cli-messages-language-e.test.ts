/**
 * #1602 (part E) — the last screen texts of the CLI follow language.primary:
 * doctor's features block, its learned-bridges, `affects_files` and MCP
 * delivery notes, the code-graph lines `bastra doctor` and `bastra code
 * status` share (coverage map, paused/stopped refresh, external nodes, rename
 * offers, unresolved entries), and the store listing of `bastra reconcile`.
 * German for "de", English when unset or for a language without its own
 * words; the English bytes are the ones these always printed.
 *
 * Not here, on purpose: the adapters' install/uninstall/doctor `message`
 * fields. doctor()'s message is also the `message` of `bastra status --json`,
 * so it stays one English value.
 *
 * Nothing here runs a daemon or opens a connection beyond a loopback server
 * on an ephemeral port.
 *
 * Runner: `node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/cli-messages-language-e.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CODE_GRAPH_WORDS, codeGraphWordsIn } from "../src/code-graph/code-graph-words.js";
import { FEATURES_WORDS, featuresWordsIn } from "../src/cli/features-words.js";
import { DOCTOR_NOTES_WORDS, doctorNotesWordsIn } from "../src/cli/doctor-notes-words.js";
import { RECONCILE_CMD_WORDS, reconcileCmdWordsIn } from "../src/cli/reconcile-cmd-words.js";
import { featureLines, type FeatureState } from "../src/cli/features-note.js";
import { bridgeLearningLines } from "../src/cli/bridges-note.js";
import { affectsFilesLines, type AffectsFilesIo } from "../src/cli/affects-files-note.js";
import { deliveryLines, fetchToolsFromDaemon } from "../src/cli/doctor-delivery.js";
import { refreshStatusLines } from "../src/code-graph/refresh-status.js";
import { ageOf, coverageMapStatus } from "../src/code-graph/coverage-map.js";
import { externalRefLines } from "../src/code-graph/external-refs.js";
import { formatOffers } from "../src/code-graph/rename-evidence.js";
import { formatUnresolved } from "../src/code-graph/applies-to.js";
import { formatDiscovery } from "../src/cli/store-discovery.js";
import { cmdReconcile } from "../src/cli/reconcile-cmd.js";
import { parseArgs } from "../src/cli/commands.js";
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
  ["code graph", CODE_GRAPH_WORDS, codeGraphWordsIn],
  ["features", FEATURES_WORDS, featuresWordsIn],
  ["doctor notes", DOCTOR_NOTES_WORDS, doctorNotesWordsIn],
  ["reconcile", RECONCILE_CMD_WORDS, reconcileCmdWordsIn],
];

test("every part-E words table has each text in English and German, and English for an unlisted language", () => {
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

const NOW = new Date("2026-10-20T10:00:00Z");

const FEATURES: FeatureState = {
  clients: [
    {
      surface: "codex",
      features: {
        recallHooks: false,
        stopHook: true,
        skill: true,
        toolSurface: "search",
        mcpConfig: "/c.toml",
        rulebookGate: { version: null, verified: false },
      },
    },
  ],
  primaryLanguage: undefined,
  onboardingDone: false,
  vaultSize: 3,
  semanticRecall: { state: "off", detail: "x" },
  paraphrasing: { state: "on", model: "m", modelPulled: false },
  reflex: { enabled: true },
  redaction: true,
  codeAwareness: { repos: 2, offByEnv: false },
  promptImpact: false,
  coverageMap: true,
  docsMode: "off",
  commons: false,
  bridges: false,
  ui: true,
  archive: "bastra",
  archiveLimits: { cap: 2 ** 30, maxItem: null },
  documentWrite: false,
  androidApp: false,
  battery: { saver: true, live: { source: "battery", saving: true } },
};

const AFFECTS: AffectsFilesIo = {
  memories: async () => [{ id: "m1", affects_files: ["gone.ts", "/etc/hosts"], scope: "p" }],
  repoRoot: async () => "/nonexistent-repo-1602",
  exists: () => false,
  project: () => "p",
};

test("each part-E formatter speaks German for 'de' and English for an unlisted language", async () => {
  const root = await mkdtemp(join(tmpdir(), "messages-language-e-"));
  const status = {
    state: "idle",
    pending: false,
    failures: 2,
    lastError: null,
    givenUp: true,
    lastReason: null,
    builds: 0,
    nextAttemptAt: null,
  } as never;
  const paused = { ...(status as object), nextAttemptAt: "2026-10-20T11:30:00Z" } as never;
  const store = {
    path: "/a",
    realPath: "/a",
    sources: [],
    exists: true,
    auditMemories: 2,
    sharedWithThis: 1,
    aliases: [],
  };
  const cases: [string, (language: string) => string | Promise<string>, RegExp][] = [
    ["features", (l) => featureLines(FEATURES, l).join("\n"), /→ Funktionen.*Semantische Suche: aus.*Akku-Sparmodus/s],
    [
      "bridges",
      (l) => bridgeLearningLines({ enabled: true, runs: [], now: NOW, language: l }).join("\n"),
      /keine Brückenbildung.*Anfrageerweiterung: Schatten/s,
    ],
    [
      "affects_files",
      async (l) => (await affectsFilesLines(AFFECTS, l)).join("\n"),
      /gibt es in diesem Repository nicht.*1 weiterer Eintrag/s,
    ],
    [
      "affects_files without git",
      async (l) => (await affectsFilesLines({ ...AFFECTS, repoRoot: async () => null }, l)).join("\n"),
      /2 Einträge in 1 Memory — hier nicht geprüft/,
    ],
    [
      "delivery",
      (l) =>
        deliveryLines(
          [
            { surface: "codex", mcpSurface: "full", probe: { ok: true, tools: 9, bytes: 400, names: 40 } },
            { surface: "cursor", mcpSurface: "search", probe: { ok: false, detail: "d" } },
          ],
          l
        ).join("\n"),
      /Auslieferung je Client.*MCP listet 9 Werkzeuge.*kam nicht vom Daemon/s,
    ],
    [
      "refresh",
      (l) => [...refreshStatusLines(status, NOW, l), ...refreshStatusLines(paused, NOW, l)].join("\n"),
      /gestoppt nach 2 fehlgeschlagenen Builds.*pausiert.*in 1 Std\. 30 Min\./s,
    ],
    ["coverage map", (l) => coverageMapStatus(join(root, "repo"), NOW.getTime(), l), /^Abdeckungskarte: noch keine$/],
    ["age", (l) => ageOf("2026-10-15T10:00:00Z", NOW.getTime(), codeGraphWordsIn(l)), /^5 Tage alt$/],
    [
      "external nodes",
      (l) => externalRefLines({ total: 5, resolved: 0, workspaceModules: 2 }, l).join("\n"),
      /5 externe Knoten, 0 aufgelöst — dieses Repository ist ein Workspace/,
    ],
    [
      "rename offers",
      (l) =>
        formatOffers(
          [{ memoryId: "m", entry: "a.ts", from: "a.ts", to: "b.ts", suggestedEntry: "b.ts", similarity: 80 }] as never,
          l
        ).join("\n"),
      /\(git: 80 % ähnlich\) — angeboten, nicht übernommen/,
    ],
    [
      "unresolved",
      (l) =>
        formatUnresolved([{ memoryId: "m", entry: "e", file: "e", symbol: "s", reason: "symbol-missing" }], l).join(
          "\n"
        ),
      /Symbol nicht im Code-Graphen gefunden/,
    ],
    [
      "store discovery",
      (l) => formatDiscovery({ self: store, others: [] }, reconcileCmdWordsIn(l)),
      /dieser Vault:.*2 Memories, 1 gemeinsam.*keine andere Kopie/s,
    ],
  ];
  try {
    for (const [name, run, german] of cases) {
      assert.match(await run("de"), german, `${name}: German`);
      assert.equal(await run("ru"), await run("en"), `${name}: unlisted language → English`);
      assert.doesNotMatch(await run("en"), /[äöüÄÖÜß]/, `${name}: English`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the doctor's delivery probe names a failure in the run's language", async (t) => {
  const server = createServer((_req, res) => res.writeHead(503).end());
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const probe = (language?: string) => fetchToolsFromDaemon(`http://127.0.0.1:${port}`, language)("full");
  assert.deepEqual(await probe("de"), { ok: false, detail: "der Daemon antwortete mit HTTP 503" });
  assert.deepEqual(await probe(), { ok: false, detail: "daemon answered HTTP 503" });
  assert.deepEqual(await probe("ru"), await probe());
});

/** A home whose settings hold `language.primary = code` (none for null). */
async function homeWith(code: string | null): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "messages-language-e-"));
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

/** stdout (console included) of `run` with HOME pointed at `home`. */
async function captured(home: string, run: () => Promise<unknown>): Promise<string> {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const write = process.stdout.write;
  let text = "";
  process.env.HOME = process.env.USERPROFILE = home;
  process.stdout.write = ((chunk: string) => ((text += String(chunk)), true)) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = write;
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
  return text;
}

test("bastra reconcile lists the stores in language.primary; the English listing is the one it always was", async () => {
  const homes = { de: await homeWith("de"), unset: await homeWith(null), other: await homeWith("ru") };
  // The real path: on macOS tmpdir() is behind a symlink, which the listing would name.
  const vault = await realpath(await mkdtemp(join(tmpdir(), "messages-language-e-vault-")));
  const run = () =>
    cmdReconcile(parseArgs(["reconcile", "--vault", vault]), NOW, {
      home: homes.unset,
      registrations: [],
      syncRoots: [],
    });
  try {
    const english =
      `this vault:\n  ${vault}\n    audit log: 0 memories, 0 shared with this vault\n\n` +
      "no other copy of this vault found (settings, symlinks, sync folders).\n";
    assert.equal(
      await captured(homes.de, run),
      `dieser Vault:\n  ${vault}\n    Audit-Log: 0 Memories, 0 gemeinsam mit diesem Vault\n\n` +
        "keine andere Kopie dieses Vaults gefunden (Einstellungen, Symlinks, Sync-Ordner).\n"
    );
    assert.equal(await captured(homes.unset, run), english);
    assert.equal(await captured(homes.other, run), english);
  } finally {
    for (const home of [...Object.values(homes), vault]) await rm(home, { recursive: true, force: true });
  }
});
