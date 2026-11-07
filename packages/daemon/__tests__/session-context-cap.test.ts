import { test } from "node:test";
import assert from "node:assert/strict";
import { capSessionContext, findFrames } from "../src/session-context-cap.js";

test("empty kernel does not discard other fitting session sections", () => {
  const care = "<vault-care>Keep this care note.</vault-care>";
  const imports = "<import-review>Keep this import note.</import-review>";
  const taxonomy = `<vault-taxonomy>${"x".repeat(11000)}</vault-taxonomy>`;
  const r = capSessionContext(care + taxonomy + imports, []);
  assert.ok(r.text.length <= 9900); assert.ok(r.text.includes(care)); assert.ok(r.text.includes(imports));
  assert.deepEqual(r.deferred, ["vault-taxonomy"]);
  assert.match(r.text, /Deferred session sections: vault-taxonomy/);
});
test("only necessary whole sections are deferred and named; kernel and language stay whole", () => {
  const kernel = `<rule-kernel>${"a".repeat(7000)}</rule-kernel>`;
  const language = "<memory-language>de</memory-language>";
  const care = `<vault-care>${"c".repeat(1000)}</vault-care>`;
  const taxonomy = `<vault-taxonomy>${"t".repeat(2000)}</vault-taxonomy>`;
  const update = "<update>Current update.</update>";
  const r = capSessionContext(kernel + language + care + taxonomy + update, [kernel, language]);
  assert.ok(r.text.length <= 9900); assert.ok(r.text.includes(kernel)); assert.ok(r.text.includes(language));
  assert.ok(r.text.includes(taxonomy)); assert.ok(r.text.includes(update)); assert.deepEqual(r.deferred, ["vault-care"]);
});
test("a fitting context remains byte-identical", () => {
  const text = "\n<rule-kernel>Whole text.</rule-kernel>\n<update>Some text.</update>\n";
  assert.deepEqual(capSessionContext(text, []), { text, deferred: [] });
});
test("#1363: eviction stays bounded with thousands of small sections", () => {
  const started = performance.now();
  const result = capSessionContext("<a>x</a>".repeat(4000), []);
  assert.ok(performance.now() - started < 2000, "small-section eviction must finish within 2 seconds");
  assert.ok(result.text.length <= 9900);
  assert.deepEqual(result.deferred, ["a"]);
});
test("#1363: many distinct deferred names cannot exhaust the context budget", () => {
  const input = Array.from({ length: 2000 }, (_, i) => `<a${i}>x</a${i}>`).join("");
  const result = capSessionContext(input, []);
  assert.ok(result.text.length <= 9900);
  assert.ok(result.deferred.length > 0);
  for (const name of result.deferred) assert.ok(!result.text.includes(`<${name}>`));
});
test("#1363: protected overflow preserves whole required sections without throwing", () => {
  const kernel = `<rule-kernel>${"k".repeat(11000)}</rule-kernel>`;
  const language = "<memory-language>de</memory-language>";
  const result = capSessionContext(kernel + "<optional>note</optional>" + language, [kernel, language]);
  assert.ok(result.text.includes(kernel));
  assert.ok(result.text.includes(language));
  assert.ok(!result.text.includes("<optional>"));
  assert.deepEqual(result.deferred, ["optional"]);
});
test("framing keeps sections, order and unmatched text exactly as protocol tags define them", () => {
  const cases: Array<[string, Array<[string, string]>]> = [
    ["plain text", []],
    ["<a>x</a>", [["<a>x</a>", "a"]]],
    ["lead \n <a>x</a> \n<b y=\"1\">z</b> tail", [[" \n <a>x</a>", "a"], [" \n<b y=\"1\">z</b>", "b"]]],
    ["<a><a>x</a></a>", [["<a><a>x</a>", "a"]]],
    ["<a><b>x</a></b>", [["<a><b>x</a>", "a"]]],
    ["<a>x</A><A>y</A>", [["<A>y</A>", "A"]]],
    ["<a-1\nattr<x>y</a-1>", [["<a-1\nattr<x>y</a-1>", "a-1"]]],
    ["<a/>x</a>", []],
    ["<1>x</1><a>y</a >", []],
    ["<a", []],
    ["<a ", []],
    ["<a b>x</a>", [["<a b>x</a>", "a"]]],
    ["<u>open <a>x</a>", [[" <a>x</a>", "a"]]],
    ["<a></a>", [["<a></a>", "a"]]],
    ["<a>x</a> <b>y</b>", [["<a>x</a>", "a"], [" <b>y</b>", "b"]]],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(findFrames(input).map(f => [input.slice(f.start, f.end), f.name]), expected, JSON.stringify(input));
  }
});
test("framing stays linear on adversarial session context (js/polynomial-redos)", () => {
  const n = 60000;
  const names = Array.from({ length: n }, (_, i) => `<a${i}>`).join("");
  const inputs = { unclosedAttrs: "<A\t".repeat(n), mixedCase: "<A><a>".repeat(n), spaces: " ".repeat(3 * n), distinctNames: names };
  for (const [label, input] of Object.entries(inputs)) {
    const started = performance.now();
    const result = capSessionContext(input, []);
    const elapsed = performance.now() - started;
    assert.deepEqual(result.deferred, ["session text"], label);
    assert.ok(elapsed < 2000, `${label} took ${Math.round(elapsed)} ms`);
  }
});
