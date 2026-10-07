import test from "node:test";
import assert from "node:assert/strict";
import { clipDraftText, cleanDraftText } from "../src/draft-text.js";
import { situationLiterals } from "../src/draft-situation.js";

test("B3 prerequisite: clipping aligns before redaction placeholders at every partial boundary", () => {
  for (let offset = 1; offset < "[REDACTED]".length; offset++) {
    const prefix = "p".repeat(200 - offset);
    const text = prefix + "[REDACTED]suffix";
    const clipped = clipDraftText(text, 200);
    assert.ok(clipped.length <= prefix.length);
    assert.ok(!clipped.includes("["));
  }
  assert.equal(clipDraftText("p".repeat(190) + "[REDACTED]suffix", 200), "p".repeat(190) + "[REDACTED]");
  const path = "/work/" + "p/".repeat(88) + "?password=fixture";
  const stored = cleanDraftText(path);
  assert.ok(!stored.includes("["), "expansion after redaction must not leave a partial marker in paths");
  const lits = situationLiterals({ before: [stored], after: [], reads: [stored], lits: [] });
  assert.ok(lits.every(token => !/REDACT/.test(token)));
});
