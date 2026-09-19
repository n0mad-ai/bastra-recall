import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeGraphCache } from "../src/code-graph/cache.js";
import { graphDirOf, GRAPH_FILE_NAME } from "../src/code-graph/reader.js";
import { writeManifest, type CodeGraphManifest } from "../src/code-graph/manifest.js";
import { changeImpactIntent } from "../src/code-graph/impact-intent.js";
import { promptImpactNote } from "../src/code-graph/prompt-impact.js";
import type { ReadonlySessionState } from "../src/session-state.js";

/**
 * The UserPromptSubmit gate (#606).
 *
 * The expensive failure of this feature is not a missed question — that costs
 * one grep, which is what happens today anyway. It is a block injected into an
 * ordinary prompt, which costs tokens on every turn of every session. So the
 * negative list below is the load-bearing half of this file, and it is long on
 * purpose: a widening of the phrasing that starts firing on ordinary work has
 * to break something.
 */

function node(id: string, label: string, file: string, line = 1) {
  return {
    id,
    label,
    file_type: "code",
    source_file: file,
    source_location: `L${line}`,
    community: 0,
    _origin: "ast",
  };
}

function edge(source: string, target: string, relation: string) {
  return { source, target, relation, confidence: "EXTRACTED", confidence_score: 0.85, _origin: "ast" };
}

const SAVE = "packages/core/src/save.ts";

const FIXTURE = {
  directed: true,
  multigraph: false,
  graph: {},
  built_at_commit: "5483f5697434bd20071d1b225a72e04db97a93e4",
  nodes: [
    node("save_savememory", "saveMemory()", SAVE, 4),
    node("save_validate", "validateMemory()", SAVE, 12),
    node("audit_auditsave", "auditSave()", "packages/core/src/audit-save.ts", 69),
    node("checks_run", "runChecks()", "packages/core/src/checks.ts", 8),
  ],
  links: [
    edge("audit_auditsave", "save_savememory", "calls"),
    edge("checks_run", "save_validate", "calls"),
  ],
  hyperedges: [],
};

const MANIFEST: CodeGraphManifest = {
  graphifyVersion: "0.9.63",
  builtAt: new Date().toISOString(),
  commit: null,
  repoRoot: "",
  command: "graphify extract --code-only",
  fileState: { count: 4, newestMtimeMs: 0 },
  lastError: null,
  dirty: false,
};

const EMPTY_SESSION: ReadonlySessionState = { shown: {} };
const CONTENT_BUDGET_MS = 5_000;

let root: string;
let repo: string;
let cache: CodeGraphCache;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "bastra-impact-intent-"));
  repo = join(root, "repo");
  const dir = graphDirOf(repo);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, GRAPH_FILE_NAME), JSON.stringify(FIXTURE), "utf8");
  await writeManifest(dir, { ...MANIFEST, repoRoot: repo });
  cache = new CodeGraphCache();
  await cache.ensureLoaded(repo);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

// ─── The phrasing gate ───────────────────────────────────────────

/** Prompts that ARE the question the graph answers, in both languages. */
const POSITIVE: readonly string[] = [
  "Was bricht, wenn ich saveMemory umbenenne?",
  "Was geht kaputt, wenn ich packages/core/src/save.ts ändere?",
  "Welche Dateien muss ich anpassen, wenn saveMemory ein Argument bekommt?",
  "Welche Stellen muss ich nachziehen für validateMemory?",
  "Habe ich eine Aufrufstelle von saveMemory übersehen?",
  "Wer ruft validateMemory eigentlich auf?",
  "Was hängt alles an save.ts dran?",
  "Wenn ich das ändere, kompiliert dann irgendwas nicht mehr — konkret save.ts?",
  "Welche Auswirkungen hat es, saveMemory zu entfernen?",
  "what breaks if I change saveMemory?",
  "which files do I need to update when save.ts changes?",
  "did I miss a call site of validateMemory?",
  "who calls saveMemory?",
  "what depends on packages/core/src/save.ts?",
  "what's the blast radius of renaming saveMemory?",
  "impact of changing validateMemory?",
  "will anything stop compiling if I touch saveMemory?",
];

/**
 * Prompts that must NOT trigger. Ordinary work, ordinary questions, and the
 * near misses: a prompt that names a file without asking about impact, and one
 * that asks about impact without naming anything.
 */
const NEGATIVE: readonly string[] = [
  "Schreib bitte einen Test für saveMemory.",
  "Formatiere packages/core/src/save.ts neu.",
  "Erklär mir, was validateMemory macht.",
  "Wie funktioniert der Recall-Hook?",
  "Mach den Build grün.",
  "Welche Dateien liegen in packages/core/src?",
  "Zeig mir die letzten fünf Commits.",
  "Warum schlägt der Test in save.test.ts fehl?",
  "Kannst du den Lint-Fehler beheben?",
  "Füge saveMemory eine Doku-Zeile hinzu.",
  "Was ist der Unterschied zwischen BM25 und RRF?",
  "Bitte committe das.",
  "Lies packages/core/src/save.ts und fasse es zusammen.",
  "Wie viele Zeilen hat save.ts?",
  "Benenne die Variable input in payload um.",
  "Ich habe saveMemory schon angepasst, danke.",
  "Was bricht eigentlich immer bei dir?",
  "Was geht kaputt, wenn der Strom ausfällt?",
  "Welche Dateien soll ich dir schicken?",
  "Wer ist für dieses Repo verantwortlich?",
  "refactor save.ts to use async/await",
  "add a changelog entry",
  "run the tests",
  "what does validateMemory return?",
  "explain the difference between the two lanes",
  "which files did you change?",
  "open packages/core/src/save.ts",
  "summarise the diff",
  "fix the failing test in save.test.ts",
  "write a docstring for saveMemory",
  "what breaks down in this explanation?",
  "commit and push",
  "update the README",
  "is saveMemory exported?",
];

describe("change-impact intent gate: the phrasing half", () => {
  for (const prompt of POSITIVE) {
    it(`asks: ${prompt}`, () => {
      assert.equal(changeImpactIntent(prompt).asked, true);
    });
  }

  it(`stays silent on ${NEGATIVE.length} ordinary prompts`, () => {
    const fired = NEGATIVE.filter((p) => {
      const intent = changeImpactIntent(p);
      // The real gate is both halves: a phrasing match with nothing nameable
      // is still no injection, so that is what this asserts.
      return intent.asked && (intent.paths.length > 0 || intent.symbols.length > 0);
    });
    assert.deepEqual(fired, [], `${fired.length} of ${NEGATIVE.length} prompts would have injected`);
  });

  it("extracts the file and the symbol a question names", () => {
    const intent = changeImpactIntent(
      "Was bricht, wenn ich `saveMemory` in packages/core/src/save.ts ändere?",
    );
    assert.deepEqual(intent.paths, ["packages/core/src/save.ts"]);
    assert.ok(intent.symbols.includes("saveMemory"));
  });

  it("does not read ordinary prose as an identifier", () => {
    const intent = changeImpactIntent("what breaks if I change the behaviour of this thing?");
    assert.equal(intent.asked, true);
    assert.deepEqual(intent.paths, []);
    assert.deepEqual(intent.symbols, []);
  });
});

// ─── The resolution gate ─────────────────────────────────────────

describe("change-impact block on a prompt: the resolution half", () => {
  const ask = (prompt: string, session: ReadonlySessionState = EMPTY_SESSION) =>
    promptImpactNote({ prompt, cwd: repo, session, cache, budgetMs: CONTENT_BUDGET_MS });

  it("answers a symbol question with that symbol's callers", async () => {
    const out = await ask("Was bricht, wenn ich saveMemory umbenenne?");
    assert.ok(out.note);
    assert.equal(out.note.basis, "symbols");
    assert.equal(out.note.file, SAVE);
    assert.match(out.note.note, /audit-save\.ts:69 — calls saveMemory/);
    assert.doesNotMatch(out.note.note, /checks\.ts/);
  });

  it("answers a file-only question with the whole file, and says so", async () => {
    const out = await ask("what breaks if I change packages/core/src/save.ts?");
    assert.ok(out.note);
    assert.equal(out.note.basis, "whole_file");
    assert.match(out.note.note, /basis="whole_file"/);
    assert.match(out.note.note, /find_affected_files/);
  });

  it("resolves a bare filename when exactly one file ends in it", async () => {
    const out = await ask("which files do I need to update when save.ts changes?");
    assert.ok(out.note);
    assert.equal(out.note.file, SAVE);
  });

  it("injects nothing when the graph knows neither the file nor the symbol", async () => {
    const out = await ask("what breaks if I change packages/other/src/nowhere.ts?");
    assert.equal(out.note, null);
    assert.equal(out.dedupeHit, false);
  });

  it("injects nothing on an ordinary prompt that names an indexed file", async () => {
    const out = await ask("Formatiere packages/core/src/save.ts neu.");
    assert.equal(out.note, null);
  });

  it("injects nothing when the graph is cold", async () => {
    const cold = new CodeGraphCache();
    const out = await promptImpactNote({
      prompt: "Was bricht, wenn ich saveMemory umbenenne?",
      cwd: repo,
      session: EMPTY_SESSION,
      cache: cold,
      budgetMs: CONTENT_BUDGET_MS,
    });
    assert.equal(out.note, null);
  });

  it("does not deliver the same answer twice in one session", async () => {
    const first = await ask("Wer ruft validateMemory auf?");
    assert.ok(first.note);
    const second = await ask("Wer ruft validateMemory auf?", {
      shown: { [first.note.dedupeKey]: { count: 1, lastShownAt: Date.now() } },
    });
    assert.equal(second.note, null);
    assert.equal(second.dedupeHit, true);
  });

  it("stays inside the prompt lane's share of the budget", async () => {
    const prompt = "Was bricht, wenn ich saveMemory umbenenne?";
    await ask(prompt);
    const took: number[] = [];
    for (let i = 0; i < 50; i++) {
      const at = performance.now();
      await promptImpactNote({ prompt, cwd: repo, cache, budgetMs: CONTENT_BUDGET_MS });
      took.push(performance.now() - at);
    }
    took.sort((a, b) => a - b);
    const p90 = took[Math.floor(took.length * 0.9)];
    assert.ok(p90 < 200, `p90 ${p90.toFixed(2)} ms is over the 200 ms lane target`);
  });
});
