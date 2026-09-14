/**
 * Every third-party GitHub Action is pinned to a full commit SHA.
 *
 * The 2026-09-12 release gate recorded "GitHub Actions use commit-SHA-pinned
 * actions" as a passing check. Counter-review pass 7 found that claim was
 * false: `formula-drift.yml` — added during that very gate work — used
 * `actions/checkout@v4` and `actions/setup-node@v4`. A moving tag is a
 * supply-chain hole: whoever controls it controls what runs in CI, with the
 * repository's token.
 *
 * The interesting part is not the two lines. It is that the claim sat in a
 * review document with nothing checking it, so the next workflow could
 * reintroduce the gap without anything turning red — which is exactly what
 * happened. This test is the check that should have existed when the claim
 * was first written down.
 *
 * Local actions (`./.github/actions/...`) are not pinned and cannot drift:
 * they are this repository's own code at the commit already checked out.
 *
 * Runner: node --test tools/__tests__/workflow-action-pinning.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW_DIR = fileURLToPath(new URL("../../.github/workflows", import.meta.url));
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Every `uses:` reference in the workflow directory, with its origin. */
async function collectUses() {
  const files = (await readdir(WORKFLOW_DIR)).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const out = [];
  for (const file of files) {
    const raw = await readFile(join(WORKFLOW_DIR, file), "utf8");
    raw.split("\n").forEach((line, i) => {
      // Comments describe; they do not run.
      if (/^\s*#/.test(line)) return;
      const m = /\buses:\s*(\S+)/.exec(line);
      if (m) out.push({ file, line: i + 1, ref: m[1] });
    });
  }
  return out;
}

test("every third-party action is pinned to a full commit SHA, not a moving tag", async () => {
  const uses = await collectUses();
  assert.ok(uses.length > 0, "found no `uses:` at all — the collector is broken, not the workflows");

  const unpinned = uses
    .filter((u) => !u.ref.startsWith("./"))
    .filter((u) => !FULL_SHA.test(u.ref.split("@")[1] ?? ""));

  assert.deepEqual(
    unpinned.map((u) => `${u.file}:${u.line} ${u.ref}`),
    [],
    "a moving tag lets whoever controls it run code in CI with this repository's token",
  );
});

test("the pinning check can actually fail — positive control", async () => {
  // A check that cannot go red is not a check. This proves the matcher sees a
  // moving tag, so a green run above means something.
  const sample = [
    { file: "sample.yml", line: 1, ref: "actions/checkout@v4" },
    { file: "sample.yml", line: 2, ref: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" },
    { file: "sample.yml", line: 3, ref: "./.github/actions/local" },
  ];
  const unpinned = sample
    .filter((u) => !u.ref.startsWith("./"))
    .filter((u) => !FULL_SHA.test(u.ref.split("@")[1] ?? ""));
  assert.equal(unpinned.length, 1, "the moving tag must be the only finding");
  assert.equal(unpinned[0].ref, "actions/checkout@v4");
});
