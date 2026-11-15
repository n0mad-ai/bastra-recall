/**
 * #300 — a trigger collision is another memory DECLARING the same situation,
 * not another memory that happens to rank.
 *
 * The scan filtered `search.recall()` hits by an absolute score floor. BM25 is
 * additive and query-dependent, so inside one scan the score spans orders of
 * magnitude and `>= 30` passes all but the tail: on a 661-memory vault the
 * reported count was a median 69% of the admitted pool and fired on 97% of
 * scans, citing memories with no topical relation. Making the cut relative to
 * the pool's distribution does not fix it either — the top of a ranking is
 * populated whether or not anything collides.
 *
 * The decision now runs on the authored triggers themselves: another memory
 * collides when one of ITS `recall_when` phrases contains every content word of
 * this one. BM25 stays the candidate generator (#239), it no longer judges.
 *
 * Runner: `tsx --test __tests__/save-quality-trigger-collisions.test.ts`
 * Real file vault, no mocking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { scoreSaveQuality } from "../src/save-quality.js";
import type { ToolDeps } from "../src/tool-deps.js";

const SCOPE = "collision-300";

function memoryFile(id: string, summary: string, recallWhen: string[]): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${id} Ablage`,
    "type: decision",
    `summary: ${summary}`,
    "topic_path:",
    "  - ablage",
    "tags:",
    `  - ${id}-thema`,
    `scope: ${SCOPE}`,
    "recall_when:",
    ...recallWhen.map((t) => `  - ${t}`),
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `Notiz ${id} zur Ablage.`,
    "",
  ].join("\n");
}

/** The save under test — only `recall_when` varies between cases. */
function saveInput(recallWhen: string[]) {
  return {
    title: "Vault-Pfad und Watcher",
    type: "decision",
    summary: "Wo der Vault liegt und wie der Watcher ihn beobachtet.",
    body: "Der Vault-Pfad wird beim Start gelesen und danach überwacht.",
    topic_path: ["ablage"],
    tags: ["vault-pfad"],
    scope: SCOPE,
    recall_when: recallWhen,
  } as Parameters<typeof scoreSaveQuality>[1];
}

async function makeVault(
  files: Array<[string, string, string[]]>
): Promise<{ deps: ToolDeps; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-collision-300-"));
  for (const [id, summary, recallWhen] of files) {
    await writeFile(join(dir, `${id}.md`), memoryFile(id, summary, recallWhen), "utf8");
  }
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: dir };
  return {
    deps,
    close: async () => {
      search.stop();
      await vault.stop?.();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

/**
 * The reported shape: one scope whose members all talk about the same
 * subsystem, so every trigger retrieves nearly all of them — and not one of
 * them declares the same situation.
 */
const SHARED_VOCABULARY: Array<[string, string, string[]]> = Array.from({ length: 12 }, (_, i) => [
  `neighbour${i}`,
  `Entscheidung ${i}: der Vault liegt in der Cloud, lokal gespiegelt, der Watcher beobachtet den Pfad.`,
  [`Ablageort ${i} der Notizen im Team klären`],
]);

test("#300: a trigger that merely retrieves the scope is not a collision", async (t) => {
  const { deps, close } = await makeVault(SHARED_VOCABULARY);
  t.after(close);

  const trigger = "Vorschlag den Vault lokal statt in die Cloud zu legen";

  // Precondition: BM25 hands the whole pool to the scan. Without it the test
  // could pass on an empty candidate set and prove nothing.
  //
  // Note what this fixture deliberately does NOT reproduce: the raw score the
  // old criterion cut on has no fixed scale, so the pool only clears an
  // absolute floor of 30 once the surrounding index is large enough for IDF to
  // lift it (on the reporter's 661-memory vault these same neighbours scored
  // 800–1900; here they score 0.3). That corpus dependence is the defect —
  // a fixture cannot hold it still, so the guard here is the candidate set.
  const raw = deps.search.recall(trigger, { k: 20, scope: SCOPE, type: "decision" });
  assert.ok(
    raw.length >= SHARED_VOCABULARY.length,
    `precondition: the scan must receive the pool as candidates, got ${raw.length}`
  );

  const quality = scoreSaveQuality(deps, saveInput([trigger]), "vault-path-watcher-decision");
  assert.deepEqual(
    quality.trigger_collisions,
    [],
    `no neighbour declares this situation, got ${JSON.stringify(quality.trigger_collisions)}`
  );
  assert.ok(
    !quality.issues.some((i) => i.startsWith("trigger collision")),
    `the advisory must stay silent, got ${JSON.stringify(quality.issues)}`
  );
});

test("#300: a memory declaring the same trigger IS reported, and names its own phrase", async (t) => {
  const trigger = "Vorschlag den Vault lokal statt in die Cloud zu legen";
  const { deps, close } = await makeVault([
    ...SHARED_VOCABULARY,
    [
      "twin",
      "Lange, inhaltlich eigenständige Notiz über Backups, Verschlüsselung, Aufbewahrungsfristen und Wiederherstellung.",
      [trigger],
    ],
  ]);
  t.after(close);

  const quality = scoreSaveQuality(deps, saveInput([trigger]), "vault-path-watcher-decision");
  assert.equal(quality.trigger_collisions.length, 1);
  const collision = quality.trigger_collisions[0];
  assert.equal(collision.count, 1, "exactly one memory declares it");
  assert.deepEqual(collision.examples, ["twin"]);
  assert.equal(collision.claim, trigger, "the colliding memory's own phrase must be reported");
  assert.equal(collision.admitted_pool, SHARED_VOCABULARY.length + 1);
  assert.ok(
    quality.suggestions.some((s) => s.includes("load_memory('twin')")),
    `the suggestion must point at the colliding memory, got ${JSON.stringify(quality.suggestions)}`
  );
  assert.ok(quality.score < 100, "a taken trigger has to cost something");
});

test("#300: containment is directional — a broader trigger collides with the narrower one", async (t) => {
  const { deps, close } = await makeVault([
    ...SHARED_VOCABULARY,
    [
      "narrower",
      "The watcher polls because the cloud mount drops events.",
      ["Vault-Pfad überwachen wenn der Cloud-Mount keine Events liefert"],
    ],
  ]);
  t.after(close);

  // Every content word of this trigger appears in the narrower one, so whenever
  // this situation occurs the other memory is on the table too.
  const broader = scoreSaveQuality(deps, saveInput(["Vault-Pfad überwachen"]), "vault-path-watcher-decision");
  assert.deepEqual(
    broader.trigger_collisions.map((c) => c.examples[0]),
    ["narrower"],
    "the broader trigger must report the narrower memory"
  );
  // Nothing else fires on this save, so the score is the collision penalty
  // alone: 12 per taken trigger, capped at 30.
  assert.deepEqual(broader.duplicate_candidates, []);
  assert.equal(broader.score, 100 - 12, `issues: ${JSON.stringify(broader.issues)}`);

  // The reverse is that memory's problem, not this save's: the narrower phrase
  // says things no trigger here claims.
  const narrower = scoreSaveQuality(
    deps,
    saveInput(["Vault-Pfad überwachen wenn der Mount unter Last keine Events mehr liefert"]),
    "vault-path-watcher-decision"
  );
  assert.deepEqual(narrower.trigger_collisions, []);
});

test("#300: words spread across two of a memory's triggers do not add up to a claim", async (t) => {
  const { deps, close } = await makeVault([
    ...SHARED_VOCABULARY,
    [
      "split",
      "Two separate situations, deliberately kept apart.",
      ["Vault-Pfad auslesen beim Start", "Watcher-Verhalten auf dem Cloud-Mount beurteilen"],
    ],
  ]);
  t.after(close);

  // "Vault-Pfad" + "Watcher" exist in that memory — but in different triggers,
  // so neither of them declares this situation.
  const quality = scoreSaveQuality(deps, saveInput(["Vault-Pfad Watcher"]), "vault-path-watcher-decision");
  assert.deepEqual(
    quality.trigger_collisions,
    [],
    `shared vocabulary across separate triggers is not a claim, got ${JSON.stringify(quality.trigger_collisions)}`
  );
});

test("#300: the memory's other triggers stay unaffected when one of them collides", async (t) => {
  const taken = "Arbeit an einem Issue abgeschlossen";
  const { deps, close } = await makeVault([...SHARED_VOCABULARY, ["twin", "How finished issues get closed.", [taken]]]);
  t.after(close);

  const quality = scoreSaveQuality(
    deps,
    saveInput([taken, "Windows-Portierung oder plattformabhängige Pfadlogik planen"]),
    "vault-path-watcher-decision"
  );
  assert.deepEqual(
    quality.trigger_collisions.map((c) => c.trigger),
    [taken],
    "only the taken trigger is reported — the other one has no claimant"
  );
});

// ─── #325: umlaut folding on the similarity path ────────────────────────────

test("#325: ä and ae are the same trigger — the spelling is not the situation", async (t) => {
  // Both spellings occur inside one real vault: one was typed, the other came
  // from a keyboard layout or a paste. Before folding these scored 0.80 and
  // stayed invisible, because ä and ae were two tokens.
  const { deps, close } = await makeVault([
    ["twin", "Der letzte Stand des Threads.", ["naechste Nachricht an zzalli entwerfen"]],
  ]);
  t.after(close);

  const quality = scoreSaveQuality(
    deps,
    saveInput(["nächste Nachricht an zzalli entwerfen"]),
    "vault-path-watcher-decision"
  );
  assert.deepEqual(
    quality.trigger_collisions.map((c) => c.trigger),
    ["nächste Nachricht an zzalli entwerfen"],
    `the ae-spelling claims the same situation, got ${JSON.stringify(quality.trigger_collisions)}`
  );
});

test("#325: folding does not smuggle German function words past the stopword list", async (t) => {
  // The trap this fix could have introduced: fold "für" to "fuer" and the
  // stopword lookup misses it, so a function word starts carrying signal and
  // any two German notes begin to look alike — the failure STOPWORDS exists to
  // prevent. A trigger of nothing but function words has no content at all and
  // can never claim a situation.
  const { deps, close } = await makeVault([
    ["twin", "Ablage für den Watcher.", ["für den Watcher und über die Ablage"]],
  ]);
  t.after(close);

  const quality = scoreSaveQuality(deps, saveInput(["für über"]), "vault-path-watcher-decision");
  assert.deepEqual(
    quality.trigger_collisions,
    [],
    `function words carry no claim, got ${JSON.stringify(quality.trigger_collisions)}`
  );
});
