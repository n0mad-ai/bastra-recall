/** #479: version-local suppression of repeatedly unused automatic hints. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hintRevision, hintSuppressionMode, suppressRepeatedUnused, type HintMemory } from "../src/hint-suppression.js";
import type { UsageAggregate } from "../src/usage-sidecar.js";

const memory = (type = "project-fact", body = "Use the deployment checklist.", recall_mode?: string): HintMemory => ({
  fm: {
    title: "Deployment checklist",
    type,
    summary: "The current deployment checklist.",
    recall_when: ["about to deploy staging"],
    recall_mode,
    updated: "2026-09-05",
  },
  body,
});

const ignoredUsage = (m: HintMemory, surfaced = 8): UsageAggregate => ({
  fact: {
    surfaced,
    loaded: 0,
    acted_on: 0,
    revision: hintRevision(m),
    revision_surfaced: surfaced,
    revision_loaded: 0,
    revision_acted_on: 0,
  },
});

test("a non-directive version is suppressed after the configured unused threshold", () => {
  const m = memory();
  const result = suppressRepeatedUnused(
    [{ id: "fact", type: "project-fact", score: 120 }],
    () => m,
    ignoredUsage(m),
    8,
    () => 42,
  );
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.suppressed, [{ id: "fact", type: "project-fact", surfaced: 8, tokens_est: 42 }]);
});

test("below threshold, explicitly loaded, or changed versions stay eligible", () => {
  const original = memory();
  const hit = { id: "fact", type: "project-fact" };
  assert.equal(suppressRepeatedUnused([hit], () => original, ignoredUsage(original, 7), 8).kept.length, 1);
  const loaded = ignoredUsage(original);
  loaded.fact.revision_loaded = 1;
  assert.equal(suppressRepeatedUnused([hit], () => original, loaded, 8).kept.length, 1);
  assert.equal(
    suppressRepeatedUnused([hit], () => memory("project-fact", "Rewritten body."), ignoredUsage(original), 8).kept.length,
    1,
    "content changes produce a new revision and a clean trial",
  );
});

test("directive memories, explicit reflexes, and the zero kill switch are never suppressed", () => {
  for (const m of [memory("preference"), memory("project-fact", "body", "reflex")]) {
    assert.equal(suppressRepeatedUnused([{ id: "fact", type: String(m.fm.type) }], () => m, ignoredUsage(m), 8).kept.length, 1);
  }
  const m = memory();
  assert.equal(suppressRepeatedUnused([{ id: "fact", type: "project-fact" }], () => m, ignoredUsage(m), 0).kept.length, 1);
});

test("#484: der Modus ist Schatten, solange nichts anderes gesetzt ist", () => {
  const prev = process.env.BASTRA_HINT_SUPPRESS;
  try {
    delete process.env.BASTRA_HINT_SUPPRESS;
    assert.equal(hintSuppressionMode(), "shadow");
    for (const [raw, expected] of [["live", "live"], ["LIVE", "live"], ["off", "off"], ["quatsch", "shadow"], ["", "shadow"]]) {
      process.env.BASTRA_HINT_SUPPRESS = raw;
      assert.equal(hintSuppressionMode(), expected, `${raw} → ${expected}`);
    }
  } finally {
    if (prev === undefined) delete process.env.BASTRA_HINT_SUPPRESS;
    else process.env.BASTRA_HINT_SUPPRESS = prev;
  }
});
