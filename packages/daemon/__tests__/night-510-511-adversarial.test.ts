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
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatPendingBlock,
  PENDING_BLOCK_CHAR_BUDGET as B,
} from "../src/pending-suggestions.js";
import { isDokuProject } from "../src/doku-block.js";
import { detectProject, detectProjectDetailed } from "@bastra-recall/core/topics";
import { frustrationCues } from "../src/lexicon.js";
import { detectFrustration, runStopLane, type TranscriptTurn } from "../src/stop-lane.js";

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

test("lexicon (#476): switching BASTRA_LEXICON_DIR gives each dir its own cues — no cross-dir leak", async () => {
  // The loader now reads fresh every call (the mtime cache was removed, which
  // was the sole source of a possible cross-dir leak). This still guards the
  // user-facing invariant — and would catch a leak if a shared cache ever came
  // back keyed by anything coarser than the resolved path.
  const dirA = await mkdtemp(join(tmpdir(), "night476-A-"));
  const dirB = await mkdtemp(join(tmpdir(), "night476-B-"));
  const prev = process.env.BASTRA_LEXICON_DIR;
  try {
    await writeFile(join(dirA, "frustration.txt"), "aaa-only-in-a\n", "utf8");
    await writeFile(join(dirB, "frustration.txt"), "bbb-only-in-b\n", "utf8");

    process.env.BASTRA_LEXICON_DIR = dirA;
    const a = frustrationCues();
    assert.ok(a.includes("aaa-only-in-a"), "dir A's cue must load");
    assert.ok(!a.includes("bbb-only-in-b"), "dir B's cue must not appear under dir A");

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


// ─────────────────── follow-ups: 510/511 review round ───────────────────────

test("formatPendingBlock (#510): an oversized entry that is NOT first is clipped, not dropped whole", () => {
  // The clip was gated on `rendered.length === 0`, so only a FIRST outlier was
  // clipped; a later one fell off silently — exactly the case the clip exists
  // for. Small entry, then the 2,648-token-shape outlier, then a small tail:
  // the outlier must survive as a clip, and only the tail counts as suppressed.
  // The first entry is large on purpose: the clip must fit the REMAINING room,
  // so its content plus the clipped outlier must still sum to the budget.
  const first = "a".repeat(2000);
  const block = formatPendingBlock([
    { ts: 1, blocks: first },
    { ts: 2, blocks: "z".repeat(B * 2) },
    { ts: 3, blocks: "v" },
  ]);
  assert.match(block, /one suggestion was clipped to fit/, "a non-first outlier must be clipped, not dropped");
  assert.ok(block.includes("z".repeat(100)), "the outlier's content must actually be present, clipped");
  assert.match(block, /1 earlier suggestion suppressed/, "only the single trailing entry is suppressed");
  const clipLine = block.split("\n").find((l) => l.startsWith("z"));
  assert.ok(clipLine, "the clipped outlier is rendered on its own line");
  assert.equal(
    first.length + 1 + clipLine.length,
    B,
    "entry content (first + join newline + clip) must fill the budget exactly, not overrun it",
  );
});

test("formatPendingBlock (#510): an outlier with no room left counts as suppressed, not as a bare '…' clip", () => {
  const block = formatPendingBlock([
    { ts: 1, blocks: "a".repeat(B - 1) },
    { ts: 2, blocks: "z".repeat(B * 2) },
  ]);
  assert.doesNotMatch(block, /clipped to fit/, "nothing of the outlier fits — it is not 'clipped'");
  assert.ok(!block.split("\n").includes("…"), "no bare ellipsis line");
  assert.match(block, /1 earlier suggestion suppressed/);
});

test("lexicon (#476): a catastrophic-backtracking cue is rejected, not compiled into the matcher", async () => {
  // `(a+)+b` is a valid RegExp but ReDoS: seconds against ordinary text.
  // isValidCue now rejects the nested-quantifier shape, so the loader drops it
  // and keeps the shipped defaults — the Stop hook stays fast.
  const dir = await mkdtemp(join(tmpdir(), "night476-redos-"));
  const prev = process.env.BASTRA_LEXICON_DIR;
  process.env.BASTRA_LEXICON_DIR = dir;
  try {
    await writeFile(join(dir, "frustration.txt"), "(a+)+b\ngenuinecue\n", "utf8");
    const cues = frustrationCues();
    assert.ok(!cues.includes("(a+)+b"), "the ReDoS cue must be dropped");
    assert.ok(cues.includes("genuinecue"), "a normal cue on the same file still loads");
    assert.ok(cues.includes("again"), "shipped defaults survive");
  } finally {
    if (prev === undefined) delete process.env.BASTRA_LEXICON_DIR;
    else process.env.BASTRA_LEXICON_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("lexicon (#476): an unbalanced cue cannot break out of the wrapper group to smuggle a nested quantifier", async () => {
  // `a+)+(b` compiles when wrapped — as `(?:a+)+(b)`, the exact ReDoS shape the
  // guard exists for — while the guard regex, which needs a `(` before the `)`,
  // never sees it. Each cue must also compile on its own.
  const dir = await mkdtemp(join(tmpdir(), "night476-breakout-"));
  const prev = process.env.BASTRA_LEXICON_DIR;
  process.env.BASTRA_LEXICON_DIR = dir;
  try {
    await writeFile(join(dir, "frustration.txt"), "a+)+(b\na+)*(?:b\na)|(b\n(a{1,})+b\ngenuinecue\n", "utf8");
    const cues = frustrationCues();
    for (const bad of ["a+)+(b", "a+)*(?:b", "a)|(b", "(a{1,})+b"]) {
      assert.ok(!cues.includes(bad), `${bad} must be dropped`);
    }
    assert.ok(cues.includes("genuinecue"), "a normal cue on the same file still loads");
  } finally {
    if (prev === undefined) delete process.env.BASTRA_LEXICON_DIR;
    else process.env.BASTRA_LEXICON_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("lexicon (#476): an over-long cue is dropped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "night476-long-"));
  const prev = process.env.BASTRA_LEXICON_DIR;
  process.env.BASTRA_LEXICON_DIR = dir;
  try {
    const long = "x".repeat(201);
    await writeFile(join(dir, "frustration.txt"), `${long}\n${"y".repeat(200)}\n`, "utf8");
    const cues = frustrationCues();
    assert.ok(!cues.includes(long), "a 201-char cue must be dropped");
    assert.ok(cues.includes("y".repeat(200)), "a 200-char cue is still allowed");
  } finally {
    if (prev === undefined) delete process.env.BASTRA_LEXICON_DIR;
    else process.env.BASTRA_LEXICON_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("lexicon (#476): a cue cut in half by the byte cap is dropped, not loaded as a shorter cue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "night476-halfline-"));
  const prev = process.env.BASTRA_LEXICON_DIR;
  process.env.BASTRA_LEXICON_DIR = dir;
  try {
    const cap = 64 * 1024;
    const head = "#".repeat(cap - 10) + "\n"; // one comment line ending 9 bytes before the cap
    const straddler = "halfwaycueXYZ"; // bytes 0-8 before the cap, the rest past it
    await writeFile(join(dir, "frustration.txt"), head + straddler + "\n", "utf8");
    const cues = frustrationCues();
    assert.ok(!cues.some((c) => c.startsWith("halfway")), "the straddling line must not load in any form");
  } finally {
    if (prev === undefined) delete process.env.BASTRA_LEXICON_DIR;
    else process.env.BASTRA_LEXICON_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("lexicon (#476): the user cue file read is byte-capped — a cue past the cap is ignored", async () => {
  // A pathological file (a 200k-line paste) used to be read and validated in
  // full, seconds per Stop event. The loader now reads at most 64 KiB; a cue
  // sitting past the cap must not appear, one before it must.
  const dir = await mkdtemp(join(tmpdir(), "night476-cap-"));
  const prev = process.env.BASTRA_LEXICON_DIR;
  process.env.BASTRA_LEXICON_DIR = dir;
  try {
    const padding = "# padding comment line\n".repeat(4000); // > 64 KiB of comments
    await writeFile(join(dir, "frustration.txt"), "earlycue\n" + padding + "latecue\n", "utf8");
    const cues = frustrationCues();
    assert.ok(cues.includes("earlycue"), "a cue before the cap loads");
    assert.ok(!cues.includes("latecue"), "a cue past the 64 KiB cap must be ignored");
  } finally {
    if (prev === undefined) delete process.env.BASTRA_LEXICON_DIR;
    else process.env.BASTRA_LEXICON_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("runStopLane (#48): a transcript entry that throws while being read degrades to {} — Never-throws holds", async () => {
  // loadTranscript's array path runs normalizeTurns OUTSIDE its own try/catch,
  // and normalizeTurns reads `obj.content`. A throwing getter there used to
  // propagate straight through runStopLane, violating "Never throws; every
  // failure degrades to {}". The fail-open backstop must swallow it.
  const prevTelemetry = process.env.BASTRA_TELEMETRY;
  process.env.BASTRA_TELEMETRY = "off"; // keep the test from writing a telemetry file
  const payload = {
    hook_event_name: "Stop",
    cwd: "/tmp",
    transcript: [
      {
        role: "user",
        get content(): string {
          throw new Error("boom");
        },
      },
    ],
  } as unknown as Parameters<typeof runStopLane>[0];
  try {
    let out: string | undefined;
    await assert.doesNotReject(async () => {
      out = await runStopLane(payload, "http://127.0.0.1:9"); // no daemon; must not matter
    }, "runStopLane must never throw");
    assert.equal(out, "{}", "a failed evaluation must return the empty JSON envelope");
  } finally {
    if (prevTelemetry === undefined) delete process.env.BASTRA_TELEMETRY;
    else process.env.BASTRA_TELEMETRY = prevTelemetry;
  }
});
