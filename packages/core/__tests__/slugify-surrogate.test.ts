/**
 * #938: slugify() cut at 80 UTF-16 units and could leave a lone high surrogate.
 * The Cyrillic/Indic cases are pinned as they are today, deliberately: changing
 * them recomputes existing ids (store-reconcile.ts wikilink normalisation,
 * import-vault.ts re-import) and could break links.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/save-text.js";

test("80-char cut never lands inside a surrogate pair (#938)", () => {
  const id = slugify("a".repeat(79) + "\u{20BB7}" + "b");
  assert.equal(id, "a".repeat(79));
  assert.doesNotMatch(id, /[\uD800-\uDFFF]/);
  // A pair that fits entirely stays whole.
  assert.equal(slugify("a".repeat(78) + "\u{20BB7}"), "a".repeat(78) + "\u{20BB7}");
});

test("known, deliberately unchanged (#938): Cyrillic й folds to и", () => {
  assert.equal(slugify("Мой"), "мои");
});

test("known, deliberately unchanged (#938): Indic words split at combining marks", () => {
  assert.equal(slugify("हिन्दी"), "ह-नद");
});
