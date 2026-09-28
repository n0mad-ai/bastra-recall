/**
 * import namespaces body wikilinks with an ASCII-only regex, while
 * core mirrors `[[x]]` into related[] for every script. A Cyrillic/CJK link in
 * the imported set was left bare and resolved onto a foreign id.
 * Revert-check: with the old `[a-z0-9]` WIKILINK_RE the two tests below fail
 * (Cyrillic/CJK/uppercase links stay un-namespaced).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractWikilinks } from "@bastra-recall/core";
import { namespaceWikilinks, linkKey } from "../src/import/identity.js";

test("non-Latin wikilinks inside the imported set are rewritten to the minted id", () => {
  const idByBase = new Map<string, string>();
  for (const base of ["note", "заметка", "日志", "two"]) {
    idByBase.set(linkKey(base) ?? base, `obsidian-x-${linkKey(base)}`);
  }
  const out = namespaceWikilinks("[[note]] [[заметка]] [[日志]] [[Two]]", "obsidian-x", idByBase);
  assert.equal(out, "[[obsidian-x-note]] [[obsidian-x-заметка]] [[obsidian-x-日志]] [[obsidian-x-two]]");
});

test("after namespacing, every link core would mirror into related[] carries the label", () => {
  const body = "[[note]] [[заметка]] [[日志]] [[Two]] [[ausführung]]";
  const out = namespaceWikilinks(body, "obsidian-x", new Map());
  const links = extractWikilinks(out);
  assert.equal(links.length, 5);
  for (const l of links) assert.ok(l.startsWith("obsidian-x-"), `${l} escaped the imported set`);
});
