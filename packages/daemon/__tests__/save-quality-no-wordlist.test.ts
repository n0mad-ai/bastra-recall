/**
 * Owner decisions of 2026-11-26 on the save_quality advisory:
 *
 * 1. The fixed list of English technology words is gone, together with both
 *    hints that read it ("only generic technology words" for recall_when,
 *    "generic tags" for tags) and the filter that kept those words out of the
 *    example suggestion. The one-word check stays.
 * 2. A hyphenated term counts as several words in the one-word check, in any
 *    language: `Discord-Relay` is not a one-word trigger, `css` still is.
 *
 * Runner: `tsx --test __tests__/save-quality-no-wordlist.test.ts`
 * Real file vault, no mocking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { saveMemoryHandler, type ToolDeps } from "../src/tool-handlers.js";
import { isOneWordTrigger } from "../src/save-quality.js";
import { lowSignalReasons } from "../src/low-signal.js";

async function makeDeps(): Promise<{ deps: ToolDeps; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-no-wordlist-"));
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: dir };
  return {
    deps,
    close: async () => {
      search.stop();
      await vault.stop?.();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

test("hyphenated terms count as several words, in any script", () => {
  for (const trigger of [
    "Discord-Relay",
    "Key-Rotation",
    "Extension-Import-Workflow",
    "ключ-ротация",
    "a--b", // a doubled hyphen still separates two words
    "Discord‐Relay", // U+2010 HYPHEN
    "Discord‑Relay", // U+2011 NON-BREAKING HYPHEN
    "Discord–Relay", // U+2013 EN DASH
    "Discord－Relay", // U+FF0D FULLWIDTH HYPHEN-MINUS
  ]) {
    assert.equal(isOneWordTrigger(trigger), false, trigger);
  }
});

test("a single word stays one word, also with a hyphen at its edge", () => {
  for (const trigger of ["an", "css", "Deploy", "-css", "css-", "--css--", "  css  ", "api_key", ""]) {
    assert.equal(isOneWordTrigger(trigger), true, JSON.stringify(trigger));
  }
});

test("the curator's low-signal report applies the same hyphen rule", () => {
  const mem = (recall_when: string[]) => ({
    fm: {
      id: "m",
      title: "Relay owner recovery",
      summary: "Dead relay owners are recovered on the next hook call.",
      recall_when,
    },
    body: "The relay owner file is replaced when its process no longer exists.",
  });
  assert.deepEqual(lowSignalReasons(mem(["Discord-Relay"])), []);
  assert.deepEqual(lowSignalReasons(mem(["css"])), ["one-word trigger: 'css'"]);
});

test("no hint is derived from a technology word list any more", async () => {
  const { deps, close } = await makeDeps();
  try {
    const res = await saveMemoryHandler(deps, {
      title: "Relay owner recovery",
      type: "lesson",
      summary: "Dead relay owners are recovered on the next hook call.",
      body: "The relay owner file is replaced when its process no longer exists.",
      topic_path: ["hooks", "relay"],
      tags: ["css", "api", "Discord-Relay"],
      scope: "no-wordlist-test",
      recall_when: ["css api", "react ui", "Discord-Relay", "Key-Rotation"],
    });
    assert.ok(res.save_quality);
    const issues = res.save_quality.issues.join("\n");
    assert.doesNotMatch(issues, /generic technology words/);
    assert.doesNotMatch(issues, /generic tags/);
    assert.doesNotMatch(issues, /too short/, "two-word and hyphenated triggers pass the one-word check");
    assert.ok(
      !res.save_quality.suggestions.some((s) => s.includes("project/component/outcome tag")),
      res.save_quality.suggestions.join("\n")
    );
  } finally {
    await close();
  }
});

test("a one-word trigger is still flagged, and the example keeps the summary's words", async () => {
  const { deps, close } = await makeDeps();
  try {
    const res = await saveMemoryHandler(deps, {
      title: "Checkout focus regression",
      type: "lesson",
      summary: "Checkout css focus ring disappears after the button refactor.",
      body: "Restore the outline in the checkout button stylesheet after any refactor.",
      topic_path: ["checkout", "styles"],
      tags: ["checkout"],
      scope: "no-wordlist-test",
      recall_when: ["css", "an"],
    });
    assert.ok(res.save_quality);
    const short = res.save_quality.issues.filter((i) => i.includes("too short/generic"));
    assert.equal(short.length, 2, res.save_quality.issues.join("\n"));
    const example = res.save_quality.suggestions.find((s) => s.startsWith("tighten recall_when"));
    assert.ok(example, res.save_quality.suggestions.join("\n"));
    // The first summary words, unfiltered: "css" was dropped by the old list.
    assert.match(example, /'about to lesson in checkout\/styles: checkout css focus ring disappears'/);
  } finally {
    await close();
  }
});
