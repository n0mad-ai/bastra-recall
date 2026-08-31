/**
 * #365/12 — `startBackgroundCheck`'s docstring must describe the function that
 * is under it.
 *
 * The reported drift was real but the CODE was right: the docstring said the
 * auto-apply "lives in the SessionStart hook, not here", while the body itself
 * stages via `spawnStagedUpdate()` under `mode === "auto"`. That is deliberate
 * (#81: Claude Desktop and a LaunchAgent daemon have no hook surface), it is
 * throttled on the same day marker as the SessionStart path, and `index.ts`
 * consumes the `onAutoStaged` callback to schedule the idle restart. The
 * docstring simply predates #81.
 *
 * WHAT THIS FILE IS: a DOC LINT, not a behaviour test. It matches regexes against
 * the SOURCE TEXT of update-check.ts and executes none of it — it proves nothing
 * about what the daemon does at runtime, and it cannot. Driving the real
 * `startBackgroundCheck` would spawn `bastra update --staged` and read the day
 * marker under the developer's own ~/.bastra, which no test may do; the runtime
 * behaviour is #81's, and it is unchanged by this commit. What a lint CAN buy is
 * the thing that actually broke here: comment and code failing together.
 *
 * So it is deliberately narrow, and pins the two claims as a pair — the body
 * stages, and the docstring does not deny it. If #81 is ever reverted, the first
 * case fails and the docstring gets revisited in the same breath instead of
 * quietly drifting back the other way. Being a text match, it is also brittle by
 * construction: a reword that trips it is a prompt to re-read both halves, not a
 * bug to route around.
 *
 * Run: npx tsx --test packages/daemon/__tests__/update-check-doc-drift.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const SRC = new URL("../src/update-check.ts", import.meta.url);

async function startBackgroundCheckSource(): Promise<{ doc: string; body: string }> {
  const src = await readFile(SRC, "utf8");
  const anchor = src.indexOf("export function startBackgroundCheck");
  assert.ok(anchor > 0, "startBackgroundCheck must still exist in update-check.ts");
  const docStart = src.lastIndexOf("/**", anchor);
  const docEnd = src.indexOf("*/", docStart);
  assert.ok(docStart > 0 && docEnd > docStart, "startBackgroundCheck must carry a docstring");
  // The next declaration opens with its own docstring — that is the body's end.
  const nextDoc = src.indexOf("\n/**", anchor);
  return {
    doc: src.slice(docStart, docEnd + 2),
    body: src.slice(anchor, nextDoc > anchor ? nextDoc : undefined),
  };
}

test("doc-lint: the body really does stage in auto mode (#81) — the premise of the docstring fix", async () => {
  const { body } = await startBackgroundCheckSource();
  assert.match(body, /mode === "auto"/, "auto mode is branched on here");
  assert.match(body, /spawnStagedUpdate\(\)/, "…and this is where the staged update is spawned");
  assert.match(body, /stagedToday\(\)/, "…on the day marker shared with the SessionStart path");
});

test("doc-lint: the docstring no longer sends the reader to the SessionStart hook instead", async () => {
  const { doc } = await startBackgroundCheckSource();
  assert.doesNotMatch(
    doc,
    /not here/i,
    "the auto-apply does live here as well — see the #81 branch in the body",
  );
  assert.match(doc, /#81/, "the docstring names the issue that put staging here");
});
