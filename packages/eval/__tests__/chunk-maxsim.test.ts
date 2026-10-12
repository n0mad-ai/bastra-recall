import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceChunks, maxPerDocument } from "../src/chunk-maxsim.js";

test("chunks preserve full source, Unicode and final answer-bearing tail", () => {
  const text = "Anfang 🙂 東京 Präferenz: keine Warnung. ".repeat(170) + "Aktuell gilt nur diese Ausnahme.";
  const chunks = sourceChunks(text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1)!.end, text.length);
  for (const [i, c] of chunks.entries()) {
    assert.equal(c.text, text.slice(c.start, c.end));
    assert.ok(c.tokens <= 400 && c.text.length <= 4000);
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(c.text));
    if (i) assert.ok(c.start <= chunks[i - 1].end && c.end > chunks[i - 1].end);
  }
  assert.ok(chunks.at(-1)!.text.endsWith("Aktuell gilt nur diese Ausnahme."));
});

test("max-sim collapses before document cap and never averages", () => {
  const hits = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, score: 1 - i / 1000 }));
  hits.push({ id: "b0", score: 0.8 });
  const owners = new Map(hits.map(h => [h.id, h.id.startsWith("a") ? "a" : "b"]));
  assert.deepEqual(maxPerDocument(hits, owners), [{ id: "a", score: 1 }, { id: "b", score: 0.8 }]);
});

test("corpus special-token spellings are ordinary source text", () => {
  const text = "Literal <|endoftext|> and <|fim_prefix|> remain verbatim. ".repeat(100);
  const chunks = sourceChunks(text);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1)!.end, text.length);
  for (const c of chunks) assert.equal(c.text, text.slice(c.start, c.end));
});
