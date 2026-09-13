/**
 * #447: Gold-Datei und Label-Datei dürfen nicht unbemerkt auseinanderlaufen.
 *
 * Der Befund: `--check` prüfte die LABEL-Datei gegen die STAGED-Datei und sah
 * die zuvor daraus gemergte Gold-Datei nie an. Ein nach dem Merge geändertes
 * Label ließ die Gold-Datei auf dem alten Stand, jedes Werkzeug meldete
 * Erfolg, und die Abweichung wurde erst sichtbar, als ein Re-Merge sie still
 * in den Messpfad zog. Eine Gold-Datei ist Release-Evidenz — eine veraltete
 * Paarung muss ein Kommando rot machen.
 *
 * Run: npx tsx --test packages/eval/__tests__/goldset-drift.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkGoldAgainstLabels, mergeCases } from "../src/goldset-label.js";
import {
  detectLang,
  hasIdentifier,
  originRefHash,
  stagedId,
  type GoldLabel,
  type StagedQuery,
} from "../src/goldset.js";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "goldset-label.ts");
const run = promisify(execFile);

const QUERY = "wie war die regel für force pushes";

function stagedQuery(): StagedQuery {
  return {
    id: stagedId(QUERY),
    query: QUERY,
    origin_type: "user_query",
    authoring_mode: "verbatim from a real recall",
    origin_ref_hash: originRefHash("ref"),
    lang: detectLang(QUERY),
    has_identifier: hasIdentifier(QUERY),
  };
}

function labelFor(s: StagedQuery, over: Partial<GoldLabel> = {}): GoldLabel {
  return {
    staged_id: s.id,
    expected_ids: ["m1"],
    acceptable_alternatives: [],
    expected_zone: "orbit",
    no_answer: false,
    scope: null,
    time_view: null,
    allowed_retrieval_depth: 10,
    rationale: "m1 is the only memory stating this rule",
    kind: "descriptive",
    labelled_at: "2026-07-26",
    labelled_by: "Daniel",
    ...over,
  };
}

const PROVENANCE = {
  staged: "staged.json",
  labels: "labels.json",
  staged_sha256: "a".repeat(64),
  labels_sha256: "b".repeat(64),
};

test("#447: a gold file merged from an older label state is reported as drifted", () => {
  const s = stagedQuery();
  const merged = mergeCases([s], [labelFor(s)]);
  // Genau der Fall aus #418: Die Label-Datei bekam nachträglich eine
  // `acceptable_alternatives`-id, die Gold-Datei nicht.
  const nowLabelled = mergeCases([s], [labelFor(s, { acceptable_alternatives: ["pref-erfunden"] })]);
  const issues = checkGoldAgainstLabels({ cases: merged }, nowLabelled, PROVENANCE);
  assert.equal(issues.length, 1);
  assert.match(issues[0].problem, /acceptable_alternatives/);
});

test("#447: a matching pair passes — the check does not simply reject everything", () => {
  const s = stagedQuery();
  const merged = mergeCases([s], [labelFor(s)]);
  assert.deepEqual(checkGoldAgainstLabels({ cases: merged }, merged, PROVENANCE), []);
});

test("#447: a case added or removed on either side is named", () => {
  const s = stagedQuery();
  const merged = mergeCases([s], [labelFor(s)]);
  assert.match(
    checkGoldAgainstLabels({ cases: [] }, merged, PROVENANCE)[0].problem,
    /missing from the merged gold/,
  );
  assert.match(
    checkGoldAgainstLabels({ cases: merged }, [], PROVENANCE)[0].problem,
    /no longer labelled/,
  );
});

test("#447: a gold file from a different batch entirely is rejected, not silently accepted", () => {
  // „Eine Seite ersetzt": `--gold` zeigt auf ein Gold aus einer anderen Charge.
  // Beide Dateien sind für sich gültig, die Paarung ist es nicht.
  const s = stagedQuery();
  const other: StagedQuery = { ...s, id: stagedId("ganz andere frage"), query: "ganz andere frage" };
  const issues = checkGoldAgainstLabels(
    { cases: mergeCases([other], [labelFor(other)]) },
    mergeCases([s], [labelFor(s)]),
    PROVENANCE,
  );
  assert.equal(issues.length, 2, "beide Richtungen werden gemeldet");
  assert.ok(issues.some((i) => /missing from the merged gold/.test(i.problem)));
  assert.ok(issues.some((i) => /no longer labelled/.test(i.problem)));
});

test("#447: a staged file changed since the merge is caught too", () => {
  const s = stagedQuery();
  const merged = mergeCases([s], [labelFor(s)]);
  const issues = checkGoldAgainstLabels(
    { cases: merged, merged_from: { ...PROVENANCE, staged_sha256: "d".repeat(64) } },
    merged,
    PROVENANCE,
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0].problem, /staged file changed since the merge/);
});

test("#447: a gold file written before #447 has no provenance — the case comparison still applies", () => {
  // Altbestand darf nicht pauschal durchfallen, aber auch nicht pauschal
  // durchgehen: ohne `merged_from` entfällt nur die Hash-Prüfung.
  const s = stagedQuery();
  const merged = mergeCases([s], [labelFor(s)]);
  assert.deepEqual(checkGoldAgainstLabels({ cases: merged }, merged, PROVENANCE), []);
  const drifted = checkGoldAgainstLabels(
    { cases: merged },
    mergeCases([s], [labelFor(s, { expected_ids: ["m2"] })]),
    PROVENANCE,
  );
  assert.equal(drifted.length, 1);
  assert.match(drifted[0].problem, /expected_ids/);
});

test("#447: a label change that touches no case is still caught by the recorded hash", () => {
  // Ein Label-Feld, das gar nicht in den Fall wandert, kann sich ändern, ohne
  // dass ein einziger Fall abweicht. Dann behauptet die Gold-Datei weiterhin,
  // aus einem Stand zu stammen, den es nicht mehr gibt.
  const s = stagedQuery();
  const merged = mergeCases([s], [labelFor(s)]);
  const issues = checkGoldAgainstLabels(
    { cases: merged, merged_from: { ...PROVENANCE, labels_sha256: "c".repeat(64) } },
    merged,
    PROVENANCE,
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0].problem, /label file changed since the merge/);
});

// ── Das Kommando selbst: wird es rot? ───────────────────────────

async function cli(args: string[]): Promise<{ code: number; err: string }> {
  try {
    const { stderr } = await run(process.execPath, ["--import", "tsx", TOOL, ...args]);
    return { code: 0, err: stderr };
  } catch (e) {
    const x = e as { code?: number; stderr?: string };
    return { code: x.code ?? 1, err: x.stderr ?? "" };
  }
}

test("#447: `--check` goes red on a deliberately twisted pairing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bastra-447-"));
  const staged = join(dir, "staged.json");
  const labels = join(dir, "labels.json");
  const gold = join(dir, "gold.json");
  const s = stagedQuery();
  writeFileSync(staged, JSON.stringify({ schema_version: 1, staged: [s] }, null, 2));
  writeFileSync(labels, JSON.stringify({ schema_version: 1, labels: [labelFor(s)] }, null, 2));

  const merged = await cli(["--merge", "--staged", staged, "--labels", labels, "--out", gold]);
  assert.equal(merged.code, 0, merged.err);
  assert.match(
    JSON.parse(readFileSync(gold, "utf8")).merged_from.labels,
    /labels\.json/,
    "the gold file records which label state it was merged from",
  );

  const clean = await cli(["--check", "--staged", staged, "--labels", labels, "--gold", gold]);
  assert.equal(clean.code, 0, `a fresh pairing must stay green:\n${clean.err}`);

  // Jetzt driften lassen: eine id ergänzen, die im Vault nirgends existiert.
  writeFileSync(
    labels,
    JSON.stringify(
      {
        schema_version: 1,
        labels: [labelFor(s, { acceptable_alternatives: ["pref-no-backend-kill-or-bg-restart"] })],
      },
      null,
      2,
    ),
  );

  const drifted = await cli(["--check", "--staged", staged, "--labels", labels, "--gold", gold]);
  assert.equal(drifted.code, 1, `a stale pairing must fail:\n${drifted.err}`);
  assert.match(drifted.err, /has drifted from/);
  assert.match(drifted.err, /acceptable_alternatives/);
});

test("#447: `--check` goes red on every drift shape that really happens", async () => {
  // Der Gegenreview-Punkt: Ein Test, der nur die korrekte Paarung grün zeigt,
  // fängt den Befund nicht. Jede Drift-Art bekommt hier ihren eigenen roten
  // Lauf — Labels geändert, Gold aus anderen Labels neu gemergt, eine Seite
  // durch eine fremde Charge ersetzt, Staged nachträglich verändert, und eine
  // Label-Datei, die neu geschrieben wurde, ohne einen Fall zu berühren.
  const dir = mkdtempSync(join(tmpdir(), "bastra-447-shapes-"));
  const staged = join(dir, "staged.json");
  const labels = join(dir, "labels.json");
  const gold = join(dir, "gold.json");
  const s = stagedQuery();

  const writeStaged = (rows: StagedQuery[], indent = 2): void =>
    writeFileSync(staged, JSON.stringify({ schema_version: 1, staged: rows }, null, indent));
  const writeLabels = (rows: GoldLabel[], indent = 2): void =>
    writeFileSync(labels, JSON.stringify({ schema_version: 1, labels: rows }, null, indent));
  const check = (): Promise<{ code: number; err: string }> =>
    cli(["--check", "--staged", staged, "--labels", labels, "--gold", gold]);

  writeStaged([s]);
  writeLabels([labelFor(s)]);
  const merged = await cli(["--merge", "--staged", staged, "--labels", labels, "--out", gold]);
  assert.equal(merged.code, 0, merged.err);
  const pristineGold = readFileSync(gold, "utf8");
  const pristineLabels = readFileSync(labels, "utf8");
  assert.equal((await check()).code, 0, "die Gegenprobe: die frische Paarung ist grün");

  // (1) Label nachträglich geändert.
  writeLabels([labelFor(s, { expected_ids: ["m2"] })]);
  let r = await check();
  assert.equal(r.code, 1, `edited label must fail:\n${r.err}`);
  assert.match(r.err, /expected_ids/);

  // (2) Gold aus ANDEREN Labels neu gemergt, die Label-Datei bleibt alt.
  writeFileSync(labels, pristineLabels);
  await cli(["--merge", "--staged", staged, "--labels", labels, "--out", gold]);
  writeLabels([labelFor(s, { no_answer: false, rationale: "eine andere Begründung" })]);
  r = await check();
  assert.equal(r.code, 1, `re-merged gold must fail against the newer labels:\n${r.err}`);
  assert.match(r.err, /rationale/);

  // (3) Eine Seite durch eine fremde Charge ersetzt.
  const other: StagedQuery = { ...s, id: stagedId("ganz andere frage"), query: "ganz andere frage" };
  writeStaged([other]);
  writeLabels([labelFor(other)]);
  r = await check();
  assert.equal(r.code, 1, `a foreign batch must fail:\n${r.err}`);
  assert.match(r.err, /missing from the merged gold|no longer labelled/);

  // (4) Staged nachträglich verändert, Labels und Fälle unberührt.
  writeFileSync(gold, pristineGold);
  writeStaged([s]);
  writeFileSync(labels, pristineLabels);
  assert.equal((await check()).code, 0, "Zwischenstand: wieder die Ausgangspaarung");
  writeStaged([s], 4); // dieselben Daten, andere Bytes
  r = await check();
  assert.equal(r.code, 1, `a rewritten staged file must fail:\n${r.err}`);
  assert.match(r.err, /staged file changed since the merge/);

  // (5) Label-Datei neu geschrieben, ohne einen Fall zu berühren.
  writeStaged([s]);
  writeLabels([labelFor(s)], 4);
  r = await check();
  assert.equal(r.code, 1, `a rewritten label file must fail:\n${r.err}`);
  assert.match(r.err, /label file changed since the merge/);
});

test("#447: `--check` without --gold says out loud that it validated no merged gold", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bastra-447-nogold-"));
  const staged = join(dir, "staged.json");
  const labels = join(dir, "labels.json");
  const s = stagedQuery();
  writeFileSync(staged, JSON.stringify({ schema_version: 1, staged: [s] }, null, 2));
  writeFileSync(labels, JSON.stringify({ schema_version: 1, labels: [labelFor(s)] }, null, 2));

  const r = await cli(["--check", "--staged", staged, "--labels", labels]);
  assert.equal(r.code, 0, "labels against staged is still a valid step on its own");
  assert.match(r.err, /NOT CHECKED/, "a green run must not read as `gold and labels agree`");
});
