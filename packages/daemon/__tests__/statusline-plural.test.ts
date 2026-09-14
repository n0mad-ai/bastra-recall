/**
 * #562 — the statusline counter is visible in every session, so "1 calls" is a
 * typo thousands of turns wide. The renderer and the TUI section both format
 * the same counters and both had it.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RENDERER = join(REPO, "packages", "statusline", "src", "segments", "renderer.ts");
const SECTIONS = join(REPO, "packages", "statusline", "src", "tui", "sections.ts");

test("#562: no counter is interpolated straight in front of a hard-coded plural", async () => {
  for (const path of [RENDERER, SECTIONS]) {
    const src = await readFile(path, "utf8");
    // `${x} calls` / `${x} hits` with nothing choosing the form is the defect.
    const offenders = [...src.matchAll(/\$\{[^}]*(?:recallCount|totalHits)[^}]*\}\s+(calls|hits)\b/g)];
    assert.deepEqual(
      offenders.map((m) => m[0]),
      [],
      `${path} still hard-codes a plural after a counter`,
    );
  }
});

test("#562: both files choose the word from the number", async () => {
  for (const path of [RENDERER, SECTIONS]) {
    const src = await readFile(path, "utf8");
    assert.match(src, /"call"|'call'/, `${path} never mentions the singular form`);
    assert.match(src, /"hit"|'hit'/, `${path} never mentions the singular hit`);
  }
});
