#!/usr/bin/env tsx
/**
 * Step 0 for the categories no harvester can reach (#262, §19).
 *
 * Three artifact sources were checked against §19's requirement that a gold
 * query be query-SHAPED, and only one survived:
 *
 *   - hook telemetry — works, but yields keyword chains. One §19 category.
 *   - GitHub issue titles — work-item labels. "cli: add 'bastra logs'
 *     subcommand" is not something anyone types to find a memory.
 *   - session prompts — conversational fragments. "1 passt, 2 opt-in, 3 los
 *     gehts" is meaningless without the turn before it.
 *
 * So the remaining categories — real paraphrases, hard semantic distractors,
 * cross-scope cases, time/version questions, associative cases resolvable only
 * through situational context — need a person writing queries blind. §19 names
 * that source: an independently working second person.
 *
 * This tool is what makes that path usable and auditable. It takes a plain
 * text file of queries, one per line, and stamps the provenance §19 demands.
 * It never opens the vault, and it refuses to run in a directory where it
 * could be tempted to: the whole value of a blind query is that the author did
 * not see the answer.
 *
 * The honesty this cannot enforce, and does not pretend to: nothing here can
 * verify the author kept their eyes closed. What it does is record WHO wrote
 * them and HOW, so a reviewer can weigh it — which is exactly what
 * `authoring_mode` is for.
 *
 * Usage:
 *   npx tsx src/goldset-blind.ts --in queries.txt --out staged-blind.json \
 *     --origin second_person --by "Sali" \
 *     --mode "wrote 40 retrieval questions from her own memory of the project, vault closed"
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  ORIGIN_TYPES,
  checkStaged,
  detectLang,
  hasIdentifier,
  originRefHash,
  stagedId,
  type OriginType,
  type StagedQuery,
} from "./goldset.js";

interface Args {
  in: string;
  out: string;
  origin: OriginType;
  by: string;
  mode: string;
}

/** §19 admits these three only for a human-authored batch. */
const BLIND_ORIGINS: OriginType[] = ["second_person", "task_text", "issue_incident"];

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--in") a.in = argv[++i];
    else if (f === "--out") a.out = argv[++i];
    else if (f === "--origin") a.origin = argv[++i] as OriginType;
    else if (f === "--by") a.by = argv[++i];
    else if (f === "--mode") a.mode = argv[++i];
    else if (f === "-h" || f === "--help") {
      console.log('goldset-blind --in q.txt --out staged.json --origin second_person --by NAME --mode "how"');
      process.exit(0);
    } else throw new Error(`unknown flag: ${f}`);
  }
  if (!a.in || !a.out) throw new Error("--in and --out are required");
  if (!a.origin || !ORIGIN_TYPES.includes(a.origin)) {
    throw new Error(`--origin must be one of ${ORIGIN_TYPES.join(", ")}`);
  }
  if (!BLIND_ORIGINS.includes(a.origin)) {
    throw new Error(
      `--origin ${a.origin} describes a harvested source, not a written one. ` +
        `Use goldset-harvest for those; this tool is for ${BLIND_ORIGINS.join(", ")}.`
    );
  }
  if (!a.by?.trim()) throw new Error("--by is required — a blind batch is only as good as who vouches for it");
  if (!a.mode?.trim()) {
    throw new Error(
      "--mode is required (§19 `authoring_mode`): say how the queries were obtained without opening the target memories"
    );
  }
  return a as Args;
}

export function stageBlind(lines: string[], origin: OriginType, by: string, mode: string, ref: string): StagedQuery[] {
  const seen = new Set<string>();
  const out: StagedQuery[] = [];
  for (const raw of lines) {
    const query = raw.trim();
    // Comments let an author group a batch by category without those lines
    // becoming queries.
    if (!query || query.startsWith("#")) continue;
    const id = stagedId(query);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      query,
      origin_type: origin,
      authoring_mode: `${mode} — authored by ${by}`,
      origin_ref_hash: originRefHash(`${ref}:${by}`),
      lang: detectLang(query),
      has_identifier: hasIdentifier(query),
    });
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const lines = readFileSync(args.in, "utf8").split("\n");
  const staged = stageBlind(lines, args.origin, args.by, args.mode, args.in);
  if (staged.length === 0) throw new Error(`${args.in} holds no queries`);

  const issues = checkStaged(staged);
  if (issues.length) {
    for (const i of issues) console.error(`[goldset] ${i.where}: ${i.problem}`);
    throw new Error(`${issues.length} staged queries violate §19`);
  }

  writeFileSync(args.out, JSON.stringify({ schema_version: 1, staged }, null, 2) + "\n", { mode: 0o600 });
  const langs = staged.reduce<Record<string, number>>((a, s) => ({ ...a, [s.lang]: (a[s.lang] ?? 0) + 1 }), {});
  console.error(`[goldset] staged ${staged.length} blind queries as ${args.origin}, authored by ${args.by}`);
  console.error(
    `[goldset] languages: ${JSON.stringify(langs)}  with identifier: ${staged.filter((s) => s.has_identifier).length}`
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
