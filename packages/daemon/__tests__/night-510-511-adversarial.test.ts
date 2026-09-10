/**
 * Adversarial verification of the local `local/night-510-511` commits
 * (5284f75 pending char-budget + doku git-root gate; 3ee2b6f lexicon-as-data).
 *
 * These tests were written COLD against the derived invariants, to break the
 * code rather than confirm it. Each green test below was proven to BITE by
 * reverting the specific line it guards (see the review notes). The single
 * `DEFECT` test at the bottom is RED on purpose: it encodes a stated-intent
 * invariant the shipped code violates (see the report) and turns green only
 * once the malformed-lexicon path is fixed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatPendingBlock,
  PENDING_BLOCK_CHAR_BUDGET as B,
} from "../src/pending-suggestions.js";
import { isDokuProject } from "../src/doku-block.js";
import { detectProject, detectProjectDetailed } from "@bastra-recall/core/topics";
import { frustrationCues } from "../src/lexicon.js";
import { detectFrustration, type TranscriptTurn } from "../src/stop-lane.js";

// ─────────────────────────── #510 pending char-budget ───────────────────────

test("formatPendingBlock (#510): the budget boundary is <=, not < — exactly-full is kept whole, one over is clipped", () => {
  // A single entry whose length is EXACTLY the budget must pass through whole:
  // used(0) + sep(0) + block.length(B) <= B is true.
  const atBudget = formatPendingBlock([{ ts: 1, blocks: "x".repeat(B) }]);
  assert.doesNotMatch(atBudget, /clipped/, "an exactly-at-budget entry must not be clipped");
  assert.ok(atBudget.includes("x".repeat(B)), "the full at-budget run must survive intact");

  // One character over must clip.
  const overBudget = formatPendingBlock([{ ts: 1, blocks: "y".repeat(B + 1) }]);
  assert.match(overBudget, /one suggestion was clipped to fit/, "budget+1 must clip");
});

test("formatPendingBlock (#510): the suppressed count is exact and correctly singular/plural", () => {
  const half = Math.floor(B / 2);

  // First entry alone fills the budget; the remaining TWO cannot fit → "2 … suppressed".
  const twoDropped = formatPendingBlock([
    { ts: 1, blocks: "a".repeat(B) },
    { ts: 2, blocks: "b" },
    { ts: 3, blocks: "c" },
  ]);
  assert.match(twoDropped, /2 earlier suggestions suppressed/, "exact drop count must be 2 (entries.length - i)");
  assert.ok(twoDropped.includes("a".repeat(B)), "the oldest, budget-filling entry is kept");
  assert.doesNotMatch(twoDropped, /(?:^|\n)b(?:$|\n)/, "dropped entries must not be rendered");

  // Exactly ONE overflow → singular wording.
  const oneDropped = formatPendingBlock([
    { ts: 1, blocks: "a".repeat(B) },
    { ts: 2, blocks: "b" },
  ]);
  assert.match(oneDropped, /1 earlier suggestion suppressed/, "singular wording for a single drop");
  assert.doesNotMatch(oneDropped, /1 earlier suggestions/, "must not use plural for one");

  // A pair that sums to EXACTLY the budget (half + join-newline + (half-1) == B)
  // must show both with no truncation line at all.
  const bothFit = formatPendingBlock([
    { ts: 1, blocks: "a".repeat(half) },
    { ts: 2, blocks: "b".repeat(half - 1) },
  ]);
  assert.doesNotMatch(bothFit, /suppressed|clipped/, "a pair summing exactly to budget must not truncate");
  assert.ok(
    bothFit.includes("a".repeat(half)) && bothFit.includes("b".repeat(half - 1)),
    "both exactly-fitting entries must be present",
  );
});

test("formatPendingBlock (#510): the budget counts JS string length (UTF-16 units), not bytes", () => {
  // An entry of astral chars: each "😀" is 2 UTF-16 code units but 4 UTF-8 bytes.
  // At (B/2 - 5) chars it is ~2990 code units — under budget — but ~5980 bytes.
  // The char-budget contract says this stays WHOLE; a byte-length regression
  // (Buffer.byteLength) would wrongly clip it.
  const n = Math.floor(B / 2) - 5;
  const entry = "😀".repeat(n);
  assert.ok(entry.length <= B, "precondition: entry is under budget in code units");
  const block = formatPendingBlock([{ ts: 1, blocks: entry }]);
  assert.doesNotMatch(block, /clipped/, "an under-code-unit-budget multibyte entry must not clip");
  assert.ok(block.includes(entry), "the whole multibyte entry must survive");
});

test("formatPendingBlock (#510): a lone oversized first entry is clipped AND the trailing entries are counted", () => {
  // The 2,648-token outlier's shape, with two more waiting behind it: the first
  // is clipped (not dropped whole), and the other two are reported as suppressed.
  const block = formatPendingBlock([
    { ts: 1, blocks: "z".repeat(B * 2) },
    { ts: 2, blocks: "w" },
    { ts: 3, blocks: "v" },
  ]);
  assert.match(block, /one suggestion was clipped to fit/, "the oversized first entry must be clipped, not dropped");
  assert.match(block, /2 earlier suggestions suppressed/, "the two trailing entries must be counted (dropped = length - 1)");
  assert.match(block, /…/, "an ellipsis must mark the cut");
  assert.ok(block.length < B + 400, `the runaway must be bounded, got ${block.length}`);
});

// ─────────────────────────── #511 doku git-root gate ────────────────────────

test("isDokuProject (#511) composed with the live detector: a real repo earns a block, a bare dir does not — and recall's guessed name is untouched", async () => {
  const gitDir = await mkdtemp(join(tmpdir(), "night511-git-"));
  const bareDir = await mkdtemp(join(tmpdir(), "night511-bare-"));
  try {
    await mkdir(join(gitDir, ".git"), { recursive: true });

    // A directory with a .git → git-root → earns the doku block.
    const gitDet = detectProjectDetailed(gitDir);
    assert.equal(gitDet.confidence, "git-root", "a .git dir must detect as git-root");
    assert.equal(isDokuProject(gitDet.confidence), true, "git-root must earn the doku block");

    // A bare temp dir (no .git, not under a known project root) → fallback.
    const bareDet = detectProjectDetailed(bareDir);
    assert.equal(bareDet.confidence, "fallback", "a bare dir must detect as fallback");
    assert.equal(isDokuProject(bareDet.confidence), false, "a fallback dir must NOT earn a doku block");

    // #511 claim: recall/query scoping was NOT tightened — only doku. So the
    // guessed name still survives for the bare dir (detectProject stays non-null),
    // even though it no longer pays for doku tokens.
    assert.notEqual(detectProject(bareDir), null, "recall scope must keep the guessed name for a non-repo dir");
    assert.equal(
      detectProject(bareDir),
      bareDet.confidence === "none" ? null : bareDet.raw,
      "session-lane's derived `project` must stay identical to detectProject()",
    );
  } finally {
    await rm(gitDir, { recursive: true, force: true });
    await rm(bareDir, { recursive: true, force: true });
  }
});

// ─────────────────────────── #476 lexicon-as-data ───────────────────────────

test("lexicon (#476): the mtime cache is keyed by full path — two dirs whose files SHARE an mtime don't leak", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "night476-A-"));
  const dirB = await mkdtemp(join(tmpdir(), "night476-B-"));
  const prev = process.env.BASTRA_LEXICON_DIR;
  try {
    await writeFile(join(dirA, "frustration.txt"), "aaa-only-in-a\n", "utf8");
    await writeFile(join(dirB, "frustration.txt"), "bbb-only-in-b\n", "utf8");
    // Pin BOTH files to the SAME mtime. This is what makes the test bite the
    // key choice: if the cache were keyed by the bare name "frustration"
    // instead of the full resolved path, dir B would hit dir A's cache entry
    // (same name, same mtime → looks fresh) and return A's list. Distinct
    // mtimes would let the mtime guard mask a name-keyed cache, so we remove
    // that variable deliberately.
    const shared = new Date(1_600_000_000_000);
    await utimes(join(dirA, "frustration.txt"), shared, shared);
    await utimes(join(dirB, "frustration.txt"), shared, shared);

    process.env.BASTRA_LEXICON_DIR = dirA;
    const a = frustrationCues();
    assert.ok(a.includes("aaa-only-in-a"), "dir A's cue must load");

    process.env.BASTRA_LEXICON_DIR = dirB;
    const b = frustrationCues();
    assert.ok(b.includes("bbb-only-in-b"), "dir B's cue must load after the flip");
    assert.ok(!b.includes("aaa-only-in-a"), "dir A's cue must NOT leak into dir B's result");
  } finally {
    if (prev === undefined) delete process.env.BASTRA_LEXICON_DIR;
    else process.env.BASTRA_LEXICON_DIR = prev;
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

/**
 * DEFECT (RED): the loader "never throws", but a syntactically INVALID regex
 * fragment in the user file is NOT caught — stop-lane.ts builds it into a
 * RegExp per detection, so `detectFrustration` throws SyntaxError. `runStopLane`
 * calls `evaluateHeuristics` OUTSIDE any try/catch, so the whole Stop lane
 * throws. This breaks BOTH stated contracts:
 *   - lexicon.ts: "A missing or malformed file falls back to defaults, so the
 *     Stop hook is never broken by it."
 *   - runStopLane: "Never throws; every failure path degrades to `{}`."
 * Repro: a single line `schei(` in ~/.bastra/lexicon/frustration.txt.
 * This test encodes the invariant and stays RED until the malformed-regex case
 * falls back to defaults (or is validated/skipped in the loader).
 */
test("lexicon (#476) DEFECT: a regex-invalid cue must fall back to defaults, never break the Stop hook", async () => {
  const dir = await mkdtemp(join(tmpdir(), "night476-bad-re-"));
  const prev = process.env.BASTRA_LEXICON_DIR;
  process.env.BASTRA_LEXICON_DIR = dir;
  try {
    await writeFile(join(dir, "frustration.txt"), "schei(\n", "utf8"); // unbalanced group
    const turns: TranscriptTurn[] = Array.from({ length: 4 }, () => ({
      role: "user" as const,
      content: "again again", // a SHIPPED default cue — must still fire
    }));
    // The invariant: a bad user file degrades to defaults; it must not throw,
    // and the default cue must still drive detection.
    let hit: ReturnType<typeof detectFrustration> = null;
    assert.doesNotThrow(() => {
      hit = detectFrustration(turns);
    }, "a malformed lexicon file must not make detectFrustration throw");
    assert.ok(hit, "shipped defaults must still fire after a bad user file");
  } finally {
    if (prev === undefined) delete process.env.BASTRA_LEXICON_DIR;
    else process.env.BASTRA_LEXICON_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
