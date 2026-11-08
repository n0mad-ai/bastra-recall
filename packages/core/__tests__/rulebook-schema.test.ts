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

test("#1399: overwrite binds declarations using the stored user origin; agent notes stay proposals", async () => {
  const root = await mkdtemp(join(tmpdir(), "rulebook-stored-origin-"));
  try {
    for (const origin of ["user-directed", "agent-session", "capture-review"] as const) {
      for (const categoryOnly of [false, true]) {
        const note = { ...input, id: `${origin}-${categoryOnly}`, type: "lesson" as const };
        const saved = await saveMemory(root, SaveMemoryInput.parse({ ...note, write_origin: origin }));
        const declaration = categoryOnly ? { rule_categories: ["correspondence"] } : { rulebook: "always" };
        await saveMemory(root, SaveMemoryInput.parse({ ...note, overwrite: true, applies_when: "When testing fixtures", ...declaration }));
        const fm = matter(await readFile(saved.file_path, "utf8")).data;
        assert.equal(fm.write_origin, origin);
        if (origin === "user-directed") {
          assert.equal(fm.rulebook, categoryOnly ? "on-demand" : "always");
          assert.equal(fm.applies_when, "When testing fixtures");
          assert.equal(fm.rulebook_proposed, undefined);
          if (categoryOnly) assert.deepEqual(fm.rule_categories, ["correspondence"]);
        } else {
          assert.equal(fm.rulebook, undefined);
          assert.equal(fm.rule_categories, undefined);
          assert.equal(fm.rulebook_proposed.rulebook, categoryOnly ? "on-demand" : "always");
        }
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

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

test("legacy defaults require user-directed origin and reserve always for active/floor", () => {
  const fm = FrontmatterSchema.parse(base);
  for (const write_origin of [undefined, "agent-session", "capture-review"] as const) {
    for (const context of [{}, { floor: true }, { activeConvention: true }]) {
      assert.equal(resolveRulebook({ ...fm, write_origin, recall_mode: "reflex" }, context), undefined);
    }
  }
  const directed = { ...fm, write_origin: "user-directed" as const };
  assert.equal(resolveRulebook(directed)?.rulebook, "on-demand");
  for (const context of [{ floor: true }, { activeConvention: true }]) {
    assert.deepEqual(resolveRulebook(directed, context), { rulebook: "always", applies_when: input.summary, applies_when_derived: true });
  }
  for (const type of ["meta-working", "user-preference", "workflow"] as const) {
    assert.equal(resolveRulebook({ ...directed, type })?.rulebook, "on-demand");
    assert.equal(resolveRulebook({ ...directed, type }, { activeConvention: true })?.rulebook, "always");
  }
  assert.equal(resolveRulebook({ ...directed, recall_mode: "reflex" })?.rulebook, "on-demand");
  assert.equal(resolveRulebook({ ...directed, rulebook: "on-demand", applies_when: "When writing" }, { floor: true })?.rulebook, "on-demand");
  assert.equal(resolveRulebook({ ...directed, obsolete: true }, { floor: true }), undefined);
  assert.equal(resolveRulebook({ ...directed, superseded_by: "new-rule" }, { floor: true }), undefined);
  assert.equal(fm.rulebook, undefined);
});

test("malformed rulebook proposals are rejected on save and visibly dropped on lenient load", () => {
  for (const rulebook_proposed of [{ rulebook: "rule", applies_when: "When writing" }, { rulebook: "always" }, "always", null]) {
    assert.equal(SaveMemoryInput.safeParse({ ...input, rulebook_proposed }).success, false);
    const raw = matter.stringify(input.body, { ...base, rulebook_proposed });
    const memory = parseMemoryWith(matter, raw, "fixture.md", 0);
    assert.equal(memory.fm.rulebook_proposed, undefined);
    assert.ok(memory.damaged?.some((d) => d.field === "rulebook_proposed"));
  }
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
    assert.equal((await load()).rulebook, "on-demand");
    assert.equal((await load()).applies_when, "When changing fixtures");
    assert.equal((await load()).rulebook_proposed, undefined);
    const proposed = await saveMemory(root, SaveMemoryInput.parse({ ...input, id: "proposed-rule", rulebook: "always", applies_when: "When writing" }));
    const proposedFm = parseMemoryWith(matter, await readFile(proposed.file_path, "utf8"), proposed.file_path, 0).fm;
    assert.equal(proposedFm.rulebook, undefined);
    assert.deepEqual(proposedFm.rulebook_proposed, { rulebook: "always", applies_when: "When writing" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Phase 4: user-directed workflows formerly found by the GitHub query enter B without lexical matching', () => {
  const fm = FrontmatterSchema.parse({...base, type: 'workflow', write_origin: 'user-directed'});
  assert.equal(resolveRulebook(fm)?.rulebook, 'on-demand');
  assert.equal(resolveRulebook({...fm, write_origin: 'agent-session'}), undefined);
});

test('category proposals merge with the requested tier and preserve pending validator metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rulebook-proposal-merge-'));
  const validator = {tool:'validate_artifact',channel:'fixture',limit:100,unit:'utf16'} as const;
  try {
    const saved = await saveMemory(root, SaveMemoryInput.parse({...input,rulebook:'always',applies_when:'When testing fixtures',rule_categories:['github-issues-prs'],validator}));
    const load = async () => parseMemoryWith(matter, await readFile(saved.file_path,'utf8'),saved.file_path,0).fm;
    let fm=await load();
    assert.equal(fm.rulebook,undefined);assert.equal(fm.validator,undefined);
    assert.deepEqual(fm.rulebook_proposed,{rulebook:'always',applies_when:'When testing fixtures',rule_categories:['github-issues-prs'],validator});
    await saveMemory(root, SaveMemoryInput.parse({...input,overwrite:true,applies_when:'When replying',rule_categories:['correspondence']}));
    fm=await load();assert.equal(fm.rulebook,undefined);
    assert.deepEqual(fm.rulebook_proposed,{rulebook:'always',applies_when:'When replying',rule_categories:['correspondence'],validator});
  } finally {await rm(root,{recursive:true,force:true});}
});

test("#1386: binding a proposal later removes the superseded rulebook_proposed, keeps what the binding does not cover", async () => {
  const root = await mkdtemp(join(tmpdir(), "rulebook-bind-proposal-"));
  const validator = { tool: "validate_artifact", channel: "fixture", limit: 100, unit: "utf16" } as const;
  try {
    const plain = { ...input, type: "lesson" as const };
    const saved = await saveMemory(root, SaveMemoryInput.parse({ ...plain, rulebook: "always", applies_when: "When writing" }));
    const load = async (path = saved.file_path) => parseMemoryWith(matter, await readFile(path, "utf8"), path, 0).fm;
    assert.deepEqual((await load()).rulebook_proposed, { rulebook: "always", applies_when: "When writing" });
    await saveMemory(root, SaveMemoryInput.parse({ ...plain, overwrite: true, write_origin: "user-directed", rulebook: "always", applies_when: "When writing" }));
    let fm = await load();
    assert.equal(fm.rulebook, "always"); assert.equal(fm.applies_when, "When writing");
    assert.equal(fm.rulebook_proposed, undefined);
    assert.doesNotMatch(await readFile(saved.file_path, "utf8"), /rulebook_proposed/);

    // A pending validator the binding does not cover stays proposed, aligned to the bound tier.
    const other = await saveMemory(root, SaveMemoryInput.parse({ ...plain, id: "invented-rule-validator", rulebook: "always", applies_when: "When writing", validator }));
    await saveMemory(root, SaveMemoryInput.parse({ ...plain, id: "invented-rule-validator", overwrite: true, write_origin: "user-directed", rulebook: "on-demand", applies_when: "When replying" }));
    fm = await load(other.file_path);
    assert.equal(fm.rulebook, "on-demand"); assert.equal(fm.validator, undefined);
    assert.deepEqual(fm.rulebook_proposed, { rulebook: "on-demand", applies_when: "When replying", validator });
  } finally { await rm(root, { recursive: true, force: true }); }
});
