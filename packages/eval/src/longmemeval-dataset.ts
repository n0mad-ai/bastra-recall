/**
 * Loading, validating and identifying the LongMemEval corpus a run measures.
 *
 * Same division of labour as `goldset-dataset.ts`, which this file is modelled
 * on: everything here happens BEFORE a single question is scored and holds no
 * runner state. Read the file, refuse what the measurement cannot stand on,
 * and give what survives a citation identity that depends on its content.
 *
 * `longmemeval-run.ts` hashes this file into its run manifest's `code` hash
 * along with its own source, so a run stays citable down to the rules that
 * admitted its data — and down to the mapping, because on this corpus the
 * mapping IS a measurement decision: a session becomes a memory here, and how
 * its turns are flattened moves the number.
 *
 * ── The corpus ────────────────────────────────────────────────────────────
 * LongMemEval (ICLR 2025, arXiv:2410.10813, MIT) ships one JSON array of
 * questions. Every question carries its OWN haystack of chat sessions, so the
 * corpus is 500 small retrieval problems, not one big one — an index is built
 * per question, exactly as the two systems we compare against do it.
 *
 *   question_id, question_type, question, answer, question_date
 *   haystack_session_ids[]  — parallel to
 *   haystack_sessions[][]   — a session is a list of {role, content, has_answer?}
 *   haystack_dates[]        — parallel again
 *   answer_session_ids[]    — the gold sessions
 *
 * Get the data (MIT):
 *   packages/eval/scripts/fetch-longmemeval.sh
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The corpus shape this loader reads. Another shape is a different dataset. */
export const LONGMEMEVAL_SCHEMA_VERSION = 1;

export interface LongMemEvalTurn {
  role: string;
  content: string;
  has_answer?: boolean;
}

export interface LongMemEvalQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_sessions: LongMemEvalTurn[][];
  haystack_dates: string[];
  answer_session_ids: string[];
}

export interface DatasetIssue {
  where: string;
  problem: string;
}

/**
 * The abstention question types, excluded by `benchmark/longmemeval-bench.ts`
 * in agentmemory — mirrored here so the two runs see the same denominator.
 *
 * On `longmemeval_s_cleaned.json` this filter matches NOTHING: the file carries
 * six ordinary types and all 500 questions have gold sessions inside their own
 * haystack. Thirty question IDS end in `_abs`, spread across four of those
 * types, and they are NOT removed — neither reference run removes them either,
 * and dropping them here would silently change the denominator away from the
 * 500 both published numbers are averaged over. `longmemeval-run.ts` reports
 * that subset separately instead of hiding it.
 */
export const ABSTENTION_TYPES: ReadonlySet<string> = new Set([
  "single-session-user_abs",
  "multi-session_abs",
  "knowledge-update_abs",
  "temporal-reasoning_abs",
]);

/** Session ids are arbitrary strings; memory ids have to be path-safe slugs. */
export const slug = (id: string): string =>
  id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * How a session's turns become one document's text.
 *
 * The two published figures this arm exists to be comparable to disagree here,
 * and the disagreement is worth a flag rather than a silent choice:
 *   - `all`  — `role: content` per turn, newline-joined. agentmemory's
 *              `chunkSessionToText`; the default, because a memory written from
 *              a session in production holds both sides of it too.
 *   - `user` — the user turns' content only. MemPalace's session granularity.
 */
export type TurnMode = "all" | "user";

/** One session, mapped to the fields a vault memory is written from. */
export interface SessionMemory {
  /** Path-safe memory id — `slug(session_id)`. */
  id: string;
  /** The LongMemEval session id this memory stands for, unslugged. */
  session_id: string;
  /** Session date as the corpus states it, e.g. `2023/04/10 (Mon) 17:50`. */
  date: string;
  title: string;
  summary: string;
  body: string;
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * `2023/04/10 (Mon) 17:50` -> `2023-04-10`, the frontmatter date format.
 *
 * Returns null rather than guessing when the corpus states something else: a
 * date that silently became today's would make a `reference` memory look
 * freshly touched, and staleness reads `updated`.
 */
export function isoDate(raw: string): string | null {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(raw ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Flatten one session into the text a memory is built from.
 *
 * No summarisation, no extraction, no model in the loop — the session text goes
 * in verbatim. Anything else would measure a write-time pipeline the reference
 * runs do not have, and the comparison would stop being about retrieval.
 */
export function sessionText(turns: LongMemEvalTurn[], mode: TurnMode): string {
  if (mode === "user") {
    return turns.filter((t) => t.role === "user").map((t) => t.content).join("\n");
  }
  return turns.map((t) => `${t.role}: ${t.content}`).join("\n");
}

/**
 * The haystack of one question, as memories — deduplicated, in corpus order.
 *
 * Thirteen questions in `longmemeval_s_cleaned.json` list the same session id
 * twice. Both copies are byte-identical and none of them is a gold session
 * (checked over the whole file), so keeping the first occurrence loses nothing
 * — but a vault cannot hold two memories under one id, so the collapse has to
 * happen somewhere and it happens here, counted, rather than as a silent last
 * write in the caller.
 */
export function haystackMemories(q: LongMemEvalQuestion, mode: TurnMode): {
  memories: SessionMemory[];
  duplicates: number;
} {
  const memories: SessionMemory[] = [];
  const seen = new Map<string, string>();
  let duplicates = 0;
  for (let i = 0; i < q.haystack_sessions.length; i++) {
    const sessionId = q.haystack_session_ids[i];
    const id = slug(sessionId);
    const prior = seen.get(id);
    if (prior !== undefined) {
      // A pure repetition is dropped; two DIFFERENT sessions colliding into one
      // slug would silently merge a gold session into a distractor, so that one
      // stops the run instead.
      if (prior !== sessionId) {
        throw new Error(
          `${q.question_id}: session ids \`${prior}\` and \`${sessionId}\` both slug to \`${id}\``,
        );
      }
      duplicates++;
      continue;
    }
    seen.set(id, sessionId);
    const turns = q.haystack_sessions[i];
    const text = sessionText(turns, mode);
    const firstUser = turns.find((t) => t.role === "user")?.content ?? text;
    memories.push({
      id,
      session_id: sessionId,
      date: q.haystack_dates[i] ?? "",
      // Same rule `rrf-k-beir.ts` uses on a public corpus that has no authored
      // title or summary: a title is what the document opens with, a summary is
      // its first 200 characters. Mechanical on purpose — inventing either with
      // a model would test that model, not the fusion.
      title: collapse(firstUser).slice(0, 120) || id,
      summary: collapse(text).slice(0, 200),
      body: text,
    });
  }
  return { memories, duplicates };
}

/**
 * Read the corpus file and refuse anything the measurement cannot stand on.
 *
 * The checks are the ones a wrong answer would be attributed to the retriever:
 * a gold id outside its own haystack scores a guaranteed miss, an empty
 * haystack scores a guaranteed miss, and a question with no text scores one
 * too. None of them is a retrieval result, so none of them may enter a mean.
 */
export function checkLongMemEvalQuestions(questions: LongMemEvalQuestion[]): DatasetIssue[] {
  const issues: DatasetIssue[] = [];
  const seen = new Set<string>();
  for (const q of questions) {
    const where = q.question_id ?? "<unnamed question>";
    if (typeof q.question_id !== "string" || q.question_id.length === 0) {
      issues.push({ where, problem: "missing `question_id`" });
    }
    if (seen.has(q.question_id)) issues.push({ where, problem: "duplicate question_id" });
    seen.add(q.question_id);
    if (typeof q.question !== "string" || collapse(q.question).length === 0) {
      issues.push({ where, problem: "empty `question` — nothing to retrieve with" });
    }
    if (!Array.isArray(q.haystack_sessions) || q.haystack_sessions.length === 0) {
      issues.push({ where, problem: "empty haystack — a guaranteed miss is not a retrieval result" });
      continue;
    }
    if (
      q.haystack_session_ids?.length !== q.haystack_sessions.length ||
      q.haystack_dates?.length !== q.haystack_sessions.length
    ) {
      issues.push({
        where,
        problem:
          `haystack arrays disagree: ${q.haystack_session_ids?.length} ids, ` +
          `${q.haystack_sessions.length} sessions, ${q.haystack_dates?.length} dates`,
      });
    }
    if (!Array.isArray(q.answer_session_ids) || q.answer_session_ids.length === 0) {
      issues.push({ where, problem: "no `answer_session_ids` — the question has no gold to be found" });
      continue;
    }
    const haystack = new Set(q.haystack_session_ids ?? []);
    for (const gid of q.answer_session_ids) {
      if (!haystack.has(gid)) {
        issues.push({ where, problem: `gold session \`${gid}\` is not in this question's own haystack` });
      }
    }
  }
  return issues;
}

/**
 * Read one LongMemEval JSON file, validated.
 *
 * `dropped` counts abstention-typed questions removed by `ABSTENTION_TYPES`.
 * It is reported rather than assumed to be zero, because a future release of
 * the corpus may reintroduce those types and the denominator would move
 * without anyone noticing.
 */
export function loadLongMemEval(path: string): {
  questions: LongMemEvalQuestion[];
  dropped: number;
} {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${path}: expected a non-empty JSON array of LongMemEval questions`);
  }
  const all = parsed as LongMemEvalQuestion[];
  const questions = all.filter((q) => !ABSTENTION_TYPES.has(q.question_type));
  const issues = checkLongMemEvalQuestions(questions);
  if (issues.length) {
    for (const i of issues.slice(0, 10)) console.error(`[longmemeval] ${i.where}: ${i.problem}`);
    throw new Error(
      `${issues.length} question(s) in ${path} cannot be scored`
        + ` (first: ${issues[0].where}: ${issues[0].problem})`,
    );
  }
  return { questions, dropped: all.length - questions.length };
}

/**
 * The dataset identity a run is cited by.
 *
 * Same reasoning as `goldset-dataset.ts:datasetHash`: the hash covers
 * everything that decides WHAT is measured and nothing that only records where
 * it came from. Here that includes the turn mode — flattening user turns only
 * versus both roles produces different documents from the same file, so the
 * two must not be able to share one identity. Sorted by question id, so file
 * order cannot move it.
 */
export function longMemEvalDatasetHash(
  questions: LongMemEvalQuestion[],
  turns: TurnMode,
): string {
  const canonical = [...questions]
    .sort((a, b) => a.question_id.localeCompare(b.question_id))
    // JSON, not a joined string: a question may carry the separator itself.
    .map((q) => JSON.stringify([
      q.question_id,
      q.question_type,
      q.question,
      [...q.answer_session_ids].sort().join(","),
      [...q.haystack_session_ids].sort().join(","),
      String(q.haystack_sessions.reduce((n, s) => n + s.length, 0)),
    ]))
    .join("\n");
  return sha256(`v${LONGMEMEVAL_SCHEMA_VERSION}\nturns:${turns}\nn:${questions.length}\n${canonical}`);
}
