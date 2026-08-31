/**
 * Loading, validating and identifying the dataset a gold run measures.
 *
 * Split out of `goldset-run.ts`, which owns the measurement itself: everything
 * here happens BEFORE a single case is scored and holds no runner state. The
 * three functions are one thought — read the files, refuse what the measurement
 * cannot stand on, and give what survives a citation identity that actually
 * depends on its content.
 *
 * `goldset-run.ts` hashes this file into the run manifest's `code` hash along
 * with its own source, so a run stays citable down to the rules that admitted
 * its data.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { checkGoldCases, type GoldCase } from "./goldset.js";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The gold schema this runner grades. Another version is a different dataset. */
export const GOLD_SCHEMA_VERSION = 1;

/**
 * Read the gold files and refuse anything the measurement cannot stand on.
 *
 * The runner used to cast the parsed JSON straight to `GoldCase[]` and check
 * duplicate ids and nothing else (#434). But a run grades the FILE, not its
 * creation history: a case edited after the authoring pipeline signed it off,
 * a truthy typo in `probe_group` — which silently drops the case out of the
 * main denominator — or a file from another schema would all have been measured
 * as if they had passed §19. `checkGoldCases` is the authoring pipeline's own
 * rule set, applied here on purpose so the two cannot drift.
 */
export function loadGoldFiles(paths: string[]): { cases: GoldCase[]; sources: Record<string, number> } {
  const cases: GoldCase[] = [];
  const sources: Record<string, number> = {};
  for (const p of paths) {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { schema_version?: number; cases?: GoldCase[] };
    if (parsed.schema_version !== GOLD_SCHEMA_VERSION) {
      throw new Error(
        `${p}: gold schema_version ${JSON.stringify(parsed.schema_version)} — this runner grades version ${GOLD_SCHEMA_VERSION}`,
      );
    }
    if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) throw new Error(`${p}: holds no cases`);
    // The source map keys by file name and two directories can hold the same
    // one; overwriting an entry would understate the dataset in the artifact.
    const name = basename(p);
    if (name in sources) {
      throw new Error(`two gold files are named \`${name}\` — the source map cannot tell them apart`);
    }
    sources[name] = parsed.cases.length;
    cases.push(...parsed.cases);
  }
  const issues = checkGoldCases(cases);
  if (issues.length) {
    for (const i of issues) console.error(`[goldset-run] gold ${i.where}: ${i.problem}`);
    throw new Error(
      `${issues.length} gold case(s) violate §19 — a run grades the file, not its history`
        + ` (first: ${issues[0].where}: ${issues[0].problem})`,
    );
  }
  return { cases, sources };
}

/**
 * Gold ids the vault no longer holds, deduplicated and sorted (#432).
 *
 * `CaseResult.unknown_ids` always called a missing gold id a gate failure and
 * never a miss, but the runner scored the case anyway: the expected id got rank
 * 0, the row entered every aggregate, and the command exited successfully with
 * depressed recall. Collected before anything is scored, so the caller can stop
 * instead of publishing a stale label as a retrieval result.
 */
export function unknownGoldIds(cases: GoldCase[], knownIds: ReadonlySet<string>): string[] {
  const missing = new Set<string>();
  for (const c of cases) {
    for (const id of [...c.expected_ids, ...c.acceptable_alternatives]) {
      if (!knownIds.has(id)) missing.add(id);
    }
  }
  return [...missing].sort();
}

/**
 * The dataset identity a run is cited by (#430).
 *
 * Hashing the source map and the sorted case ids let two materially different
 * evaluations share one identity: rewriting a query or relabelling a case while
 * keeping its id produced the same hash. So the hash covers everything that
 * decides WHAT is measured — the query, both id lists, the no-answer and probe
 * classification, the allowed depth and every reporting axis — and nothing that
 * only records who wrote the label down. Sorted by id, so file order cannot
 * move it.
 */
export function datasetHash(sources: Record<string, number>, cases: GoldCase[]): string {
  const names = Object.keys(sources).sort().map((n) => `${n}:${sources[n]}`).join(",");
  const canonical = [...cases]
    .sort((a, b) => a.id.localeCompare(b.id))
    // JSON, not a joined string: a query may carry the separator itself, and
    // two different datasets must not be able to collide by punctuation.
    .map((c) => JSON.stringify([
      c.id,
      c.query,
      [...c.expected_ids].sort().join(","),
      [...c.acceptable_alternatives].sort().join(","),
      String(c.no_answer),
      c.probe_group ?? "",
      String(c.allowed_retrieval_depth),
      c.kind,
      c.expected_zone,
      c.origin_type,
      c.lang,
      String(c.has_identifier),
      c.scope ?? "",
      c.time_view ?? "",
      String(c.correct_answer_is_non_application ?? false),
    ]))
    .join("\n");
  return sha256(`${names}\n${canonical}`);
}
