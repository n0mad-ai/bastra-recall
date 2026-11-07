import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { saveMemoryHandler, type SaveMemoryResult } from "../src/save-memory-handler.js";
import { editMemoryHandler, type EditMemoryResult } from "../src/edit-memory-handler.js";
import { collectRulebookCatalog } from "../src/rulebook-catalog.js";
import type { ToolDeps } from "../src/tool-deps.js";

const base = { title: "Invented write status", summary: "Invented fixture summary", body: "Keep invented artifacts complete.",
  topic_path: ["fixture"], tags: ["fixture"], scope: "all-projects" };

async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<ToolDeps> {
  const root = await mkdtemp(join(tmpdir(), "bastra-rulebook-write-status-"));
  const stateDir = process.env.BASTRA_HOOK_STATE_DIR;
  process.env.BASTRA_HOOK_STATE_DIR = join(root, "state");
  const vault = new Vault(root); await vault.init(); const search = new SearchIndex(vault); search.start();
  t.after(async () => { search.stop(); await vault.stop();
    if (stateDir === undefined) delete process.env.BASTRA_HOOK_STATE_DIR; else process.env.BASTRA_HOOK_STATE_DIR = stateDir;
    await rm(root, { recursive: true, force: true }); });
  return { vault, search, telemetry: new Telemetry(), vaultPath: root };
}

test("#1384: every save_memory response names the delivery tier; a user-directed behavioural note without rulebook says it is no rule", async (t) => {
  const deps = await fixture(t);
  const save = async (args: Record<string, unknown>) => (await saveMemoryHandler(deps, { ...base, recall_when: [`invented ${args.id}`], ...args })) as SaveMemoryResult;

  const note = await save({ id: "user-lesson", type: "lesson", write_origin: "user-directed" });
  assert.match(note.delivery ?? "", /^note only/);
  assert.match(note.delivery ?? "", /not a rule/);
  assert.match(note.delivery ?? "", /rulebook \+ applies_when/);

  const agentNote = await save({ id: "agent-lesson", type: "lesson" });
  assert.match(agentNote.delivery ?? "", /^note only/);
  assert.doesNotMatch(agentNote.delivery ?? "", /rulebook \+ applies_when/);

  const always = await save({ id: "user-rule", type: "lesson", write_origin: "user-directed", rulebook: "always", applies_when: "When writing fixtures" });
  assert.match(always.delivery ?? "", /^rule \(always\): active now/);

  const onDemand = await save({ id: "user-on-demand", type: "lesson", write_origin: "user-directed", rulebook: "on-demand", applies_when: "When writing fixtures" });
  assert.match(onDemand.delivery ?? "", /^rule \(on-demand\): active now/);

  const proposal = await save({ id: "agent-proposal", type: "lesson", rulebook: "always", applies_when: "When writing fixtures" });
  assert.match(proposal.delivery ?? "", /^proposal \(not active\)/);

  // Legacy membership: a user-directed workflow is an on-demand rule even without rulebook.
  const legacy = await save({ id: "user-workflow", type: "workflow", write_origin: "user-directed" });
  assert.match(legacy.delivery ?? "", /^rule \(on-demand\): active now/);
  assert.match(legacy.delivery ?? "", /applies_when/);
});

test("#1385: edit_memory binds a declaration on a user-directed note, keeps it a proposal on an agent note, and says which", async (t) => {
  const deps = await fixture(t);
  const save = (args: Record<string, unknown>) => saveMemoryHandler(deps, { ...base, recall_when: [`invented ${args.id}`], ...args });
  const edit = async (args: Record<string, unknown>) => (await editMemoryHandler(deps, args)) as EditMemoryResult;
  const declaration = { rulebook: "always", applies_when: "When writing fixtures" };

  await save({ id: "user-note", type: "lesson", write_origin: "user-directed" });
  const bound = await edit({ id: "user-note", frontmatter: declaration });
  assert.match(bound.delivery ?? "", /^rule \(always\): active now/);
  const boundFm = deps.vault.get("user-note")!.fm;
  assert.equal(boundFm.rulebook, "always");
  assert.equal(boundFm.applies_when, "When writing fixtures");
  assert.equal(boundFm.rulebook_proposed, undefined);

  await save({ id: "agent-note", type: "lesson" });
  const proposed = await edit({ id: "agent-note", frontmatter: declaration });
  assert.match(proposed.delivery ?? "", /^proposal \(not active\)/);
  const proposedFm = deps.vault.get("agent-note")!.fm;
  assert.equal(proposedFm.rulebook, undefined);
  assert.deepEqual(proposedFm.rulebook_proposed, declaration);

  // Existing rules stay directly editable by an agent (Owner decision #1336).
  const changed = await edit({ id: "user-note", frontmatter: { rulebook: "on-demand", applies_when: "When revising fixtures" } });
  assert.match(changed.delivery ?? "", /^rule \(on-demand\): active now/);
  assert.equal(deps.vault.get("user-note")!.fm.rulebook, "on-demand");

  const bodyOnly = await edit({ id: "agent-note", append: "More invented text." });
  assert.match(bodyOnly.delivery ?? "", /^proposal \(not active\)/);
});

test("#1386: binding a proposal through edit_memory removes the superseded rulebook_proposed", async (t) => {
  const deps = await fixture(t);
  const declaration = { rulebook: "always", applies_when: "When writing fixtures" };
  await saveMemoryHandler(deps, { ...base, id: "user-proposed", type: "lesson", recall_when: ["invented user-proposed"],
    write_origin: "user-directed", rulebook_proposed: declaration });
  assert.deepEqual(deps.vault.get("user-proposed")!.fm.rulebook_proposed, declaration);
  const bound = (await editMemoryHandler(deps, { id: "user-proposed", frontmatter: declaration })) as EditMemoryResult;
  assert.match(bound.delivery ?? "", /^rule \(always\): active now/);
  assert.equal(deps.vault.get("user-proposed")!.fm.rulebook, "always");
  assert.equal(deps.vault.get("user-proposed")!.fm.rulebook_proposed, undefined);
});

test("#1392: a user-directed category change binds the same way through save_memory overwrite and edit_memory", async (t) => {
  const deps = await fixture(t);
  const declaration = { rulebook: "on-demand", applies_when: "When replying to invented fixtures", rule_categories: ["correspondence"] };
  for (const id of ["via-save", "via-edit"]) {
    await saveMemoryHandler(deps, { ...base, id, type: "lesson", recall_when: [`invented ${id}`], write_origin: "user-directed" });
  }
  const saved = (await saveMemoryHandler(deps, { ...base, id: "via-save", type: "lesson", recall_when: ["invented via-save"],
    write_origin: "user-directed", overwrite: true, ...declaration })) as SaveMemoryResult;
  const edited = (await editMemoryHandler(deps, { id: "via-edit", frontmatter: declaration })) as EditMemoryResult;
  const catalog = await collectRulebookCatalog(deps.vault, { project: null, active: [], floors: async () => [], allProjects: true });
  for (const [id, result] of [["via-save", saved], ["via-edit", edited]] as const) {
    const fm = deps.vault.get(id)!.fm;
    assert.equal(fm.rulebook, "on-demand", id);
    assert.deepEqual(fm.rule_categories, ["correspondence"], id);
    assert.equal(fm.rulebook_proposed, undefined, id);
    assert.match(result.delivery ?? "", /^rule \(on-demand\): active now/, id);
    assert.deepEqual(catalog.entries.find(e => e.id === id)?.rule_categories, ["correspondence"], id);
  }
});

test("#1393: a private declaration is reported as bound but not delivered, matching the catalog that excludes it", async (t) => {
  const deps = await fixture(t);
  const saved = (await saveMemoryHandler(deps, { ...base, id: "private-rule", type: "lesson", recall_when: ["invented private-rule"],
    write_origin: "user-directed", rulebook: "always", applies_when: "When writing fixtures", sensitivity: "private" })) as SaveMemoryResult;
  const catalog = await collectRulebookCatalog(deps.vault, { project: null, active: [], floors: async () => [], allProjects: true });
  assert.equal(deps.vault.get("private-rule")!.fm.rulebook, "always");
  assert.equal(catalog.entries.some(e => e.id === "private-rule"), false);
  assert.doesNotMatch(saved.delivery ?? "", /active now|loaded in every session|listed in the rule catalog/);
  assert.match(saved.delivery ?? "", /^rule \(always\): bound, not delivered/);
  assert.match(saved.delivery ?? "", /private/);
});

test("#1394: a validator bound after its rule leaves no stale validator proposal (save and edit)", async (t) => {
  const deps = await fixture(t);
  const validator = { tool: "validate_artifact", channel: "fixture", limit: 100, unit: "utf16" };
  const declaration = { rulebook: "always", applies_when: "When writing fixtures" };
  const save = (args: Record<string, unknown>) => saveMemoryHandler(deps, { ...base, id: "via-save", type: "lesson", recall_when: ["invented via-save"], ...args });

  await save({ ...declaration, validator });
  await save({ overwrite: true, write_origin: "user-directed", ...declaration });
  assert.deepEqual(deps.vault.get("via-save")!.fm.rulebook_proposed, { ...declaration, validator });
  await save({ overwrite: true, write_origin: "user-directed", validator });
  let fm = deps.vault.get("via-save")!.fm;
  assert.equal(fm.rulebook, "always"); assert.deepEqual(fm.validator, validator);
  assert.equal(fm.rulebook_proposed, undefined);

  await saveMemoryHandler(deps, { ...base, id: "via-edit", type: "lesson", recall_when: ["invented via-edit"],
    write_origin: "user-directed", rulebook_proposed: { ...declaration, validator } });
  await editMemoryHandler(deps, { id: "via-edit", frontmatter: declaration });
  assert.deepEqual(deps.vault.get("via-edit")!.fm.rulebook_proposed, { ...declaration, validator });
  await editMemoryHandler(deps, { id: "via-edit", frontmatter: { validator } });
  fm = deps.vault.get("via-edit")!.fm;
  assert.equal(fm.rulebook, "always"); assert.deepEqual(fm.validator, validator);
  assert.equal(fm.rulebook_proposed, undefined);

  // An unrelated pending part stays: binding only the validator keeps a proposed tier change.
  await saveMemoryHandler(deps, { ...base, id: "tier-pending", type: "lesson", recall_when: ["invented tier-pending"],
    write_origin: "user-directed", ...declaration });
  await editMemoryHandler(deps, { id: "tier-pending", frontmatter: { rulebook_proposed: { rulebook: "on-demand", applies_when: "When revising fixtures", validator } } });
  await editMemoryHandler(deps, { id: "tier-pending", frontmatter: { validator } });
  assert.deepEqual(deps.vault.get("tier-pending")!.fm.rulebook_proposed, { rulebook: "on-demand", applies_when: "When revising fixtures" });
});

test("#1395: delivery describes the same write as the returned revision, even when a second writer lands in between", async (t) => {
  const deps = await fixture(t);
  const declaration = { rulebook: "always", applies_when: "When writing fixtures" };
  await saveMemoryHandler(deps, { ...base, id: "raced", type: "lesson", recall_when: ["invented raced"], write_origin: "user-directed", ...declaration });
  // Pause only writer A's post-write tail (the first reindex after its write); writer B runs to completion meanwhile.
  const reindex = deps.vault.reindexFile.bind(deps.vault);
  let gate: { paused: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
  const pauseNextReindex = () => (gate = { paused: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() });
  deps.vault.reindexFile = async (path: string) => {
    const current = gate; gate = undefined;
    if (current) { current.paused.resolve(); await current.release.promise; }
    return reindex(path);
  };
  const onDemand = { rulebook: "on-demand", applies_when: "When revising fixtures" };

  let g = pauseNextReindex();
  const a = editMemoryHandler(deps, { id: "raced", frontmatter: onDemand }) as Promise<EditMemoryResult>;
  await g.paused.promise;
  const b = (await editMemoryHandler(deps, { id: "raced", frontmatter: declaration })) as EditMemoryResult;
  g.release.resolve();
  const resultA = await a;
  assert.notEqual(resultA.revision, b.revision);
  assert.match(b.delivery ?? "", /^rule \(always\)/);
  assert.match(resultA.delivery ?? "", /^rule \(on-demand\)/);

  // The same holds for save_memory.
  g = pauseNextReindex();
  const saveA = saveMemoryHandler(deps, { ...base, id: "raced", type: "lesson", recall_when: ["invented raced"],
    write_origin: "user-directed", overwrite: true, ...onDemand }) as Promise<SaveMemoryResult>;
  await g.paused.promise;
  await editMemoryHandler(deps, { id: "raced", frontmatter: declaration });
  g.release.resolve();
  assert.match((await saveA).delivery ?? "", /^rule \(on-demand\)/);
});
