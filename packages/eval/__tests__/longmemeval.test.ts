/**
 * The external LongMemEval arm: its loader, its mapping and its registration (#500).
 *
 * The measurement itself needs a 265 MB corpus and a warm Ollama, so it does not
 * belong in the suite. What does belong here is everything that decides WHAT is
 * measured — because on this corpus the mapping is a measurement decision, and
 * a silent change to it moves a number that is published beside two other
 * projects' numbers.
 *
 * The fixture is four questions taken verbatim from the ORACLE split, which
 * contains only the gold sessions. Retrieval on it is trivial by construction:
 * it exercises the loader and the runner's plumbing and is not a result. The
 * citable number comes from `longmemeval_s_cleaned.json`.
 *
 * Run: npx tsx --test packages/eval/__tests__/longmemeval.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ABSTENTION_TYPES,
  checkLongMemEvalQuestions,
  haystackMemories,
  isoDate,
  loadLongMemEval,
  longMemEvalDatasetHash,
  sessionText,
  slug,
  type LongMemEvalQuestion,
} from "../src/longmemeval-dataset.js";
import {
  checkLongMemEvalRegistration,
  loadLongMemEvalRegistration,
  longMemEvalComparability,
  loadForeignFigures,
} from "../src/registrations.js";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "longmemeval-sample.json");

/** A question shaped like the corpus, cheap to bend into the cases below. */
function q(over: Partial<LongMemEvalQuestion> = {}): LongMemEvalQuestion {
  return {
    question_id: "q1",
    question_type: "multi-session",
    question: "when did I book the flight?",
    answer: "March",
    question_date: "2023/04/10 (Mon) 23:07",
    haystack_session_ids: ["s_1", "s_2"],
    haystack_sessions: [
      [{ role: "user", content: "I booked the flight in March" }, { role: "assistant", content: "noted" }],
      [{ role: "user", content: "unrelated chatter about cats" }],
    ],
    haystack_dates: ["2023/03/01 (Wed) 10:00", "2023/03/02 (Thu) 11:00"],
    answer_session_ids: ["s_1"],
    ...over,
  };
}

test("the committed fixture loads and maps one memory per session", () => {
  const { questions, dropped } = loadLongMemEval(FIXTURE);
  assert.equal(dropped, 0, "the fixture carries no abstention-typed question");
  assert.ok(questions.length >= 4);
  for (const question of questions) {
    const { memories } = haystackMemories(question, "all");
    assert.equal(memories.length, question.haystack_session_ids.length);
    // Every gold session must be reachable as a memory id, or the run would
    // score a guaranteed miss and call it a retrieval result.
    for (const gid of question.answer_session_ids) {
      assert.ok(memories.some((m) => m.session_id === gid), `${gid} has no memory`);
    }
    for (const m of memories) {
      assert.equal(m.id, slug(m.session_id));
      assert.ok(m.title.length > 0 && m.title.length <= 120);
      assert.ok(m.summary.length <= 200);
      assert.ok(m.body.length > 0);
    }
  }
});

test("a session flattens either with both roles or with the user turns only", () => {
  const turns = q().haystack_sessions[0];
  assert.equal(
    sessionText(turns, "all"),
    "user: I booked the flight in March\nassistant: noted",
  );
  assert.equal(sessionText(turns, "user"), "I booked the flight in March");
});

test("a repeated session id collapses, a slug collision stops the run", () => {
  const repeated = q({
    haystack_session_ids: ["s_1", "s_2", "s_1"],
    haystack_sessions: [
      [{ role: "user", content: "a" }],
      [{ role: "user", content: "b" }],
      [{ role: "user", content: "a" }],
    ],
    haystack_dates: ["2023/03/01 (Wed) 10:00", "2023/03/02 (Thu) 11:00", "2023/03/01 (Wed) 10:00"],
  });
  const { memories, duplicates } = haystackMemories(repeated, "all");
  assert.equal(duplicates, 1);
  assert.deepEqual(memories.map((m) => m.session_id), ["s_1", "s_2"]);

  // Two DIFFERENT sessions sharing one slug would silently merge a gold session
  // into a distractor — a wrong number, not a missing one.
  const collide = q({
    haystack_session_ids: ["s.1", "s-1"],
    haystack_dates: ["2023/03/01 (Wed) 10:00", "2023/03/02 (Thu) 11:00"],
  });
  assert.throws(() => haystackMemories(collide, "all"), /both slug to/);
});

test("questions that cannot be scored are refused, not averaged in", () => {
  assert.deepEqual(checkLongMemEvalQuestions([q()]), []);

  const outside = checkLongMemEvalQuestions([q({ answer_session_ids: ["s_99"] })]);
  assert.ok(outside.some((i) => /not in this question's own haystack/.test(i.problem)));

  const empty = checkLongMemEvalQuestions([q({ haystack_sessions: [], haystack_session_ids: [] })]);
  assert.ok(empty.some((i) => /empty haystack/.test(i.problem)));

  const noGold = checkLongMemEvalQuestions([q({ answer_session_ids: [] })]);
  assert.ok(noGold.some((i) => /no gold to be found/.test(i.problem)));

  const ragged = checkLongMemEvalQuestions([q({ haystack_dates: ["2023/03/01 (Wed) 10:00"] })]);
  assert.ok(ragged.some((i) => /haystack arrays disagree/.test(i.problem)));

  const dupIds = checkLongMemEvalQuestions([q(), q()]);
  assert.ok(dupIds.some((i) => /duplicate question_id/.test(i.problem)));

  const blank = checkLongMemEvalQuestions([q({ question: "   " })]);
  assert.ok(blank.some((i) => /empty `question`/.test(i.problem)));
});

test("the dataset hash covers the turn mode, because it changes the documents", () => {
  const one = [q()];
  assert.notEqual(
    longMemEvalDatasetHash(one, "all"),
    longMemEvalDatasetHash(one, "user"),
    "the same file flattened two ways is two datasets",
  );
  // File order must not move the identity, a rewritten question must.
  const two = [q({ question_id: "a" }), q({ question_id: "b" })];
  assert.equal(
    longMemEvalDatasetHash(two, "all"),
    longMemEvalDatasetHash([...two].reverse(), "all"),
  );
  assert.notEqual(
    longMemEvalDatasetHash(two, "all"),
    longMemEvalDatasetHash([two[0], q({ question_id: "b", question: "different" })], "all"),
  );
});

test("a corpus date becomes a frontmatter date or nothing — never today", () => {
  assert.equal(isoDate("2023/04/10 (Mon) 17:50"), "2023-04-10");
  assert.equal(isoDate("last tuesday"), null);
  assert.equal(isoDate(""), null);
});

test("the abstention filter is declared even though the cleaned corpus needs none", () => {
  // It is a no-op on longmemeval_s_cleaned.json today. It exists so that a
  // future release reintroducing those types cannot move the denominator
  // silently — and so the reference harness's filter is mirrored, not guessed.
  assert.ok(ABSTENTION_TYPES.has("multi-session_abs"));
  assert.ok(!ABSTENTION_TYPES.has("multi-session"));
});

test("the LongMemEval registration passes its own rules", () => {
  const reg = loadLongMemEvalRegistration();
  assert.deepEqual(checkLongMemEvalRegistration("structure_registered", reg), []);
  assert.equal((reg.corpus as Record<string, unknown>).variant, "S (cleaned)");
});

test("every figure we compare against has a configuration built to match it", () => {
  // The point of the arm. A comparison target with no matched run is a caveat
  // in prose, and prose does not make two numbers comparable.
  const reg = loadLongMemEvalRegistration();
  const configs = reg.configurations as { matches: string }[];
  for (const id of reg.compared_against as string[]) {
    assert.ok(configs.some((c) => c.matches === id), `${id} has no matched configuration`);
  }

  const orphan = { ...reg, configurations: [configs[0]], compared_against: ["mempalace-longmemeval-r5"] };
  assert.ok(
    checkLongMemEvalRegistration("structure_registered", orphan)
      .some((i) => /not a comparison/.test(i.problem)),
  );
});

test("a registration that hides the variant or the archive rule is rejected", () => {
  const reg = loadLongMemEvalRegistration();
  const noVariant = { ...reg, corpus: { ...(reg.corpus as object), variant: null } };
  assert.ok(
    checkLongMemEvalRegistration("structure_registered", noVariant).some((i) => /variant/.test(i.problem)),
    "Oracle, S and M are three different tasks",
  );

  // #446: the private archive holds the registered M0/M1 baselines that
  // m1-tolerances.json cites by path. This arm never writes there.
  const configs = reg.configurations as Record<string, unknown>[];
  const archived = {
    ...reg,
    configurations: [
      { ...configs[0], measurement: { ...(configs[0].measurement as object), run_out: "~/.bastra/eval-runs/x" } },
      ...configs.slice(1),
    ],
  };
  assert.ok(
    checkLongMemEvalRegistration("structure_registered", archived)
      .some((i) => /private eval-run archive/.test(i.problem)),
  );

  // Numbers do not clear without the identity of the run that produced them:
  // a result nobody can re-derive is a claim, not a measurement.
  const claimed = {
    ...reg,
    status: "numbers_registered",
    configurations: configs.map((c) => ({
      ...c,
      measurement: { ...(c.measurement as object), dataset_hash: null, code_hash: null, results: null },
    })),
  };
  const issues = checkLongMemEvalRegistration("numbers_registered", claimed);
  for (const field of ["dataset_hash", "code_hash", "results"]) {
    assert.ok(
      issues.some((i) => i.where === `configurations.default.measurement.${field}`),
      `${field} must block the stage`,
    );
  }
});

test("each configuration is comparable to the figure it was built for", () => {
  const verdicts = longMemEvalComparability();
  assert.equal(verdicts.length, 2);

  const byConfig = new Map(verdicts.map((v) => [v.configuration, v]));

  // Our default configuration against agentmemory: same absent reader, same
  // absent judge, same absent context budget, same top-20 candidate list.
  assert.equal(byConfig.get("default")!.against, "agentmemory-longmemeval-r5");
  assert.equal(byConfig.get("default")!.blocker, null);

  // MemPalace reads R@5 off a top-50 list, so the default configuration is
  // NOT rankable against it — which is exactly why a second one exists.
  assert.equal(byConfig.get("mempalace-matched")!.against, "mempalace-longmemeval-r5");
  assert.equal(
    byConfig.get("mempalace-matched")!.blocker,
    null,
    "the second configuration exists to remove this blocker by measuring, not by noting it",
  );

  // The blocker is real, not vacuous: the default configuration's own figure
  // still may not be ranked against MemPalace.
  const reg = loadLongMemEvalRegistration();
  const configs = reg.configurations as Record<string, unknown>[];
  const crossed = { ...reg, configurations: [{ ...configs[0], matches: "mempalace-longmemeval-r5" }] };
  assert.match(String(longMemEvalComparability(crossed)[0].blocker), /top_k/);

  const known = new Set(loadForeignFigures().map((f) => f.id));
  for (const v of verdicts) assert.ok(known.has(v.against), `${v.against} must be in foreign-figures.json`);
});

test("the arm writes nothing into the private eval-run archive (#446)", () => {
  for (const f of ["longmemeval-run.ts", "longmemeval-dataset.ts"]) {
    const src = readFileSync(join(import.meta.dirname, "..", "src", f), "utf8");
    // The doc comments say the words; what must not appear is a path being
    // BUILT from them, the way `cue-ob-tmp.ts` builds one.
    assert.ok(
      !/join\([^)]*homedir\(\)[^)]*bastra/.test(src) && !/BASTRA_EVAL_RUNS_DIR/.test(src),
      `${f} must not resolve the archive directory`,
    );
  }
});
