/**
 * Cue lexicons as data (#476 follow-up): the frustration/decision lists moved
 * from `const` arrays in stop-lane.ts to lexicon.ts — shipped defaults plus an
 * optional user-editable file that EXTENDS them. These tests pin the loader
 * contract and prove a file-added cue actually reaches the live heuristic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  frustrationCues,
  decisionCues,
  DEFAULT_FRUSTRATION_CUES,
  DEFAULT_DECISION_CUES,
} from "../src/lexicon.js";
import { detectFrustration, type TranscriptTurn } from "../src/stop-lane.js";

async function withLexiconDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-lexicon-"));
  const prev = process.env.BASTRA_LEXICON_DIR;
  process.env.BASTRA_LEXICON_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.BASTRA_LEXICON_DIR;
    else process.env.BASTRA_LEXICON_DIR = prev;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("lexicon (#476): no file → shipped defaults only", async () => {
  await withLexiconDir(async () => {
    assert.deepEqual(frustrationCues(), [...DEFAULT_FRUSTRATION_CUES]);
    assert.deepEqual(decisionCues(), [...DEFAULT_DECISION_CUES]);
  });
});

test("lexicon (#476): a file EXTENDS the defaults, comments/blanks ignored, dupes dropped", async () => {
  await withLexiconDir(async (dir) => {
    await writeFile(
      join(dir, "frustration.txt"),
      [
        "# my own cues",
        "разозлился",
        "",
        "ach-nein   # inline comment stripped",
        "wieder", // already a default → must not duplicate
      ].join("\n"),
      "utf8",
    );
    const cues = frustrationCues();
    // defaults still present, in front
    assert.deepEqual(cues.slice(0, DEFAULT_FRUSTRATION_CUES.length), [...DEFAULT_FRUSTRATION_CUES]);
    // new entries appended
    assert.ok(cues.includes("разозлился"), "file cue missing");
    assert.ok(cues.includes("ach-nein"), "inline-comment line not cleaned/kept");
    // "wieder" is a default; it must appear exactly once
    assert.equal(cues.filter((c) => c === "wieder").length, 1, "default duplicated");
  });
});

test("lexicon (#476): a bad/unreadable path falls back to defaults, never throws", async () => {
  const prev = process.env.BASTRA_LEXICON_DIR;
  process.env.BASTRA_LEXICON_DIR = join(tmpdir(), "bastra-lexicon-does-not-exist-xyz");
  try {
    assert.deepEqual(frustrationCues(), [...DEFAULT_FRUSTRATION_CUES]);
  } finally {
    if (prev === undefined) delete process.env.BASTRA_LEXICON_DIR;
    else process.env.BASTRA_LEXICON_DIR = prev;
  }
});

test("lexicon (#476): an edit is picked up immediately (read-fresh, no cache)", async () => {
  await withLexiconDir(async (dir) => {
    const path = join(dir, "decision.txt");
    await writeFile(path, "beschlossen\n", "utf8");
    assert.ok(decisionCues().includes("beschlossen"));
    // Rewrite with a different cue — no mtime bump, no cache to invalidate:
    // the very next read must reflect the edit regardless of mtime granularity.
    await writeFile(path, "vereinbart\n", "utf8");
    const after = decisionCues();
    assert.ok(after.includes("vereinbart"), "edit not reflected on next read");
    assert.ok(!after.includes("beschlossen"), "old entry survived the rewrite");
  });
});

test("lexicon (#476): a file-added cue actually fires detectFrustration (end-to-end)", async () => {
  const angry: TranscriptTurn[] = Array.from({ length: 4 }, () => ({
    role: "user",
    // a word that is NOT in the shipped defaults
    content: "ну вот я разозлился на это",
  }));

  // control: without the file, "разозлился" is not a cue → no detection
  await withLexiconDir(async () => {
    assert.equal(detectFrustration(angry), null, "fired without the cue being defined");
  });

  // with the file, the same turns now trip the frustration heuristic
  await withLexiconDir(async (dir) => {
    await writeFile(join(dir, "frustration.txt"), "разозлился\n", "utf8");
    const hit = detectFrustration(angry);
    assert.ok(hit, "file-added cue did not fire detectFrustration");
    assert.equal(hit?.heuristic, "frustration-density");
  });
});

test("lexicon: a cue that is not a valid regex, or hides a quantified group (ReDoS), is dropped — defaults untouched", async () => {
  await withLexiconDir(async (dir) => {
    await writeFile(
      join(dir, "frustration.txt"),
      ["(unclosed", "(a+)+$", "x".repeat(400), "честный-кью"].join("\n"),
      "utf8",
    );
    const cues = frustrationCues();
    assert.deepEqual(cues.slice(0, DEFAULT_FRUSTRATION_CUES.length), [...DEFAULT_FRUSTRATION_CUES]);
    assert.ok(cues.includes("честный-кью"), "valid file cue must still be added");
    for (const bad of ["(unclosed", "(a+)+$", "x".repeat(400)]) {
      assert.ok(!cues.includes(bad), `invalid cue reached the live lexicon: ${bad.slice(0, 20)}`);
    }
    // and the joined lexicon still compiles as one alternation
    assert.doesNotThrow(() => new RegExp(cues.join("|"), "u"));
  });
});

test("lexicon (#517): overlapping repeats without a group are dropped — the issue's table", async () => {
  await withLexiconDir(async (dir) => {
    const bad = [
      String.raw`\w*\w*\w*\w*x`, // 15.6 s on 500 × a
      String.raw`\w*\w*\w*x`, // ~1 s on 2,000 × a
      String.raw`\w*a\w*a\w*x`, // a literal between the repeats does not stop the overlap
      "a?a?a?a?aaaa", // the classic optional explosion
      String.raw`\w{0,1000}\w{0,1000}\w{0,1000}x`,
      String.raw`\W\s*\W\s*\W\s*x`, // the `W` of `\W` is no literal letter
    ];
    const good = [String.raw`\w*\w*x`, String.raw`schon\s+sowas\s+wieder\s+hier`, String.raw`ha\*ha[*+?]{2}`];
    await writeFile(join(dir, "frustration.txt"), [...bad, ...good].join("\n"), "utf8");
    const cues = frustrationCues();
    for (const b of bad) assert.ok(!cues.includes(b), `polynomial cue reached the live lexicon: ${b}`);
    for (const g of good) assert.ok(cues.includes(g), `harmless cue was dropped: ${g}`);

    // What stays allowed stays cheap on the issue's input shape.
    const turns: TranscriptTurn[] = [{ role: "user", content: "a".repeat(8000) + "!" }];
    const t0 = performance.now();
    detectFrustration(turns);
    assert.ok(performance.now() - t0 < 2000, "an allowed cue blocked the event loop");
  });
});

test("lexicon (#517): every shipped default fits the cue grammar a file entry has to meet", async () => {
  await withLexiconDir(async (dir) => {
    // A suffix makes each one a NEW cue, so it is validated instead of deduped.
    const variants = [...DEFAULT_FRUSTRATION_CUES, ...DEFAULT_DECISION_CUES].map((c) => `${c}zz`);
    await writeFile(join(dir, "decision.txt"), variants.join("\n"), "utf8");
    const cues = decisionCues();
    for (const v of variants) assert.ok(cues.includes(v), `default-shaped cue rejected: ${v}`);
  });
});

test(
  "lexicon (#517): a FIFO at the cue path does not block — defaults, immediately",
  { skip: process.platform === "win32" },
  async () => {
    await withLexiconDir(async (dir) => {
      execFileSync("mkfifo", [join(dir, "frustration.txt")]);
      assert.deepEqual(frustrationCues(), [...DEFAULT_FRUSTRATION_CUES]);
    });
  },
);

test("lexicon (#517): a file of exactly 64 KiB keeps its last complete line", async () => {
  await withLexiconDir(async (dir) => {
    const exact = "#".repeat(65528) + "\nlatecue";
    assert.equal(Buffer.byteLength(exact), 65536);
    await writeFile(join(dir, "frustration.txt"), exact, "utf8");
    assert.ok(frustrationCues().includes("latecue"), "complete last line of a 64-KiB file was dropped");

    // One byte over the cap: the last line may be cut, so it is dropped.
    await writeFile(join(dir, "frustration.txt"), exact + "x", "utf8");
    const over = frustrationCues();
    assert.ok(!over.includes("latecue") && !over.includes("latecuex"));
  });
});
