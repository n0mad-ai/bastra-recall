/**
 * Tests für Valenz + Reflex (#217): salience/emotion/recall_mode am
 * Save-Pfad — absent by default, explizit gesetzt, Overwrite ohne Angabe
 * erhält Bestandswerte (wie write_origin), salience 0 wird nicht
 * verschluckt. Plus: hohe Salience verlangsamt computeStaleness.
 *
 * Runner: `tsx --test __tests__/valence.test.ts`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { saveMemory } from "../src/save.js";
import { Vault } from "../src/vault.js";
import { SearchIndex, computeStaleness, salienceRankCap } from "../src/search.js";

const input = (over: Record<string, unknown> = {}) => ({
  title: "Valence probe",
  type: "lesson" as const,
  summary: "Valence plumbing probe for salience/emotion/recall_mode.",
  body: "Probe body. **Why:** test. **How to apply:** in tests.",
  topic_path: ["test", "valence"],
  tags: ["valence"],
  scope: "valence-test",
  recall_when: ["running the valence plumbing test"],
  ...over,
});

async function fmOf(filePath: string): Promise<Record<string, unknown>> {
  return matter(await readFile(filePath, "utf8")).data as Record<string, unknown>;
}

test("valence: absent by default, explicit values persist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-valence-"));
  try {
    const plain = await saveMemory(dir, input({ id: "plain-probe" }));
    const plainFm = await fmOf(plain.file_path);
    assert.equal(plainFm.salience, undefined);
    assert.equal(plainFm.emotion, undefined);
    assert.equal(plainFm.recall_mode, undefined);

    const charged = await saveMemory(
      dir,
      input({ id: "charged-probe", salience: 0.8, emotion: "frustration", recall_mode: "reflex" }),
    );
    const chargedFm = await fmOf(charged.file_path);
    assert.equal(chargedFm.salience, 0.8);
    assert.equal(chargedFm.emotion, "frustration");
    assert.equal(chargedFm.recall_mode, "reflex");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("valence: overwrite without fields preserves existing values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-valence-"));
  try {
    await saveMemory(
      dir,
      input({ id: "keep-probe", salience: 0.7, emotion: "success", recall_mode: "reflex" }),
    );
    const refreshed = await saveMemory(
      dir,
      input({ id: "keep-probe", summary: "Refreshed valence probe body text.", overwrite: true }),
    );
    const fm = await fmOf(refreshed.file_path);
    assert.equal(fm.salience, 0.7);
    assert.equal(fm.emotion, "success");
    assert.equal(fm.recall_mode, "reflex");

    // explizite Werte gewinnen beim Overwrite
    const reclassified = await saveMemory(
      dir,
      input({ id: "keep-probe", salience: 0.2, emotion: "neutral", overwrite: true }),
    );
    const fm2 = await fmOf(reclassified.file_path);
    assert.equal(fm2.salience, 0.2);
    assert.equal(fm2.emotion, "neutral");
    assert.equal(fm2.recall_mode, "reflex");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("valence: salience 0 is written and survives overwrite (no truthy swallow)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-valence-"));
  try {
    const zero = await saveMemory(dir, input({ id: "zero-probe", salience: 0 }));
    assert.equal((await fmOf(zero.file_path)).salience, 0);

    const refreshed = await saveMemory(
      dir,
      input({ id: "zero-probe", summary: "Refreshed zero salience probe.", overwrite: true }),
    );
    assert.equal((await fmOf(refreshed.file_path)).salience, 0);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function memoryMarkdown(id: string, salience?: number): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: quokka handling`,
    "type: lesson",
    "summary: quokka handling summary",
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: valence-rank-test",
    "recall_when:",
    "  - quokka handling",
    ...(salience != null ? [`salience: ${salience}`] : []),
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    "Body for quokka handling.",
    "",
  ].join("\n");
}

async function makeIndex(): Promise<{ search: SearchIndex; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-valence-rank-"));
  await writeFile(join(dir, "plain.md"), memoryMarkdown("quokka-plain"), "utf8");
  await writeFile(join(dir, "hot.md"), memoryMarkdown("quokka-hot", 1), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  return {
    search,
    close: async () => {
      search.stop();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

test("ranking: salience is score-neutral by default (shadow-first, #217)", async () => {
  const { search, close } = await makeIndex();
  try {
    const hits = search.recall("quokka handling");
    const plain = hits.find((h) => h.id === "quokka-plain");
    const hot = hits.find((h) => h.id === "quokka-hot");
    assert.ok(plain && hot);
    assert.equal(hot.score, plain.score, "without BASTRA_SALIENCE_RANK=live salience must not move scores");
  } finally {
    await close();
  }
});

test("ranking: BASTRA_SALIENCE_RANK=live applies the bounded multiplier", async () => {
  process.env.BASTRA_SALIENCE_RANK = "live";
  const { search, close } = await makeIndex();
  try {
    const hits = search.recall("quokka handling");
    const plain = hits.find((h) => h.id === "quokka-plain");
    const hot = hits.find((h) => h.id === "quokka-hot");
    assert.ok(plain && hot);
    const expected = Math.round(plain.score * (1 + salienceRankCap()) * 1000) / 1000;
    assert.equal(hot.score, expected, "salience 1 must boost by exactly 1 + cap");
    assert.ok(hot.score > plain.score);
  } finally {
    delete process.env.BASTRA_SALIENCE_RANK;
    await close();
  }
});

test("staleness: high salience slows aging (#217)", () => {
  // project-fact default: 90d. 120d seit updated → ratio 1.33 = "stale";
  // mit salience 1 verdoppelt sich die Lebensdauer → ratio 0.67 = "fresh";
  // mit salience 0.5 → 135d Lebensdauer, ratio 0.89 = "aging".
  const now = new Date("2026-07-18T00:00:00Z");
  const base = {
    type: "project-fact",
    updated: "2026-03-20", // 120 Tage vor now
  };
  assert.equal(computeStaleness(base, now), "stale");
  assert.equal(computeStaleness({ ...base, salience: 1 }, now), "fresh");
  assert.equal(computeStaleness({ ...base, salience: 0.5 }, now), "aging");
  // salience 0 ändert nichts
  assert.equal(computeStaleness({ ...base, salience: 0 }, now), "stale");
});

test("staleness #365/14: ein unbekanntes touch sagt mit und ohne valid_until dasselbe", () => {
  // `touch` = max(updated, last_reviewed_at); ist keines davon parsebar, ist es
  // 0 = Unix-Epoche. Der Zweig OHNE valid_until fängt das ab (touch <= 0 →
  // fresh), der Zweig MIT valid_until rechnete elapsed/total gegen 1970 und
  // landete damit für jedes Ablaufdatum nahe heute bei ≈0.99 → "aging".
  const now = new Date("2026-08-23T00:00:00Z");
  const soon = "2026-12-31";

  for (const [label, base] of [
    ["unparsebares updated", { type: "lesson", updated: "irgendwann letztens" }],
    ["fehlendes updated", { type: "lesson" }],
  ] as const) {
    assert.equal(computeStaleness(base, now), "fresh", `${label}: ohne valid_until`);
    assert.equal(
      computeStaleness({ ...base, valid_until: soon }, now),
      "fresh",
      `${label}: mit valid_until muss dasselbe sagen`,
    );
  }

  // Gegenproben: der valid_until-Zweig rechnet weiter, wenn touch bekannt ist,
  // und ein abgelaufenes Datum bleibt expired — auch ohne touch.
  assert.equal(
    computeStaleness({ type: "lesson", updated: "2026-08-01", valid_until: "2026-08-25" }, now),
    "aging",
    "bekanntes touch: 22 von 24 Tagen verbraucht = 0.92 ≥ 0.75",
  );
  assert.equal(
    computeStaleness({ type: "lesson", updated: "2026-08-01", valid_until: "2026-09-30" }, now),
    "fresh",
  );
  assert.equal(
    computeStaleness({ type: "lesson", valid_until: "2026-01-01" }, now),
    "expired",
    "ein abgelaufenes valid_until gewinnt vor dem touch-Guard",
  );
});
