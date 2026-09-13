#!/usr/bin/env tsx
/**
 * Step 2 of the gold set: assign the gold, separately (#262, §19).
 *
 * §19 allows the labeller to read the vault — the rule it imposes is that the
 * QUERY was already fixed before anyone did. That is why this is its own tool
 * on its own input: the staged file is closed by the time labelling starts, so
 * a query cannot be quietly adjusted to fit the memory that was found for it.
 *
 * Three modes, in the order they are used:
 *
 *   --template   emit a skeleton with one empty label per staged query
 *   --check      validate a filled-in label file against the staged file
 *   --merge      join both into gold cases and report §19 coverage
 *
 * A file rather than an interactive prompt, deliberately: §19 admits an
 * independently working second person as an origin, and a file is what you can
 * hand to one.
 *
 * #447: `--check --gold G` additionally revalidates an ALREADY MERGED gold file
 * against the current labels. Without it, the two files drift apart in silence:
 * a label edited after the merge leaves the gold file on the old content, every
 * tool reports success, and the divergence surfaces only when someone re-merges
 * — at which point the re-merge quietly carries the change into the measurement
 * path. A gold file is release evidence, so a stale pairing must make a command
 * red, not merely go unnoticed.
 *
 * Usage:
 *   npx tsx src/goldset-label.ts --template --staged staged.json --out labels.json
 *   npx tsx src/goldset-label.ts --check    --staged staged.json --labels labels.json [--gold gold.json]
 *   npx tsx src/goldset-label.ts --merge    --staged staged.json --labels labels.json --out gold.json
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import {
  checkLabels,
  checkStaged,
  coverage,
  type GoldCase,
  type GoldIssue,
  type GoldLabel,
  type StagedQuery,
} from "./goldset.js";

interface Args {
  mode: "template" | "check" | "merge";
  staged: string;
  labels: string;
  out: string;
  /** #447: the merged gold file to revalidate against these labels. */
  gold: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { mode: "check", staged: "", labels: "", out: "", gold: "" };
  let mode: Args["mode"] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--template" || f === "--check" || f === "--merge") mode = f.slice(2) as Args["mode"];
    else if (f === "--staged") a.staged = argv[++i] ?? "";
    else if (f === "--labels") a.labels = argv[++i] ?? "";
    else if (f === "--out") a.out = argv[++i] ?? "";
    else if (f === "--gold") a.gold = argv[++i] ?? "";
    else if (f === "-h" || f === "--help") {
      console.log(
        "goldset-label --template|--check|--merge --staged S [--labels L] [--out O] [--gold G]",
      );
      process.exit(0);
    } else throw new Error(`unknown flag: ${f}`);
  }
  if (!mode) throw new Error("one of --template, --check, --merge is required");
  a.mode = mode;
  if (!a.staged) throw new Error("--staged is required");
  if (mode !== "template" && !a.labels) throw new Error("--labels is required");
  if (mode !== "check" && !a.out) throw new Error("--out is required");
  if (a.gold && mode !== "check") throw new Error("--gold belongs to --check");
  return a;
}

/**
 * #447: Woraus eine Gold-Datei gemergt wurde.
 *
 * Die Hashes stehen daneben, weil der Fallvergleich allein nicht alles fängt:
 * Ein Label-Feld, das gar nicht in den Fall wandert, kann sich ändern, ohne
 * dass ein einziger Fall abweicht — und dann behauptet die Gold-Datei
 * weiterhin, aus einem Label-Stand zu stammen, den es nicht mehr gibt.
 */
export interface MergedFrom {
  staged: string;
  labels: string;
  staged_sha256: string;
  labels_sha256: string;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function mergedFrom(stagedPath: string, labelsPath: string): MergedFrom {
  // Nur die Dateinamen: Ein absoluter Pfad aus einem privaten Vault-Verzeichnis
  // gehört nicht in ein Artefakt, das die Messung begleitet (§19/§23).
  return {
    staged: basename(stagedPath),
    labels: basename(labelsPath),
    staged_sha256: sha256(stagedPath),
    labels_sha256: sha256(labelsPath),
  };
}

/** Die Felder, in denen sich zwei Fassungen desselben Falls unterscheiden. */
function differingFields(a: GoldCase, b: GoldCase): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    const x = (a as unknown as Record<string, unknown>)[k];
    const y = (b as unknown as Record<string, unknown>)[k];
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(k);
  }
  return out.sort();
}

/**
 * #447: Das gemergte Gold gegen den Stand prüfen, aus dem es stammen soll.
 *
 * Verglichen wird gegen ein FRISCHES Merge derselben Dateien — also gegen das,
 * was `--merge` heute schriebe. Was hier abweicht, ist genau der Drift, den
 * bisher niemand gemeldet hat.
 */
export function checkGoldAgainstLabels(
  goldDoc: unknown,
  expected: GoldCase[],
  provenance: MergedFrom,
): GoldIssue[] {
  const issues: GoldIssue[] = [];
  const doc = (goldDoc ?? {}) as { cases?: GoldCase[]; merged_from?: Partial<MergedFrom> };
  const have = new Map((doc.cases ?? []).map((c) => [c.id, c]));
  const want = new Map(expected.map((c) => [c.id, c]));

  for (const id of want.keys()) {
    if (!have.has(id)) issues.push({ where: `case ${id}`, problem: "labelled, but missing from the merged gold" });
  }
  for (const id of have.keys()) {
    if (!want.has(id)) issues.push({ where: `case ${id}`, problem: "in the merged gold, but no longer labelled" });
  }
  for (const [id, w] of want) {
    const h = have.get(id);
    if (!h) continue;
    const diff = differingFields(w, h);
    if (diff.length) {
      issues.push({
        where: `case ${id}`,
        problem: `gold and labels disagree on ${diff.join(", ")} — the gold file was merged from a different label state`,
      });
    }
  }

  // Der Herkunftsvermerk ist erst seit #447 da; eine ältere Gold-Datei hat ihn
  // nicht, und das ist kein Fehler — der Fallvergleich oben gilt trotzdem.
  const from = doc.merged_from;
  if (from) {
    if (from.labels_sha256 && from.labels_sha256 !== provenance.labels_sha256) {
      issues.push({
        where: "merged_from.labels_sha256",
        problem: `the label file changed since the merge (gold recorded ${from.labels_sha256.slice(0, 12)}…, file is ${provenance.labels_sha256.slice(0, 12)}…)`,
      });
    }
    if (from.staged_sha256 && from.staged_sha256 !== provenance.staged_sha256) {
      issues.push({
        where: "merged_from.staged_sha256",
        problem: `the staged file changed since the merge (gold recorded ${from.staged_sha256.slice(0, 12)}…, file is ${provenance.staged_sha256.slice(0, 12)}…)`,
      });
    }
  }
  return issues;
}

function readStaged(path: string): StagedQuery[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { staged?: StagedQuery[] };
  const staged = parsed.staged ?? [];
  const issues = checkStaged(staged);
  if (issues.length) {
    for (const i of issues) console.error(`[goldset] staged ${i.where}: ${i.problem}`);
    throw new Error(`the staged file violates §19 in ${issues.length} place(s)`);
  }
  return staged;
}

/** A skeleton label. Every §19 field is present and empty, so none is forgotten. */
export function templateFor(s: StagedQuery): GoldLabel & { query: string } {
  return {
    // Echoed for the labeller's benefit only; --merge reads it from the staged file.
    query: s.query,
    staged_id: s.id,
    expected_ids: [],
    acceptable_alternatives: [],
    expected_zone: "orbit",
    no_answer: false,
    scope: null,
    time_view: null,
    allowed_retrieval_depth: 10,
    rationale: "",
    kind: "descriptive",
    labelled_at: "",
    labelled_by: "",
  };
}

export function mergeCases(staged: StagedQuery[], labels: GoldLabel[]): GoldCase[] {
  const byId = new Map(staged.map((s) => [s.id, s]));
  const out: GoldCase[] = [];
  for (const l of labels) {
    const s = byId.get(l.staged_id);
    if (!s) continue; // checkLabels already reported it
    const { staged_id: _drop, ...rest } = l;
    out.push({ ...s, ...rest });
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const staged = readStaged(args.staged);

  if (args.mode === "template") {
    const labels = staged.map(templateFor);
    writeFileSync(args.out, JSON.stringify({ schema_version: 1, labels }, null, 2) + "\n", { mode: 0o600 });
    console.error(`[goldset] wrote ${labels.length} empty labels to ${args.out}`);
    console.error(`[goldset] §19: reading the vault is allowed HERE. The queries are already fixed.`);
    return;
  }

  const parsed = JSON.parse(readFileSync(args.labels, "utf8")) as { labels?: GoldLabel[] };
  const labels = parsed.labels ?? [];
  const issues = checkLabels(labels, staged);
  if (issues.length) {
    for (const i of issues) console.error(`[goldset] label ${i.where}: ${i.problem}`);
    throw new Error(`${issues.length} label(s) violate §19`);
  }
  console.error(`[goldset] ${labels.length} labels check out against ${staged.length} staged queries.`);

  if (args.mode === "check") {
    // #447: Ohne die gemergte Gold-Datei prüft `--check` NUR Labels gegen
    // Staged. Das ist ein gültiger Schritt (vor dem ersten Merge gibt es keine
    // Gold-Datei), aber ein grüner Lauf darf nicht als „Gold und Labels passen
    // zusammen" gelesen werden — das hat er nie geprüft.
    if (!args.gold) {
      console.error(
        `[goldset] NOT CHECKED: no --gold given, so no merged gold was revalidated against these labels (#447).`,
      );
      return;
    }
    const goldDoc = JSON.parse(readFileSync(args.gold, "utf8")) as unknown;
    const drift = checkGoldAgainstLabels(
      goldDoc,
      mergeCases(staged, labels),
      mergedFrom(args.staged, args.labels),
    );
    if (drift.length) {
      for (const d of drift) console.error(`[goldset] gold ${d.where}: ${d.problem}`);
      throw new Error(
        `${args.gold} has drifted from ${args.labels} in ${drift.length} place(s) — re-merge before using it as measurement evidence`,
      );
    }
    console.error(`[goldset] ${args.gold} still matches these labels exactly.`);
    return;
  }

  {
    const cases = mergeCases(staged, labels);
    const cov = coverage(cases);
    writeFileSync(
      args.out,
      JSON.stringify(
        {
          schema_version: 1,
          // #447: Der Gold-Datei ansehen, aus welchem Stand sie gemergt wurde.
          // Ohne diesen Vermerk kann `--check` nur die Fälle vergleichen und
          // eine Label-Änderung, die keinen Fall berührt, nicht bemerken.
          merged_from: mergedFrom(args.staged, args.labels),
          coverage: cov,
          cases,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    console.error(`[goldset] wrote ${cases.length} gold cases to ${args.out}`);
    console.error(`[goldset] coverage: ${JSON.stringify(cov)}`);
    if (cov.probes) {
      // Said out loud because the two numbers differ and a reader who sees only
      // the file's case count would otherwise take the larger one as the set.
      console.error(
        `[goldset] ${cov.probes} of ${cov.total_with_probes} cases are probes ` +
          `(${JSON.stringify(cov.by_probe_group)}) — main denominator is ${cov.total}`,
      );
    }
    // §19 lists the categories the set must reach. Naming the empty ones is the
    // point of the report — a gold set is judged by what it does NOT cover.
    const gaps: string[] = [];
    if (cov.no_answer === 0) gaps.push("no true no-answer queries");
    if (cov.with_identifier === 0) gaps.push("no exact identifier/path/symbol cases");
    if ((cov.by_kind.associative ?? 0) === 0) gaps.push("no associative cases (C-051/C-057 needs both axes)");
    if ((cov.by_kind.descriptive ?? 0) === 0) gaps.push("no descriptive cases");
    if (cov.non_application === 0) gaps.push("no case whose correct answer is NOT applying a memory (C-036)");
    if ((cov.by_lang.de ?? 0) === 0 || (cov.by_lang.en ?? 0) === 0) gaps.push("language coverage is one-sided");
    if (gaps.length) {
      console.error(`[goldset] §19 gaps — the set is not complete yet:`);
      for (const g of gaps) console.error(`  - ${g}`);
    }
  }
}

if (import.meta.filename === process.argv[1]) {
  try {
    main();
  } catch (e) {
    console.error(`[goldset] FATAL: ${(e as Error).message}`);
    process.exit(1);
  }
}
