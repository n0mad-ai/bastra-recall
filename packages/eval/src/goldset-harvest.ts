#!/usr/bin/env tsx
/**
 * Step 1 of the gold set: harvest real queries, label nothing (#262, §19).
 *
 * The queries come from hook telemetry — recalls that actually happened during
 * work. That is what makes them independent: nobody wrote them while looking at
 * the memory they are supposed to retrieve, because when they were written the
 * memory was not on screen and often did not exist yet.
 *
 * Two origin types fall out of the event kind, and the distinction is real:
 *   - `recall` — a search issued deliberately through the MCP tool → `user_query`
 *   - `hook_recall` — derived by the hook from the session → `session_transcript`
 *
 * What this tool deliberately does NOT do:
 *   - open a single memory. It never touches the vault.
 *   - carry the hits over. The events record what the system answered; letting
 *     that inform selection would bias the set toward queries the system
 *     already handles — a subtler version of the bias §19 exists to prevent.
 *   - assign a gold id. That is step 2, and it lives in another file.
 *
 * Selection is mechanical (length, language, identifier presence, dedupe), so
 * no human judgement about "which memory does this hit" enters here.
 *
 * Usage:
 *   npx tsx src/goldset-harvest.ts --out staged.json [--max 400] [--min-len 12]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hookQueryVocabulary } from "@bastra-recall/core";
import {
  detectLang,
  hasIdentifier,
  originRefHash,
  stagedId,
  checkStaged,
  type OriginType,
  type StagedQuery,
} from "./goldset.js";

/** Below the documented recall score floor — see the min_score default. */
const NO_ANSWER_SCORE = 30;

/**
 * Queries the hooks BUILD rather than queries anyone asked.
 *
 * The PreToolUse hook composes a string from the file type and its tags
 * ("editing ts involving typescript, daemon, testing"), and the session-start
 * hook has its own templates. They are real traffic and they are worth
 * measuring — but they are not formulations, and a gold set is a set of
 * formulations. On the live logs they were 112 of 400 staged queries, so
 * keeping them would have made a quarter of the set one machine sentence with
 * the nouns swapped, and every number computed over it would have been
 * dominated by how well the index matches a template.
 *
 * Filtered here rather than at label time: this is a property of the query's
 * origin, which is step 1's business, and it needs no look at the vault.
 */
const HOOK_TEMPLATES: RegExp[] = [
  /^(editing|writing|reading)\s+\S+\s+involving\s/i,
  /active context project-facts decisions$/i,
  /preferences user-preference active context/i,
  // The English template with an EMPTY topic list: `editing command`,
  // `writing CODEOWNERS`. The regex above needs the ` involving ` connector,
  // which a file with no detected topics never gets.
  /^(editing|writing|reading)\s+\S+$/i,
  // The bash lane before 22.08.2026 padded a command label with three filler
  // words (`packages/daemon/src/bash-pre-lane.ts:143` records why it stopped).
  // The form is gone from the code and still sits in older telemetry.
  /\bsafety workflow user-preference$/i,
];

/**
 * The language-neutral default composition of #231 (#413).
 *
 * Since #231 the PreToolUse hook builds `[fileLabel, ...topics].join(" ")` —
 * `css styles daemon flexbox layout stacking` — and the English form only
 * survives behind `BASTRA_HOOK_QUERY=english`. The regex list above recognised
 * the exception and let the rule through: 33 of 400 staged queries in the
 * measured batch, plus 6 empty-topic and 7 bash-lane ones, 46 in total.
 *
 * Shape alone cannot separate this from a real query — a space-joined keyword
 * chain is what most genuine telemetry queries look like, and those are the
 * language-neutral cases the set needs. What separates them is the WORDS: every
 * token of a composed query comes from the hook's own vocabulary. So the test
 * is exact membership, against the vocabulary core exports rather than a copy
 * that would drift from it.
 *
 * A one-token query is not judged here: `daemon` is both a valid topic and a
 * thing somebody types, and the min-length filter already drops it.
 */
function isNeutralHookComposition(query: string): boolean {
  const tokens = query.trim().split(/\s+/);
  if (tokens.length < 2) return false;
  const vocab = hookQueryVocabulary();
  const labels = new Set(vocab.fileLabels);
  const topics = new Set(vocab.topics);
  const [head, ...rest] = tokens.map((t) => t.toLowerCase());
  // The head is the file label — an extension, or a basename the hook passed
  // through. Only the extension form is checkable against the vocabulary; a
  // basename head is covered by the topic test on the tail alone.
  if (!labels.has(head) && !topics.has(head)) return false;
  return rest.every((t) => topics.has(t));
}

function isHookTemplate(query: string): boolean {
  return HOOK_TEMPLATES.some((re) => re.test(query)) || isNeutralHookComposition(query);
}

function logDir(): string {
  return process.env.BASTRA_LOG_PATH ?? process.env.NEXUS_LOG_PATH ?? join(homedir(), ".bastra", "logs");
}

interface Args {
  out: string;
  max: number;
  minLen: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: "", max: 400, minLen: 12 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i] ?? "";
    else if (argv[i] === "--max") args.max = Number(argv[++i]);
    else if (argv[i] === "--min-len") args.minLen = Number(argv[++i]);
    else if (argv[i] === "-h" || argv[i] === "--help") {
      console.log("goldset-harvest --out staged.json [--max 400] [--min-len 12]");
      process.exit(0);
    } else throw new Error(`unknown flag: ${argv[i]}`);
  }
  if (!args.out) throw new Error("--out is required");
  if (!Number.isFinite(args.max) || args.max < 1) throw new Error("--max must be a positive number");
  return args;
}

const KIND_TO_ORIGIN: Record<string, OriginType> = {
  recall: "user_query",
  hook_recall: "session_transcript",
};

const AUTHORING_MODE: Record<OriginType, string> = {
  user_query:
    "verbatim from a recall issued through the MCP tool during real work; " +
    "selected mechanically by length/language/identifier, never by which memory it might hit",
  session_transcript:
    "verbatim from a hook recall derived by the session hook from the running session; " +
    "selected mechanically by length/language/identifier, never by which memory it might hit",
  task_text: "n/a",
  issue_incident: "n/a",
  second_person: "n/a",
};

export interface HarvestResult {
  staged: StagedQuery[];
  scanned: number;
  skippedShort: number;
  skippedDuplicate: number;
  /** Machine-composed hook strings — real traffic, but not formulations. */
  skippedTemplate: number;
  /**
   * Staged ids whose recalls came back empty or far below the score floor.
   *
   * A LABELLING AID, emitted to its own file — never a field on StagedQuery.
   * It is derived from what the system answered, and step 1 must not see that:
   * the whole reason the hits are dropped above is that letting the engine's
   * own verdict inform the query set biases it toward what the engine already
   * handles. Step 2 may look at anything, so the aid belongs there. It marks a
   * candidate for a §19 no-answer case; the labeller still has to decide, and
   * still has to write the rationale.
   */
  noAnswerCandidates: string[];
}

export function harvestFromEvents(files: string[], max: number, minLen: number): HarvestResult {
  const byId = new Map<string, StagedQuery>();
  const emptyResult = new Set<string>();
  const everAnswered = new Set<string>();
  let scanned = 0;
  let skippedShort = 0;
  let skippedDuplicate = 0;
  let skippedTemplate = 0;

  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(t) as Record<string, unknown>;
      } catch {
        continue;
      }
      const query = typeof ev.query === "string" ? ev.query.trim() : "";
      const kind = typeof ev.kind === "string" ? ev.kind : "";
      const origin = KIND_TO_ORIGIN[kind];
      if (!query || !origin) continue;
      scanned++;

      // Too short to be a real retrieval question — these are mostly single
      // tokens from probes, and they would inflate the "easy" end of the set.
      if (query.length < minLen) {
        skippedShort++;
        continue;
      }
      if (isHookTemplate(query)) {
        skippedTemplate++;
        continue;
      }
      const id = stagedId(query);
      // Tracked across every occurrence, including the duplicates: a query that
      // once returned nothing and later found something is NOT a no-answer
      // case, and only the full history shows that.
      const hitCount = typeof ev.hit_count === "number" ? ev.hit_count : undefined;
      const topScore = typeof ev.top_score === "number" ? ev.top_score : undefined;
      if (hitCount === 0 || (topScore !== undefined && topScore < NO_ANSWER_SCORE)) emptyResult.add(id);
      else if (hitCount !== undefined || topScore !== undefined) everAnswered.add(id);

      if (byId.has(id)) {
        skippedDuplicate++;
        continue;
      }
      byId.set(id, {
        id,
        query,
        origin_type: origin,
        authoring_mode: AUTHORING_MODE[origin],
        // The reference stays local: the hash covers the file and the event's
        // own ids, so a case can be traced back on this machine and nowhere else.
        origin_ref_hash: originRefHash(
          `${file}\0${String(ev.recall_id ?? "")}\0${String(ev.session_id ?? "")}\0${String(ev.ts ?? "")}`
        ),
        lang: detectLang(query),
        has_identifier: hasIdentifier(query),
      });
    }
  }

  // Deterministic order, then cap. Sorting by id rather than by frequency or
  // recency keeps the sample independent of how often a query was re-issued —
  // frequency would over-weight whatever the hook happened to fire on.
  const staged = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, max);
  const kept = new Set(staged.map((s) => s.id));
  const noAnswerCandidates = [...emptyResult].filter((id) => kept.has(id) && !everAnswered.has(id)).sort();
  return { staged, scanned, skippedShort, skippedDuplicate, skippedTemplate, noAnswerCandidates };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dir = logDir();
  const files = readdirSync(dir)
    .filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .map((f) => join(dir, f));
  if (files.length === 0) throw new Error(`no event logs under ${dir}`);

  const { staged, scanned, skippedShort, skippedDuplicate, skippedTemplate, noAnswerCandidates } = harvestFromEvents(
    files,
    args.max,
    args.minLen
  );
  const issues = checkStaged(staged);
  if (issues.length) {
    for (const i of issues) console.error(`[goldset] ${i.where}: ${i.problem}`);
    throw new Error(`${issues.length} staged queries violate §19`);
  }

  // Owner-only: the queries are vault-adjacent text and stay out of the repo
  // (§18.1, C-025). The harness enforces the same rule for its own --out.
  writeFileSync(args.out, JSON.stringify({ schema_version: 1, staged }, null, 2) + "\n", { mode: 0o600 });
  // Separate file, separate step. Keeping it out of the staged file is the
  // point: step 1 must stay blind to what the engine answered.
  const aidPath = args.out.replace(/\.json$/, "") + ".miss-candidates.json";
  writeFileSync(
    aidPath,
    JSON.stringify(
      {
        schema_version: 1,
        $comment:
          "Known retrieval MISSES, for the baseline run — NOT a labelling aid. A candidate is a query " +
          "that never once returned a hit above the score floor. That is derived from what the engine " +
          "answered, so it cannot tell a true §19 no-answer from a retrieval failure. Labelling from it " +
          "would write the engine's own failures into the gold set and let the measurement confirm " +
          "itself — the circularity §19 exists to prevent. On the 2026-08-28 labelling pass all three " +
          "candidates turned out to be failures and none a no-answer.",
        miss_candidates: noAnswerCandidates,
      },
      null,
      2
    ) + "\n",
    { mode: 0o600 }
  );

  const langs = staged.reduce<Record<string, number>>((a, s) => ({ ...a, [s.lang]: (a[s.lang] ?? 0) + 1 }), {});
  const origins = staged.reduce<Record<string, number>>(
    (a, s) => ({ ...a, [s.origin_type]: (a[s.origin_type] ?? 0) + 1 }),
    {}
  );
  console.error(
    `[goldset] ${scanned} query events → ${staged.length} staged ` +
      `(${skippedDuplicate} duplicates, ${skippedShort} too short, ${skippedTemplate} hook templates)`
  );
  console.error(`[goldset] languages: ${JSON.stringify(langs)}  origins: ${JSON.stringify(origins)}`);
  console.error(`[goldset] with identifier: ${staged.filter((s) => s.has_identifier).length}`);
  console.error(
    `[goldset] known retrieval misses: ${noAnswerCandidates.length} (in ${aidPath}, for the baseline run — NOT for labelling)`
  );
  console.error(`[goldset] wrote ${args.out} — NOT labelled. Step 2 assigns gold ids.`);
}

if (import.meta.filename === process.argv[1]) {
  try {
    main();
  } catch (e) {
    console.error(`[goldset] FATAL: ${(e as Error).message}`);
    process.exit(1);
  }
}
