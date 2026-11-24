/**
 * #1602 (part D) — screen texts formatted outside the command modules follow
 * language.primary: doctor's conflict-copy, derived-claims and client-memory
 * notes, the hook-binary block, the source-checkout build and live-revision
 * report, the update preflight frame, the patch-series outcome and
 * `bastra models`. German for "de", English when unset or for a language
 * without its own words; the English bytes are the ones these always printed.
 *
 * And the onboarding catalog: the map's dialog (GET /ui/onboarding) gets it
 * in language.primary from the same source as `bastra onboard`, while the
 * AI interview the session hook hands to the model stays English.
 *
 * Nothing here runs a system program or opens a connection beyond a
 * loopback server on an ephemeral port.
 *
 * Runner: `node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/cli-messages-language-d.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCTOR_NOTES_WORDS, doctorNotesWordsIn } from "../src/cli/doctor-notes-words.js";
import { STUB_FRESHNESS_WORDS, stubFreshnessWordsIn } from "../src/cli/stub-freshness-words.js";
import { SOURCE_BUILD_WORDS, sourceBuildWordsIn } from "../src/cli/source-build-words.js";
import { UPDATE_PREFLIGHT_WORDS, updatePreflightWordsIn } from "../src/cli/update-preflight-words.js";
import { MODELS_CMD_WORDS, modelsCmdWordsIn } from "../src/cli/models-cmd-words.js";
import { PATCH_REPORT_WORDS, patchReportWordsIn } from "../src/patch-report-words.js";
import { ONBOARDING_WORDS, onboardingWordsIn } from "../src/onboarding-words.js";
import { conflictCopyLines } from "../src/cli/conflict-copies-note.js";
import { derivedClaimsLines, type DerivedClaimsIo } from "../src/cli/derived-claims-note.js";
import { clientMemoryLines } from "../src/cli/client-memory.js";
import { stubFreshnessLines, type StubFreshnessReport } from "../src/cli/stub-freshness.js";
import { describeSourceBuild, type SourceBuildState } from "../src/cli/source-build.js";
import { describeLiveRevision } from "../src/cli/live-revision.js";
import { formatPreflight, type PreflightResult } from "../src/cli/update-preflight.js";
import { formatApplyOutcome } from "../src/patch-report.js";
import { detectInstallMode, reapplyPatchSeries } from "../src/cli/update.js";
import { cmdModels } from "../src/cli/models-cmd.js";
import { PERSONAS, PERSONA_LABELS, QUESTIONS, handleUiOnboarding } from "../src/onboarding.js";
import { buildOnboardingBlock } from "../src/session-onboarding-block.js";

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
  ["doctor notes", DOCTOR_NOTES_WORDS, doctorNotesWordsIn],
  ["stub freshness", STUB_FRESHNESS_WORDS, stubFreshnessWordsIn],
  ["source build", SOURCE_BUILD_WORDS, sourceBuildWordsIn],
  ["update preflight", UPDATE_PREFLIGHT_WORDS, updatePreflightWordsIn],
  ["patch report", PATCH_REPORT_WORDS, patchReportWordsIn],
  ["models", MODELS_CMD_WORDS, modelsCmdWordsIn],
];

test("every part-D words table has each text in English and German, and English for an unlisted language", () => {
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

test("the onboarding catalog has every persona and question in German; English is the catalog's own", () => {
  assert.deepEqual(Object.keys(ONBOARDING_WORDS).sort(), ["de", "en"]);
  const en = onboardingWordsIn("en"),
    de = onboardingWordsIn("de");
  for (const p of PERSONAS) {
    assert.equal(en.persona(p, PERSONA_LABELS[p]), PERSONA_LABELS[p]);
    assert.ok(de.personaNames[p], `no German label for persona '${p}'`);
    assert.notEqual(de.persona(p, PERSONA_LABELS[p]), PERSONA_LABELS[p], `persona '${p}' is English in German`);
  }
  for (const q of QUESTIONS) {
    assert.ok(de.questions[q.id], `no German text for question '${q.id}'`);
    assert.equal(en.ask(q), q.ask);
    assert.equal(en.hint(q), q.hint);
    assert.notEqual(de.ask(q), q.ask, `'${q.id}' asks in English`);
    assert.notEqual(de.hint(q), q.hint, `'${q.id}' hints in English`);
  }
  // Only catalog ids carry German texts — a stale id would never be shown.
  const ids = new Set(QUESTIONS.map((q) => q.id));
  for (const id of Object.keys(de.questions)) assert.ok(ids.has(id), `German text for unknown question '${id}'`);
  assert.equal(onboardingWordsIn("ru"), ONBOARDING_WORDS.en);
  assert.equal(onboardingWordsIn(undefined), ONBOARDING_WORDS.en);
});

test("each part-D formatter speaks German for 'de' and English for an unlisted language", async () => {
  const copies = [{ copy: "/v/a (1).md", original: "/v/a.md", id: "a" }] as never;
  const claims: DerivedClaimsIo = {
    memories: async () => [{ id: "m", claims: [{}] as never }],
    resolve: async () => [{ id: "c", status: "gone", source: "s.ts" }] as never,
  };
  const dirs = [{ client: "codex", dir: "/c", notes: 2, pending: 1 }] as never;
  const stub = {
    own: "/own/bastra-hook",
    sourcesAvailable: true,
    findings: [
      { binary: "/x/bastra-hook", surfaces: ["codex"], foreign: false, state: "stale", statusline: "ok", stamp: null },
    ],
  } as unknown as StubFreshnessReport;
  const build = { reason: "stale", revision: "abc1234", builtRevision: null, newestBuildMs: 0, newestSourceMs: 1 };
  const preflight = { ok: true, notes: [], dirty: [{ kind: "changed", path: "a.js" }], backupDir: "/b" } as never;
  const outcome = { applied: [{ id: "p1", subject: "fix" }], retired: [], setAside: [], rolledBack: true } as never;
  const cases: [string, (language: string) => string | Promise<string>, RegExp][] = [
    [
      "conflict copies",
      (l) => conflictCopyLines("/v", copies, l).join("\n"),
      /Konfliktkopie gefunden.*Kopie von a\.md/s,
    ],
    [
      "derived claims",
      async (l) => (await derivedClaimsLines(claims, l)).join("\n"),
      /1 Angabe in 1 Memory.*steht nicht mehr/s,
    ],
    ["client memory", (l) => clientMemoryLines(dirs, l).join("\n"), /2 Notizen, 1 noch nicht im Vault.*Recall liest/s],
    ["stub freshness", (l) => stubFreshnessLines(stub, l).join("\n"), /veraltetes Hook-Programm.*neu bauen mit/s],
    [
      "source build",
      (l) => describeSourceBuild(build as SourceBuildState, "npm run build", l),
      /älter als seine Quellen.*Baue es zuerst/s,
    ],
    [
      "live revision",
      (l) => {
        const said = describeLiveRevision("no-daemon", { state: build as SourceBuildState, daemonRevision: null }, l);
        return said.report + said.closing;
      },
      /kein Daemon antwortet.*nächsten Daemon-Start/s,
    ],
    ["preflight", (l) => formatPreflight(preflight as PreflightResult, l), /lokal geändert \(1\).*gesichert nach/s],
    ["patch outcome", (l) => formatApplyOutcome(outcome, l), /angewendet p1.*startete nicht/s],
  ];
  for (const [name, run, german] of cases) {
    assert.match(await run("de"), german, `${name}: German`);
    assert.equal(await run("ru"), await run("en"), `${name}: unlisted language → English`);
    assert.doesNotMatch(await run("en"), /[äöüÄÖÜß]/, `${name}: English`);
  }
});

test("bastra update's patch reapply prints its outcome in the run's language", () => {
  const brew = detectInstallMode("/opt/homebrew/Cellar/bastra-recall/1.0.0/libexec/packages/daemon/dist/cli/update.js");
  const said = (language?: string) => {
    let out = "";
    reapplyPatchSeries(brew, "/x", {
      series: () => [{}] as never,
      root: () => "/keg",
      apply: () => ({ applied: [{ id: "p1", subject: "fix" }], retired: [], setAside: [] }) as never,
      record: () => undefined,
      version: () => "1.0.0",
      out: (t) => (out += t),
      language,
    });
    return out;
  };
  assert.match(said("de"), / {2}✓ angewendet p1 — fix\n/);
  assert.match(said(undefined), / {2}✓ applied {3}p1 — fix\n/);
});

test("bastra models follows language.primary from its settings file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "messages-language-d-models-"));
  const run = async (primary: string | null): Promise<string> => {
    const settingsPath = join(dir, `${primary ?? "unset"}.json`);
    await writeFile(settingsPath, JSON.stringify(primary ? { language: { primary } } : {}));
    const write = process.stdout.write;
    let out = "";
    process.stdout.write = ((chunk: string) => ((out += String(chunk)), true)) as typeof process.stdout.write;
    try {
      await cmdModels({ sub: "status", settingsPath, deps: { recommendation: null, ramGB: 24 } });
    } finally {
      process.stdout.write = write;
    }
    return out;
  };
  const de = await run("de");
  // The machine line shows the real hardware (deps.ramGB only steers the
  // recommendation), so the amount differs between this machine and CI.
  assert.match(de, /^Generierungsmodell: .*\nRechner: \d+ GB/m);
  assert.match(de, /empfohlen: /);
  const en = await run(null);
  assert.match(en, /^generation model: .*\nmachine: /m);
  assert.equal(await run("ru"), en);
});

/** GET /ui/onboarding with the given language.primary (none for null). */
async function catalogFor(primary: string | null): Promise<{
  personas: { id: string; label: string }[];
  questions: { id: string; ask: string; hint: string; optional: boolean; personas: string[] | null }[];
}> {
  const dir = await mkdtemp(join(tmpdir(), "messages-language-d-ui-"));
  const settingsPath = join(dir, "cli-settings.json");
  await writeFile(
    settingsPath,
    JSON.stringify({ ui: { enabled: true }, ...(primary ? { language: { primary } } : {}) })
  );
  const server = createServer((req, res) => void handleUiOnboarding(req, res, dir, 0, settingsPath));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as { port: number }).port;
    return await new Promise((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path: "/ui/onboarding", method: "GET" }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve(JSON.parse(raw)));
      });
      req.on("error", reject);
      req.end();
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("GET /ui/onboarding serves the catalog in language.primary; ids and structure never change", async () => {
  const en = await catalogFor("en");
  // English — set, unset or an unlisted language — is the catalog itself.
  assert.deepEqual(en.questions, JSON.parse(JSON.stringify(QUESTIONS)));
  assert.deepEqual(
    en.personas,
    PERSONAS.map((p) => ({ id: p, label: PERSONA_LABELS[p] }))
  );
  assert.deepEqual(await catalogFor(null), en);
  assert.deepEqual(await catalogFor("ru"), en);

  const de = await catalogFor("de");
  assert.equal(de.personas.find((p) => p.id === "developer")?.label, "Code & Projekte — ich baue Software");
  assert.equal(
    de.questions.find((q) => q.id === "freeform")?.ask,
    "Sonst noch etwas, das deine KI über dich wissen sollte? Schreib frei."
  );
  // The answers come back keyed by these ids — they, `optional` and the
  // persona filter are the same in every language.
  const shape = (c: typeof en) => ({
    personas: c.personas.map((p) => p.id),
    questions: c.questions.map((q) => [q.id, q.optional, q.personas]),
  });
  assert.deepEqual(shape(de), shape(en));
  for (const [i, q] of de.questions.entries()) assert.notEqual(q.ask, en.questions[i]!.ask, `'${q.id}' in German`);
});

test("the AI interview handed to the model stays English and unchanged", () => {
  // The session hook's onboarding block takes no language: it is written for
  // the model, whatever language.primary says. Pinned byte for byte.
  const block = buildOnboardingBlock(true);
  assert.equal(
    createHash("sha256").update(block).digest("hex"),
    "2cc3f5f256d5cda9bf937e66de873224b0b33cc7d356935cefed265710a3507c"
  );
  assert.doesNotMatch(block, /[äöüÄÖÜß]/);
  assert.equal(buildOnboardingBlock(false), "");
});
