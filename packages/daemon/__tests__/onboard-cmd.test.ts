/**
 * `bastra onboard` terminal interview (#645): scripted answers that arrive
 * all at once, or input that ends early, must neither drop lines nor crash
 * with ERR_USE_AFTER_CLOSE.
 *
 * Runner: `node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/onboard-cmd.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { runInterview } from "../src/cli/onboard-cmd.js";
import { questionsFor } from "../src/onboarding.js";

function sink(): PassThrough {
  const out = new PassThrough();
  out.resume();
  return out;
}

test("runInterview: every scripted answer piped in one chunk is kept (none dropped before its prompt)", async () => {
  const input = new PassThrough();
  const personal = questionsFor("personal");
  const lines = ["9", "3", ...personal.map((q, i) => (q.optional ? "" : `answer ${i}`))];
  input.end(lines.join("\n") + "\n");
  const result = await runInterview(input, sink());
  assert.ok(result);
  assert.equal(result.persona, "personal");
  const expected: Record<string, string> = {};
  personal.forEach((q, i) => {
    if (!q.optional) expected[q.id] = `answer ${i}`;
  });
  assert.deepEqual(result.answers, expected);
});

test("runInterview: input that ends mid-interview resolves null instead of throwing ERR_USE_AFTER_CLOSE", async () => {
  const input = new PassThrough();
  input.end("1\nAlex\n");
  assert.equal(await runInterview(input, sink()), null);
});

test("runInterview: EOF while a prompt is pending resolves null (no hang)", async () => {
  const input = new PassThrough();
  const pending = runInterview(input, sink());
  setTimeout(() => input.write("2\n"), 5);
  setTimeout(() => input.end(), 20);
  assert.equal(await pending, null);
});
