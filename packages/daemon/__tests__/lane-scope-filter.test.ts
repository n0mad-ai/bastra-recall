/**
 * §20.5 — der Lane-Scope-Filter für Prompt- und Todo-Lane.
 *
 * Beide Lanes filterten nie nach Projekt-Scope, während Write-Lane und
 * SessionStart seit #110 hart filtern. Der Filter läuft deshalb zuerst im
 * SHADOW-Modus: er misst, was er verwerfen würde, und verwirft nichts.
 *
 * Runner: `tsx --test __tests__/lane-scope-filter.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  applyLaneScopeFilter,
  laneScopeFilterMode,
  projectConfidence,
  projectForFilter,
  vaultKnowsProject,
  type LaneScopeHit,
} from "../src/scope-filter.js";

const MUST_LOAD = 100;

function hit(over: Partial<LaneScopeHit> & { scope: string }): LaneScopeHit {
  return { score: 120, ...over };
}

// `projectKnown: true` = der Vault kennt das Projekt. Diese Tests prüfen die
// Anker- und unfused-Logik; der Beleg-Schutz hat eigene Tests weiter unten.
const PROMPT_OPTS = {
  allowAnchoredCrossScope: true,
  mustLoadScore: MUST_LOAD,
  unfused: false,
  exemptReflex: true,
  projectKnown: true,
};
const TODO_OPTS = { ...PROMPT_OPTS, allowAnchoredCrossScope: false };

// ── Modus ────────────────────────────────────────────────────────────────

test("laneScopeFilterMode: shadow ist der Default, enforce nur explizit", () => {
  const before = process.env.BASTRA_SCOPE_FILTER_LANES;
  try {
    delete process.env.BASTRA_SCOPE_FILTER_LANES;
    assert.equal(laneScopeFilterMode(), "shadow");
    process.env.BASTRA_SCOPE_FILTER_LANES = "";
    assert.equal(laneScopeFilterMode(), "shadow");
    process.env.BASTRA_SCOPE_FILTER_LANES = "true"; // kein Freibrief
    assert.equal(laneScopeFilterMode(), "shadow");
    process.env.BASTRA_SCOPE_FILTER_LANES = "enforce";
    assert.equal(laneScopeFilterMode(), "enforce");
  } finally {
    if (before === undefined) delete process.env.BASTRA_SCOPE_FILTER_LANES;
    else process.env.BASTRA_SCOPE_FILTER_LANES = before;
  }
});

test("shadow misst, verwirft aber nichts — enforce verwirft dieselben Treffer", () => {
  const hits = [hit({ scope: "bastra-recall" }), hit({ scope: "carnexus" })];
  const shadow = applyLaneScopeFilter(hits, "bastra-recall", PROMPT_OPTS, "shadow");
  assert.equal(shadow.hits.length, 2); // Eingabe unverändert
  assert.equal(shadow.droppedCount, 1);
  assert.deepEqual(shadow.droppedScopes, ["carnexus"]);

  const enforce = applyLaneScopeFilter(hits, "bastra-recall", PROMPT_OPTS, "enforce");
  assert.equal(enforce.hits.length, 1);
  assert.equal(enforce.hits[0].scope, "bastra-recall");
  assert.equal(enforce.droppedCount, 1);
});

// ── Was passieren darf ───────────────────────────────────────────────────

test("eigener, globaler und Familien-Scope passieren — auch in anderer Schreibweise", () => {
  const hits = [
    hit({ scope: "BASTRA-Recall" }), // #360: Schreibweise ist keine Fremdheit
    hit({ scope: "all-projects" }),
    hit({ scope: "user-preference" }),
    hit({ scope: "taxonomy" }),
    hit({ scope: "bastra" }), // Familie: deckt bastra-recall
  ];
  const r = applyLaneScopeFilter(hits, "bastra-recall", TODO_OPTS, "enforce");
  assert.equal(r.hits.length, 5);
  assert.equal(r.droppedCount, 0);
});

test("Reflex-Treffer passieren immer — sie sind vom User verdrahtet", () => {
  const hits = [hit({ scope: "carnexus", recall_mode: "reflex", score: 55 })];
  const r = applyLaneScopeFilter(hits, "bastra-recall", TODO_OPTS, "enforce");
  assert.equal(r.hits.length, 1);
  assert.equal(r.droppedCount, 0);
});

// ── Prompt- gegen Todo-Lane ──────────────────────────────────────────────

test("Prompt-Lane lässt den starken, absichtlichen Cross-Scope-Anker durch", () => {
  const anchored = hit({
    scope: "bastra-io",
    score: 150,
    matched_recall_when: true,
    anchor_strength: "strong",
  });
  const r = applyLaneScopeFilter([anchored], "bastra-recall", PROMPT_OPTS, "enforce");
  assert.equal(r.hits.length, 1);
});

test("Todo-Lane lässt ihn NICHT durch — sie fragt nach Fakten fürs eigene Projekt", () => {
  const anchored = hit({
    scope: "bastra-io",
    score: 150,
    matched_recall_when: true,
    anchor_strength: "strong",
  });
  const r = applyLaneScopeFilter([anchored], "bastra-recall", TODO_OPTS, "enforce");
  assert.equal(r.hits.length, 0);
  assert.deepEqual(r.droppedScopes, ["bastra-io"]);
});

test("schwacher Anker passiert auch in der Prompt-Lane nicht", () => {
  const weak = hit({
    scope: "bastra-io",
    score: 159, // der #110-Rauschtreffer kam mit genau so einem Score durch
    matched_recall_when: true,
    anchor_strength: "weak",
  });
  const r = applyLaneScopeFilter([weak], "bastra-recall", PROMPT_OPTS, "enforce");
  assert.equal(r.hits.length, 0);
});

// ── unfused ──────────────────────────────────────────────────────────────

test("ohne Fusion ist die Cross-Scope-Ausnahme zu — fail-closed, mangels Signal", () => {
  const anchored = hit({
    scope: "bastra-io",
    score: 98765, // rohe BM25-Skala: jede Schwelle ist bedeutungslos
    matched_recall_when: true,
    anchor_strength: "strong",
  });
  const r = applyLaneScopeFilter(
    [anchored],
    "bastra-recall",
    { ...PROMPT_OPTS, unfused: true },
    "enforce",
  );
  assert.equal(r.hits.length, 0);
  // Der eigene Scope bleibt davon unberührt — fail-closed gilt nur für fremde.
  const own = applyLaneScopeFilter(
    [hit({ scope: "bastra-recall", score: 98765 })],
    "bastra-recall",
    { ...PROMPT_OPTS, unfused: true },
    "enforce",
  );
  assert.equal(own.hits.length, 1);
});

test("ohne erkanntes Projekt filtert nichts", () => {
  const hits = [hit({ scope: "carnexus" }), hit({ scope: "bastra-io" })];
  const r = applyLaneScopeFilter(hits, null, TODO_OPTS, "enforce");
  assert.equal(r.hits.length, 2);
  assert.equal(r.droppedCount, 0);
});

// ── projectForFilter: wann ein Name überhaupt filtern darf ───────────────

test("projectForFilter: nur ein erkanntes Repo-Wurzelsegment darf filtern", () => {
  assert.equal(projectForFilter("/Users/x/Projekte/bastra-recall"), "bastra-recall");
  assert.equal(projectForFilter("/Users/x/projects/CarNexus"), "carnexus"); // key, nie raw
  assert.equal(projectForFilter("/Users/x/Projekte/bastra-recall/packages/daemon"), "bastra-recall");
  // Geraten — der Fallback gab hier "core" zurück und sah aus wie Erkennung.
  assert.equal(projectForFilter("/tmp/worktree/packages/core"), null);
  assert.equal(projectForFilter("/Users/x/Desktop"), null);
  assert.equal(projectForFilter(""), null);
});

test("projectConfidence: die Güte steht für die Telemetrie zur Verfügung", () => {
  assert.equal(projectConfidence("/Users/x/Projekte/bastra-recall"), "root-match");
  assert.equal(projectConfidence("/tmp/worktree/packages/core"), "fallback");
  assert.equal(projectConfidence(""), "none");
});

test("ein geratenes Projekt filtert nichts weg — fail-open, nicht falsch streng", () => {
  const hits = [hit({ scope: "bastra-recall" }), hit({ scope: "carnexus" })];
  const guessed = projectForFilter("/tmp/worktree/packages/core");
  const r = applyLaneScopeFilter(hits, guessed, TODO_OPTS, "enforce");
  assert.equal(r.hits.length, 2);
  assert.equal(r.droppedCount, 0);
});

// ── Beleg-Schutz ─────────────────────────────────────────────────────────

/**
 * Codex-Gegenreview: `root-match` heißt nur „ein Pfadsegment hieß
 * workspace/src/code". `/workspace/packages/core` liefert das Filterprojekt
 * "packages" mit voller Zuversicht — und ein scharfer Filter hätte damit
 * erneut das ganze eigene Projektgedächtnis entfernt.
 */
test("der Vault kennt das Projekt nicht → es darf nichts verwerfen", () => {
  // Das ist die Lage bei cwd=/workspace/packages/core: der Filter hieße
  // "packages", und der Vault kennt keinen solchen Scope.
  const hits = [hit({ scope: "bastra-recall" }), hit({ scope: "carnexus" })];
  const r = applyLaneScopeFilter(
    hits,
    "packages",
    { ...TODO_OPTS, projectKnown: false },
    "enforce",
  );
  assert.equal(r.hits.length, 2);
  assert.equal(r.droppedCount, 0);
  assert.equal(r.skipped, "no-scope-evidence");
  assert.equal(r.filterProject, null);
});

/**
 * Fehlt `project_known` — älterer Daemon, fremder Aufrufer —, fällt der Filter
 * auf den schwächeren Beleg aus der Ergebnisliste zurück. Strenger darf er an
 * einem unbekannten Feld nie werden.
 */
test("Rückfall ohne project_known: der Beleg kommt aus der Ergebnisliste", () => {
  const noSignal = { ...TODO_OPTS, projectKnown: undefined };
  const hits = [hit({ scope: "bastra-recall" }), hit({ scope: "carnexus" })];
  assert.equal(
    applyLaneScopeFilter(hits, "packages", noSignal, "enforce").skipped,
    "no-scope-evidence",
  );
  // Ein eigener Treffer in der Liste belegt — dann filtert auch der Rückfall.
  assert.equal(applyLaneScopeFilter(hits, "bastra-recall", noSignal, "enforce").droppedCount, 1);
});

test("globale Scopes sind KEIN Beleg — sie passen zu jedem erfundenen Namen", () => {
  const hits = [
    hit({ scope: "all-projects" }),
    hit({ scope: "user-preference" }),
    hit({ scope: "bastra-recall" }), // der einzige, der weggeworfen würde
  ];
  const r = applyLaneScopeFilter(
    hits,
    "packages",
    { ...TODO_OPTS, projectKnown: undefined },
    "enforce",
  );
  assert.equal(r.hits.length, 3);
  assert.equal(r.skipped, "no-scope-evidence");
});

test("vaultKnowsProject: Familie zählt, globale Scopes nicht", () => {
  const vault = (scopes: string[]) => ({ list: () => scopes.map((s) => ({ fm: { scope: s } })) });
  assert.equal(vaultKnowsProject(vault(["bastra-recall", "carnexus"]), "bastra-recall"), true);
  assert.equal(vaultKnowsProject(vault(["bastra"]), "bastra-recall"), true); // Familie
  assert.equal(vaultKnowsProject(vault(["CarNexus"]), "carnexus"), true); // #360: gefaltet
  assert.equal(vaultKnowsProject(vault(["bastra-recall"]), "packages"), false);
  // Ein Vault, der nur globale Scopes hat, belegt keinen Projektnamen.
  assert.equal(vaultKnowsProject(vault(["all-projects", "user-preference"]), "packages"), false);
});

test("ein einziger eigener Treffer genügt als Beleg — dann greift der Filter", () => {
  const hits = [hit({ scope: "bastra-recall" }), hit({ scope: "carnexus" })];
  const r = applyLaneScopeFilter(hits, "bastra-recall", TODO_OPTS, "enforce");
  assert.equal(r.hits.length, 1);
  assert.equal(r.droppedCount, 1);
  assert.equal(r.filterProject, "bastra-recall");
  assert.equal(r.skipped, undefined);
});

test("ein Familien-Treffer belegt ebenfalls", () => {
  const hits = [hit({ scope: "bastra" }), hit({ scope: "carnexus" })];
  const r = applyLaneScopeFilter(hits, "bastra-recall", TODO_OPTS, "enforce");
  assert.equal(r.hits.length, 1);
  assert.deepEqual(r.droppedScopes, ["carnexus"]);
});

test("ohne Projekt: filterProject bleibt null und der Grund steht dabei", () => {
  const r = applyLaneScopeFilter([hit({ scope: "carnexus" })], null, TODO_OPTS, "enforce");
  assert.equal(r.skipped, "no-project");
  assert.equal(r.filterProject, null);
});

// ── Projekterkennung: der nächstgelegene Git-Root ────────────────────────

/**
 * Codex-Gegenreview: `root-match` nahm das ERSTE Container-Segment und lag
 * damit bei jeder verschachtelten Struktur falsch —
 * `/Users/me/Projects/company/repos/real-repo/…` ergab "company", mit voller
 * Zuversicht. Ein scharfer Filter entfernt dann die Memories von `real-repo`.
 */
test("projectForFilter: der nächstgelegene .git-Ordner gewinnt gegen die Heuristik", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "gitroot-"));
  try {
    // .../Projects/company/repos/real-repo/packages/core, .git bei real-repo
    const repo = join(root, "Projects", "company", "repos", "real-repo");
    const deep = join(repo, "packages", "core");
    await mkdir(deep, { recursive: true });
    await writeFile(join(repo, ".git"), "gitdir: anderswo\n"); // Worktree-Form: eine DATEI

    assert.equal(projectForFilter(deep), "real-repo");
    assert.equal(projectConfidence(deep), "git-root");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projectForFilter: ohne .git bleibt die Container-Heuristik der Rückfall", () => {
  // Ein Pfad, den es auf dieser Maschine nicht gibt — kein .git zu finden.
  assert.equal(projectForFilter("/nirgendwo/Projekte/mein-projekt/packages/x"), "mein-projekt");
  assert.equal(projectConfidence("/nirgendwo/Projekte/mein-projekt"), "root-match");
  assert.equal(projectForFilter("/nirgendwo/tmp/worktree/packages/core"), null);
});
