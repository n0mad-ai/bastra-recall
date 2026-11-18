import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { redactSecrets } from "../src/scrub.js";
import { COUNT, SEED, caseHash, differentialCases, inputDigest } from "./fixtures/redact-differential-inputs.js";

// #1528 counter-review: the exact output of `redactSecrets` for 20,000 seeded
// inputs was frozen once from the source before the split (cb23b903, parent of
// eba66497) and is compared here byte for byte, without git at run time. The
// only listed exceptions are outputs that #1625 changed on purpose later.
// A deliberate redaction change updates the fixture in the same commit, with
// the reason; never regenerate it from the code under test.
interface Expected {
  seed: number;
  count: number;
  input_sha256: string;
  output_hashes: string;
  exceptions: Array<[number, string]>;
}
const expected = JSON.parse(
  readFileSync(new URL("./fixtures/redact-differential-expected.json", import.meta.url), "utf8")
) as Expected;

test("#1528: the seeded inputs are the ones the expected outputs were frozen for", () => {
  assert.equal(expected.seed, SEED);
  assert.equal(expected.count, COUNT);
  assert.equal(inputDigest([...differentialCases(SEED, COUNT)]), expected.input_sha256);
});

test("#1528: redactSecrets gives the frozen pre-split output for every seeded input", () => {
  const frozen = Buffer.from(expected.output_hashes, "base64");
  const exceptions = new Map(expected.exceptions);
  assert.equal(frozen.length, COUNT * 4);
  const changed: string[] = [];
  let index = 0;
  for (const c of differentialCases(SEED, COUNT)) {
    const actual = caseHash(redactSecrets(c.input, c.home));
    const want = exceptions.has(index)
      ? Buffer.from(exceptions.get(index)!, "hex")
      : frozen.subarray(index * 4, index * 4 + 4);
    if (!actual.equals(want) && changed.length < 10) changed.push(`${index}: ${JSON.stringify(c.input)}`);
    index++;
  }
  assert.equal(index, COUNT);
  assert.deepEqual(changed, []);
});
