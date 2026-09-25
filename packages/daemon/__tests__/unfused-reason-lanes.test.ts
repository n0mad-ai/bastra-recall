/**
 * #565: the unfused wording names the reason the lane really had — in the four
 * lanes that still said "semantic search is off" after the prompt lane was
 * fixed (write, bash-pre, bash-fail, todo). `/hook/recall` sends `degraded`
 * since #342; each lane now passes it to its block.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { formatHintBlock as writeBlock } from "../src/write-lane.js";
import { formatHintBlock as bashPreBlock } from "../src/bash-pre-lane.js";
import { formatHintBlock as bashFailBlock } from "../src/bash-fail-lane.js";
import { formatHintBlock as todoBlock } from "../src/todo-lane.js";

const hits = [{ id: "lex-only", title: "L", type: "lesson", scope: "p", summary: "s", score: 405584.777 }];

const lanes: [string, (degraded?: string) => string][] = [
  ["write", (d) => writeBlock(hits, [], "p", false, false, true, "claude-code", d)],
  ["bash-pre", (d) => bashPreBlock("rm -rf", "destructive", hits, true, "claude-code", null, d)],
  ["bash-fail", (d) => bashFailBlock(hits, true, "claude-code", d)],
  ["todo", (d) => todoBlock(hits, "p", [], true, "claude-code", "TodoWrite", d)],
];

for (const [lane, block] of lanes) {
  test(`#565 ${lane} lane: a timed-out dense arm is not 'semantic search is off'`, () => {
    const timedOut = block("vector-arm-timeout");
    assert.doesNotMatch(timedOut, /semantic search is off/i, "it was on");
    assert.match(timedOut, /semantic search is ON but did not answer inside this lookup's deadline/);
    assert.match(block("vector-arm-empty"), /semantic search is ON but returned nothing/);
    // No reason on the wire still means: there is no second arm.
    assert.match(block(undefined), /semantic search is off/i);
  });
}
