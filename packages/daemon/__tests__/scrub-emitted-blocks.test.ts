/**
 * The scrub inventory must know every block a bastra hook emits. The Stop
 * lane's same-turn block (<save-eval-now …>, #662) is listed; the harvest relay
 * (<session-harvest …>, #675) was missing from INJECTED_BLOCK_TAGS, so a quote
 * of it survived scrubbing and was read back as conversation prose.
 *
 * The blocks here come from the real emitters, not from literals, so a renamed
 * or newly added tag that the inventory does not follow turns this red.
 *
 * Regression: without "session-harvest" in INJECTED_BLOCK_TAGS
 * (packages/core/src/scrub.ts) the harvest test is red.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/scrub-emitted-blocks.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INJECTED_BLOCK_TAGS, scrubInjectedBlocks } from "@bastra-recall/core/scrub";
import { ONBOARDING_BLOCK_TAG } from "../src/session-onboarding-block.js";
import { formatSameTurnBlock } from "../src/stop-lane-same-turn.js";
import { formatHarvestBlock } from "../src/session-harvest.js";

test("the Stop lane's same-turn block is scrubbed whole", () => {
  const block = formatSameTurnBlock([
    { heuristic: "decision", title: "Queue over polling", type: "decision", body: "we go with the queue" },
  ] as never);
  const { text, removed } = scrubInjectedBlocks(`typed text\n${block}\ntail`);
  assert.equal(text, "typed text\n\ntail");
  assert.ok(removed.includes("save-eval-now" as never), `removed: ${removed.join(",")}`);
});

test("the session-harvest relay block is scrubbed whole", () => {
  const block = formatHarvestBlock({ session_id: "abcd1234-0000", cwd: "/work/proj" }, [
    { kind: "answer", turn: 3, quote: "always deploy to staging first", context: "which host?" },
  ] as never);
  const { text, removed } = scrubInjectedBlocks(`typed text\n${block}`);
  assert.equal(text.trim(), "typed text");
  assert.ok(removed.includes("session-harvest" as never), `removed: ${removed.join(",")}`);
});

test("every hook block tag the daemon sources close is in INJECTED_BLOCK_TAGS", () => {
  // A hook block is emitted as `<tag …>` … `</tag>`, so the literal closing tag
  // in a source file names it. A new block whose tag is not added to the
  // inventory turns this red. The vault-onboarding tag is built from a
  // constant, so it is added by name.
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const emitted = new Set<string>([ONBOARDING_BLOCK_TAG]);
  for (const entry of readdirSync(srcDir, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".ts")) continue;
    const text = readFileSync(join(srcDir, entry), "utf8");
    for (const m of text.matchAll(/<\/([a-z]+(?:-[a-z]+)+)>/g)) emitted.add(m[1]!);
  }
  assert.ok(emitted.size >= 20, `found only ${emitted.size} tags, the source scan is broken`);
  const known = new Set<string>(INJECTED_BLOCK_TAGS);
  const missing = [...emitted].filter((t) => !known.has(t));
  assert.deepEqual(missing, [], `emitted but not in INJECTED_BLOCK_TAGS: ${missing.join(", ")}`);
});
