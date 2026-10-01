/**
 * #710 import: cleanRecallWhen drops bare type words from recall_when, but the
 * save schema needs one entry, so the title stands in when nothing survives.
 * When the title is itself a type word the note kept the very word the log had
 * just printed as "dropped" — the fallback has to say so.
 *
 * Run: npx tsx --test packages/daemon/__tests__/import-recall-when-fallback.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { cleanRecallWhen } from "../src/import/adapters.js";

test("a type-word title that becomes the only trigger is reported", () => {
  const { recall_when, warnings } = cleanRecallWhen(["reference"], "reference");
  assert.deepEqual(recall_when, ["reference"]);
  assert.ok(
    warnings.some((w) => w.includes("falls back to the title 'reference'")),
    `no fallback warning in: ${JSON.stringify(warnings)}`,
  );
});

test("an ordinary title used as the fallback adds no warning of its own", () => {
  const { recall_when, warnings } = cleanRecallWhen(["feedback"], "Deploy checklist");
  assert.deepEqual(recall_when, ["Deploy checklist"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /'feedback' is a memory type word — dropped/);
});

test("a surviving trigger means no fallback and no fallback warning", () => {
  const { recall_when, warnings } = cleanRecallWhen(["reference", "deploy checklist"], "reference");
  assert.deepEqual(recall_when, ["deploy checklist"]);
  assert.ok(!warnings.some((w) => w.includes("falls back")));
});
