/**
 * #1578 — human labels for the draft check, in the #1128 capture store.
 * Invented texts in a temp log directory only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureTrainingItems,
  labelSplit,
  readLabelCandidates,
  recordHumanLabel,
  recordTrainingVerdicts,
  selectForLabelling,
  trainingCapturePath,
  type LabelCandidate,
  type TrainingItem,
} from "../src/training-capture.js";

const now = Date.UTC(2026, 10, 17, 9);

async function withStore(work: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-training-label-"));
  const saved = { log: process.env.BASTRA_LOG_PATH, capture: process.env.BASTRA_TRAINING_CAPTURE };
  process.env.BASTRA_LOG_PATH = join(dir, "logs");
  process.env.BASTRA_TRAINING_CAPTURE = "1";
  try {
    await work();
  } finally {
    for (const [k, v] of [
      ["BASTRA_LOG_PATH", saved.log],
      ["BASTRA_TRAINING_CAPTURE", saved.capture],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    await rm(dir, { recursive: true, force: true });
  }
}

const statement = (quote: string): TrainingItem => ({ type: "statement", quote });
const relation = (a: string, b: string): TrainingItem => ({
  type: "relation",
  a,
  b,
  b_is: "note",
  source: "draft_vault_shadow",
});

test("a human label is written as the reserved record and read back with the model verdict", async () => {
  await withStore(async () => {
    const item = statement("Fixture builds always run on the amber runner.");
    await recordTrainingVerdicts([{ item, verdict: "durable", model: "fixture" }], now);
    const [c] = await readLabelCandidates();
    assert.equal(c.question, "statement");
    assert.equal(c.model_verdict, "durable");
    assert.equal(c.label, undefined);

    assert.equal(await recordHumanLabel(c.key, "request", now), true);
    const lines = (await readFile(trainingCapturePath(), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(lines.at(-1), {
      v: 1,
      type: "human",
      key: c.key,
      ts: new Date(now).toISOString(),
      label: "request",
      question: "statement",
      split: labelSplit(item),
    });
    // The latest label counts.
    await recordHumanLabel(c.key, "durable", now + 1);
    assert.equal((await readLabelCandidates())[0].label, "durable");
  });
});

test("a label outside the item's question or for an unknown key is refused", async () => {
  await withStore(async () => {
    await captureTrainingItems([relation("The amber port is 7001.", "Amber note\nThe amber port is 7002.")], now);
    const [c] = await readLabelCandidates();
    assert.equal(c.question, "relation-note");
    assert.equal(await recordHumanLabel(c.key, "durable", now), false, "a statement kind is no relation");
    assert.equal(await recordHumanLabel("no-such-key", "same", now), false);
    assert.equal(await recordHumanLabel(c.key, "contradiction", now), true);
  });
});

test("labelling works with the capture switch off: it labels what was captured before", async () => {
  await withStore(async () => {
    await captureTrainingItems([statement("Fixture reports go to the shared drive.")], now);
    delete process.env.BASTRA_TRAINING_CAPTURE;
    const [c] = await readLabelCandidates();
    assert.equal(await recordHumanLabel(c.key, "durable", now), true);
  });
});

test("the selection gives every model verdict class its turn, so a rare class is taken whole", () => {
  const cand = (key: string, model_verdict: string): LabelCandidate =>
    ({ key, question: "relation-note", model_verdict, split: "dev", item: {} }) as unknown as LabelCandidate;
  const pool = [
    ...Array.from({ length: 50 }, (_, i) => cand(`d${i}`, "different")),
    ...Array.from({ length: 3 }, (_, i) => cand(`c${i}`, "contradiction")),
    ...Array.from({ length: 10 }, (_, i) => cand(`s${i}`, "same")),
  ];
  const picked = selectForLabelling(pool, "relation-note", 20);
  const count = (v: string): number => picked.filter((c) => c.model_verdict === v).length;
  assert.equal(picked.length, 20);
  assert.equal(count("contradiction"), 3);
  assert.equal(count("different"), 9);
  assert.equal(count("same"), 8);
  // Deterministic and independent of labels already given.
  const again = selectForLabelling(
    pool.map((c) => ({ ...c, label: "same" })),
    "relation-note",
    20
  );
  assert.deepEqual(
    again.map((c) => c.key),
    picked.map((c) => c.key)
  );
  assert.equal(selectForLabelling(pool, "statement", 20).length, 0, "other questions are not mixed in");
});

test("the holdout follows the typed statement, so one sentence never sits on both sides", () => {
  const a = "Fixture deploys need a review first.";
  assert.equal(labelSplit(statement(a)), labelSplit(relation(a, "x")));
  assert.equal(labelSplit(relation(a, "y")), labelSplit(relation(a, "z")));
  const splits = Array.from({ length: 400 }, (_, i) => labelSplit(statement(`Fixture statement ${i}`)));
  const held = splits.filter((s) => s === "holdout").length;
  assert.ok(held > 40 && held < 120, `about a fifth held out, got ${held}/400`);
});

test("statement pairs cannot introduce a held-out sentence through the second operand", async () => {
  await withStore(async () => {
    const dev = "Fixture statement 0";
    const holdout = "Fixture statement 7";
    assert.equal(labelSplit(statement(dev)), "dev");
    assert.equal(labelSplit(statement(holdout)), "holdout");
    const pair = (a: string, b: string): TrainingItem => ({
      type: "relation",
      a,
      b,
      b_is: "statement",
      source: "draft_repeat_shadow",
    });
    const devPair = pair(dev, dev + ".");
    await captureTrainingItems([pair(dev, holdout), pair(holdout, dev), devPair], now);
    const candidates = await readLabelCandidates();
    assert.ok(candidates.length > 0, "same-split comparisons stay eligible for labelling");
    assert.ok(
      candidates.every((c) => c.item.type === "relation" && c.item.b !== holdout && c.item.a !== holdout),
      "mixed-split pairs cannot expose either sentence on the other side"
    );
  });
});
