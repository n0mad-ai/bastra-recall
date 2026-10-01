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
import { scrubInjectedBlocks } from "@bastra-recall/core/scrub";
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
