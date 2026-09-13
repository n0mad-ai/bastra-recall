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
