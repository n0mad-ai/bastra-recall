import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { FrontmatterSchema, parseMemoryWith } from "../src/schema.js";
import { SaveMemoryInput } from "../src/save-schema.js";
import { saveMemory } from "../src/save.js";
import { resolveRulebook } from "../src/rulebook.js";

const input = { id: "invented-rule", title: "Invented rule", type: "workflow" as const,
  summary: "An invented rule for fixtures", body: "Keep the invented artifact complete.",
  topic_path: ["fixture"], tags: ["fixture"], scope: "all-projects", recall_when: ["invented artifact"] };
const base = { ...input, created: "2026-10-30", updated: "2026-10-30" };

test("additive rulebook fields load in any language; old notes need no migration", () => {
  assert.equal(FrontmatterSchema.parse(base).rulebook, undefined);
  for (const applies_when of ["Beim Schreiben", "When writing", "書くとき", "При записи", "Al escribir"]) {
    const fm = FrontmatterSchema.parse({ ...base, rulebook: "on-demand", applies_when });
    assert.equal(fm.rulebook, "on-demand"); assert.equal(fm.applies_when, applies_when);
  }
  const raw = matter.stringify(input.body, { ...base, rulebook: "always" });
  assert.equal(parseMemoryWith(matter, raw, "fixture.md", 0).fm.rulebook, "always");
  assert.equal(SaveMemoryInput.safeParse({ ...input, rulebook: "always" }).success, false);
  assert.equal(SaveMemoryInput.safeParse({ ...input, rulebook: "always", applies_when: "  " }).success, false);
  assert.equal(SaveMemoryInput.safeParse({ ...input, rulebook: "rule", applies_when: "Anything" }).success, false);
});

test("runtime defaults preserve legacy membership without mutating frontmatter", () => {
  const fm = FrontmatterSchema.parse(base);
  assert.equal(resolveRulebook(fm), undefined);
  assert.deepEqual(resolveRulebook(fm, { activeConvention: true }), { rulebook: "on-demand", applies_when: input.summary });
  assert.equal(resolveRulebook(fm, { floor: true })?.rulebook, "always");
  assert.equal(resolveRulebook({ ...fm, recall_mode: "reflex" })?.rulebook, "on-demand");
  assert.equal(resolveRulebook({ ...fm, write_origin: "user-directed", type: "meta-working" })?.rulebook, "always");
  assert.equal(resolveRulebook({ ...fm, write_origin: "user-directed", type: "meta-working" }, { activeConvention: true })?.rulebook, "always");
  assert.equal(resolveRulebook({ ...fm, write_origin: "user-directed" })?.rulebook, "on-demand");
  assert.equal(resolveRulebook({ ...fm, rulebook_proposed: { rulebook: "always", applies_when: "When writing" } }), undefined);
  assert.equal(resolveRulebook({ ...fm, obsolete: true }, { floor: true }), undefined);
  assert.equal(resolveRulebook({ ...fm, superseded_by: "new-rule" }, { floor: true }), undefined);
  assert.equal(resolveRulebook({ ...fm, type: "project-fact", write_origin: "user-directed" }), undefined);
  assert.equal(fm.rulebook, undefined);
});

test("save/load keeps declarations and proposals across refreshes; only user-directed creates a binding declaration", async () => {
  const root = await mkdtemp(join(tmpdir(), "bastra-rulebook-schema-"));
  try {
    await assert.rejects(saveMemory(root, { ...input, rulebook: "always" }), /applies_when/);
    const saved = await saveMemory(root, SaveMemoryInput.parse({ ...input, rulebook: "always", applies_when: "When writing", write_origin: "user-directed" }));
    const load = async () => parseMemoryWith(matter, await readFile(saved.file_path, "utf8"), saved.file_path, 0).fm;
    assert.equal((await load()).rulebook, "always");
    await saveMemory(root, SaveMemoryInput.parse({ ...input, overwrite: true }));
    assert.equal((await load()).rulebook, "always"); assert.equal((await load()).applies_when, "When writing");
    await saveMemory(root, SaveMemoryInput.parse({ ...input, overwrite: true, rulebook: "on-demand", applies_when: "When changing fixtures" }));
    assert.equal((await load()).rulebook, "always");
    assert.deepEqual((await load()).rulebook_proposed, { rulebook: "on-demand", applies_when: "When changing fixtures" });
    const proposed = await saveMemory(root, SaveMemoryInput.parse({ ...input, id: "proposed-rule", rulebook: "always", applies_when: "When writing" }));
    const proposedFm = parseMemoryWith(matter, await readFile(proposed.file_path, "utf8"), proposed.file_path, 0).fm;
    assert.equal(proposedFm.rulebook, undefined);
    assert.deepEqual(proposedFm.rulebook_proposed, { rulebook: "always", applies_when: "When writing" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
