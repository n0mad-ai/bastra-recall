/**
 * Label captured draft-check examples by hand (#1578). Local only: it reads and
 * appends to the training capture file beside the event log (0600), nothing
 * else, and asks no model.
 *
 *   node --import tsx tools/draft-judge-eval/label.mts [--question statement|relation-statement|relation-note] [--target 300]
 *
 * Each example shows the texts and asks for the answer the draft check should
 * have given. The model's own verdict is NOT shown before you answer, so the
 * labels measure the model instead of echoing it; it is printed afterwards.
 * Every answer is written at once; quit any time and run again to continue.
 *
 * The set per question is fixed by `selectForLabelling`: the model's verdict
 * classes take turns, so rare classes (contradictions) are taken whole. One
 * statement in five is held out (`split: holdout` on the label) and must not
 * be used to change a prompt or to train. Pairs of typed statements are
 * eligible only when both statements belong to the same split.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  LABEL_QUESTIONS,
  LABEL_TARGET_PER_QUESTION,
  labelChoices,
  readLabelCandidates,
  recordHumanLabel,
  selectForLabelling,
  trainingCapturePath,
  type LabelCandidate,
  type LabelQuestion,
} from "../../packages/daemon/src/training-capture.js";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
const only = arg("question") as LabelQuestion | undefined;
if (only && !LABEL_QUESTIONS.includes(only)) throw new Error(`--question is one of ${LABEL_QUESTIONS.join(", ")}`);
const target = Number(arg("target") ?? LABEL_TARGET_PER_QUESTION);
if (!Number.isInteger(target) || target < 1) throw new Error("--target must be a positive integer");

const candidates = await readLabelCandidates();
if (!candidates.length) {
  console.log(`No captured examples in ${trainingCapturePath()}.`);
  process.exit(0);
}
const questions = only ? [only] : [...LABEL_QUESTIONS];
const sets = new Map(questions.map((q) => [q, selectForLabelling(candidates, q, target)]));
// Interleave the questions so a session spreads over all three.
const queue: LabelCandidate[] = [];
for (let i = 0; [...sets.values()].some((s) => i < s.length); i++)
  for (const s of sets.values()) if (i < s.length && s[i].label === undefined) queue.push(s[i]);

const progress = (): string =>
  [...sets.entries()].map(([q, s]) => `${q} ${s.filter((c) => c.label !== undefined).length}/${s.length}`).join(" · ");

const show = (c: LabelCandidate): string => {
  const it = c.item;
  if (it.type === "statement")
    return `Message:\n  ${it.quote}${it.context ? `\nContext:\n  ${it.context}` : ""}\n\nWhat kind of statement is it?`;
  return `A (typed by the user):\n  ${it.a}\nB (${it.b_is === "note" ? "stored note" : "typed by the user"}):\n  ${it.b}\n\nHow does A relate to B?`;
};

const rl = createInterface({ input: stdin, output: stdout });
console.log(`Store: ${trainingCapturePath()}\nProgress: ${progress()}\n`);
try {
  for (const c of queue) {
    const choices = labelChoices(c.question);
    const keys = choices.map((choice, i) => `${i + 1}=${choice}`).join("  ");
    console.log(`\n── ${c.question} (${c.split}) ──\n${show(c)}`);
    let label: string | undefined;
    for (;;) {
      const answer = (await rl.question(`[${keys}  s=skip  q=quit] `)).trim().toLowerCase();
      if (answer === "q") {
        console.log(`\nStopped. Progress: ${progress()}`);
        process.exit(0);
      }
      if (answer === "s") break;
      label = choices[Number(answer) - 1] ?? choices.find((choice) => choice === answer);
      if (label) break;
    }
    if (!label) continue;
    if (!(await recordHumanLabel(c.key, label))) {
      console.log("Not written: the store no longer holds this example.");
      continue;
    }
    c.label = label;
    console.log(`saved: ${label}  (model said: ${c.model_verdict})  ${progress()}`);
  }
  console.log(`\nAll selected examples are labelled. Progress: ${progress()}`);
} finally {
  rl.close();
}
