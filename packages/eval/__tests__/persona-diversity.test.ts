import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Diversity guard for the simulated-user survival harness.
 *
 * The robustness envelope (persona-lift.ts) is only honest if the personas are
 * genuinely distinct voices. An LLM asked for N personas can mode-collapse into
 * N rewordings of one voice — which would fake a tight envelope and a
 * meaningless near/far split. This test fails if the bundled personas drift
 * toward each other, the same way boost-drift guards the field weights.
 */
const STOP = new Set(
  (
    "a an the to of in on at for and or but with without when how why is are be it its " +
    "into as my me i you your their them they not no than instead while per after before " +
    "does do that this so what which"
  ).split(" ")
);
function toks(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .filter((t) => t && t.length > 1 && !STOP.has(t))
  );
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const file = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/personas.json"), "utf8")) as {
  personas: Record<string, Record<string, string>>;
};

test("bundled personas are distinct voices, not mode-collapsed", () => {
  const labels = Object.keys(file.personas);
  assert.ok(labels.length >= 3, "need at least 3 personas for an envelope");

  const sims: number[] = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const A = file.personas[labels[i]],
        B = file.personas[labels[j]];
      const ids = Object.keys(A).filter((id) => id in B);
      assert.ok(ids.length > 0, `${labels[i]} and ${labels[j]} share no memory ids`);
      sims.push(ids.reduce((acc, id) => acc + jaccard(toks(A[id]), toks(B[id])), 0) / ids.length);
    }
  }
  const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
  assert.ok(
    mean < 0.35,
    `mean pairwise persona similarity ${mean.toFixed(3)} is too high — personas are mode-collapsed; the survival envelope would be fake`
  );
});

test("personas span the near<->far overlap axis (gradient is emergent)", () => {
  // Each persona-query carries some overlap with how a memory might be triggered;
  // a diverse set should produce both high-overlap and low-overlap queries rather
  // than clustering at one end. We check that the per-persona query sets differ
  // enough that at least one pair is near-orthogonal.
  const labels = Object.keys(file.personas);
  let minPair = 1;
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const A = file.personas[labels[i]],
        B = file.personas[labels[j]];
      const ids = Object.keys(A).filter((id) => id in B);
      const s = ids.reduce((acc, id) => acc + jaccard(toks(A[id]), toks(B[id])), 0) / ids.length;
      minPair = Math.min(minPair, s);
    }
  }
  assert.ok(minPair < 0.15, `most-distinct persona pair similarity ${minPair.toFixed(3)} — voices not spread enough`);
});
