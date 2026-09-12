/**
 * #523 — the local links in this repository must resolve.
 *
 * The release-gate review found `docs/architecture.md` pointing at
 * `./docs/survival.md` from inside `docs/`, and CHANGELOG headings for 0.9.1
 * and 0.9.2 with no matching `[0.9.x]: …` definition. Both are invisible to a
 * type-check and to every other test: markdown is only ever resolved by a
 * reader. This test is the reader.
 *
 * It runs everywhere `npm test` runs — it only reads files, spawns nothing and
 * touches no network — so the Linux CI runner executes exactly the same check
 * as a developer's machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkRepository, checkFile } from "../link-check.mjs";

test("every local markdown link in the repository resolves", () => {
  const problems = checkRepository();
  assert.deepEqual(
    problems,
    [],
    `broken local links:\n${problems.map((p) => `  ${p.file}: ${p.kind} ${p.target}`).join("\n")}`,
  );
});

/**
 * Positive control. A checker that never fails is indistinguishable from a
 * checker that cannot fail, so both shapes the repository actually had are
 * reproduced here and must be reported.
 */
test("the checker reports the two shapes the review found", () => {
  const root = mkdtempSync(join(tmpdir(), "bastra-link-check-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "survival.md"), "# survival\n");
  const file = join(root, "docs", "architecture.md");
  writeFileSync(
    file,
    [
      "# architecture",
      "",
      "## [0.9.2] — 2026-08-27",
      "",
      "Details: [survival](./docs/survival.md).",
      "Correct: [survival](./survival.md).",
      "External: [site](https://bastra.io/install).",
      "Anchor: [here](#architecture).",
      "Wiki: [map](../../wiki/Vault-Map).",
      "Regex in code is not a link: `[a-z0-9][a-z0-9_-]*`.",
      "",
      "[0.9.1]: https://example.invalid/v0.9.1",
      "",
    ].join("\n"),
  );

  const problems = checkFile(file, root);
  assert.deepEqual(problems, [
    { file: "docs/architecture.md", kind: "inline", target: "./docs/survival.md" },
    { file: "docs/architecture.md", kind: "reference", target: "[0.9.2]" },
  ]);
});
