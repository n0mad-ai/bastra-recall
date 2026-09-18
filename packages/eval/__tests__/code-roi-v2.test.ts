import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
// @ts-expect-error — plain .mjs measurement scripts, no declarations
import { parseTranscript, score, clusterBootstrap } from "../code-roi/v2/evaluate.mjs";
// @ts-expect-error — plain .mjs measurement scripts, no declarations
import { rng } from "../code-roi/v2/select.mjs";
// @ts-expect-error — plain .mjs measurement scripts, no declarations
import { promptFor } from "../code-roi/v2/run-arms.mjs";

/**
 * The scoring of the code-awareness measurement, registration v2 (#588).
 * Fixed before any arm ran; these tests hold the rules the report depends on.
 */

const line = (o: unknown): string => JSON.stringify(o);

function transcript(finalText: string, extra: unknown[] = []): string {
  return [
    ...extra.map(line),
    line({ type: "result", subtype: "success", is_error: false, num_turns: 4, result: finalText }),
  ].join("\n");
}

describe("code-roi v2: reading an arm's transcript", () => {
  it("takes the LAST FILES line and normalizes the paths", () => {
    const t = parseTranscript(
      transcript('draft FILES: ["x"]\nthinking…\nFILES: ["./packages/a/src/x.ts", "/tree/packages/b/src/y.ts"]'),
      "/tree",
    );
    assert.equal(t.noAnswer, false);
    assert.deepEqual(t.named, ["packages/a/src/x.ts", "packages/b/src/y.ts"]);
    assert.equal(t.turns, 4);
  });

  it("treats a missing FILES line, an error or no result as no answer", () => {
    assert.equal(parseTranscript(transcript("I think a.ts"), "/t").noAnswer, true);
    assert.equal(parseTranscript(line({ type: "result", is_error: true, result: 'FILES: ["a"]' }), "/t").noAnswer, true);
    assert.equal(parseTranscript("", "/t").noAnswer, true);
  });

  it("counts the characters of every tool result, and find_code calls and empties", () => {
    const t = parseTranscript(
      transcript("FILES: []", [
        { type: "assistant", message: { content: [{ type: "tool_use", id: "u1", name: "mcp__code__find_code" }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: '{ "status": "no_answer" }' }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "u2", name: "Bash" }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u2", content: [{ type: "text", text: "12345" }] }] } },
      ]),
      "/t",
    );
    assert.equal(t.findCodeCalls, 1);
    assert.equal(t.findCodeEmpty, 1);
    assert.equal(t.contextChars, '{ "status": "no_answer" }'.length + 5);
  });
});

describe("code-roi v2: scoring", () => {
  it("scores recall and precision, never crediting the changed file itself", () => {
    const s = score(["f.ts", "a.ts", "x.ts"], ["a.ts", "b.ts"], "f.ts");
    assert.equal(s.recall, 0.5);
    assert.equal(s.precision, 0.5);
  });

  it("gives an empty answer precision 1 and recall 0", () => {
    assert.deepEqual(score([], ["a.ts"], "f.ts"), { recall: 0, precision: 1 });
  });
});

describe("code-roi v2: the clustered bootstrap", () => {
  it("is deterministic under the registered seed", () => {
    const rows = [
      { file: "p/a/x.ts", d: 0.2 },
      { file: "p/a/y.ts", d: 0.1 },
      { file: "p/b/z.ts", d: -0.1 },
      { file: "p/c/w.ts", d: 0.3 },
    ];
    const a = clusterBootstrap(rows, "d");
    const b = clusterBootstrap(rows, "d");
    assert.deepEqual(a, b);
    assert.equal(a.clusters, 4, "one group per changed file (registration v3)");
    assert.ok(a.lo <= a.hi);
  });

  it("the arm-order generator is seeded and stable", () => {
    const x = rng(20260918);
    const y = rng(20260918);
    assert.deepEqual([x(), x(), x()], [y(), y(), y()]);
  });
});

describe("code-roi v2: the prompt", () => {
  it("states the change and the answer format, and never the truth", () => {
    const p = promptFor({ file: "packages/a/src/f.ts", subject: "change f", diff: "+x\n", truth: ["SECRET.ts"] });
    assert.match(p, /packages\/a\/src\/f\.ts/);
    assert.match(p, /FILES: \[/);
    assert.doesNotMatch(p, /SECRET/);
  });
});
