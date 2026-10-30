import { test } from "node:test";
import assert from "node:assert/strict";
import { capSessionContext } from "../src/session-context-cap.js";

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
