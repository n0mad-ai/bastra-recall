import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { Vault, SearchIndex, saveMemory } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { loadMemoryHandler, leanFrontmatter } from "../src/load-memory-handler.js";
import { EditMemoryArgs, editMemoryHandler } from "../src/edit-memory-handler.js";
import { readConventionSource } from "../src/convention-source.js";
import { withSupersession } from "../src/recall-batch.js";
import { MEMORY_TOOL_DEFS } from "../src/tool-defs-memory.js";
import { loadSessionState, mutateSessionState, recordActiveConventions } from "../src/session-state.js";
import type { ToolDeps } from "../src/tool-deps.js";

const input = { id: "invented-rulebook", title: "Invented rulebook", type: "workflow" as const,
  summary: "Invented fixture summary", body: "Keep invented artifacts complete.", topic_path: ["fixture"],
  tags: ["fixture"], scope: "all-projects", recall_when: ["invented fixture"] };

test("wire schema, edit whitelist and lean projection retain rulebook metadata", () => {
  const proposal = { rulebook: "on-demand", applies_when: "При записи" };
  assert.deepEqual(leanFrontmatter({ rulebook: "always", applies_when: "書くとき", rulebook_proposed: proposal }),
    { rulebook: "always", applies_when: "書くとき", rulebook_proposed: proposal });
  assert.equal(EditMemoryArgs.safeParse({ id: input.id, frontmatter: { rulebook: "always", applies_when: "When writing" } }).success, true);
  assert.equal(EditMemoryArgs.safeParse({ id: input.id, frontmatter: { rulebook: "rule" } }).success, false);
  for (const name of ["save_memory", "edit_memory"]) {
    const wire = MEMORY_TOOL_DEFS.find((d) => d.name === name)!.inputSchema as any;
    const props = name === "save_memory" ? wire.properties : wire.properties.frontmatter.properties;
    assert.deepEqual(props.rulebook.enum, ["always", "on-demand"]);
    assert.ok(props.applies_when); assert.ok(props.rulebook_proposed);
  }
});

test("load derives legacy defaults without writing, including active convention state; new declarations stage proposals and existing rule edits apply directly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bastra-rulebook-handler-"));
  const stateDir = process.env.BASTRA_HOOK_STATE_DIR;
  process.env.BASTRA_HOOK_STATE_DIR = join(root, "state");
  const saved = await saveMemory(root, input);
  const original = await readFile(saved.file_path, "utf8");
  const vault = new Vault(root); await vault.init(); const search = new SearchIndex(vault); search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: root };
  t.after(async () => { search.stop(); await vault.stop();
    if (stateDir === undefined) delete process.env.BASTRA_HOOK_STATE_DIR; else process.env.BASTRA_HOOK_STATE_DIR = stateDir;
    await rm(root, { recursive: true, force: true }); });
  const sid = "invented-rulebook-session";
  await mutateSessionState(sid, (state) => recordActiveConventions(state, [{ id: input.id, revision: null }]));
  const loaded = await loadMemoryHandler(deps, { id: input.id }, { sessionId: sid });
  assert.equal(loaded.frontmatter.rulebook, undefined);
  assert.equal(loaded.frontmatter.applies_when, undefined);
  assert.equal(await readFile(saved.file_path, "utf8"), original);
  assert.ok((await loadSessionState(sid)).activeConventions?.some((c) => c.id === input.id));
  await editMemoryHandler(deps, { id: input.id, frontmatter: { rulebook: "always", applies_when: "When writing" } });
  const projected = withSupersession({ id: input.id, score: 1 }, vault, await readConventionSource(vault.get(input.id)));
  assert.deepEqual(projected.rulebook_proposed, { rulebook: "always", applies_when: "When writing" });
  const reread = await loadMemoryHandler(deps, { id: input.id });
  assert.equal(reread.frontmatter.rulebook, undefined);
  assert.deepEqual(reread.frontmatter.rulebook_proposed, { rulebook: "always", applies_when: "When writing" });
  // Explicit metadata must follow the same current bytes as the revision,
  // even when the in-memory index still contains the previous declaration.
  const parsed = matter(await readFile(saved.file_path, "utf8"));
  await writeFile(saved.file_path, matter.stringify(parsed.content, { ...parsed.data,
    rulebook: "always", applies_when: "When inspecting fixtures", write_origin: "user-directed" }));
  const current = await loadMemoryHandler(deps, { id: input.id });
  assert.equal(current.frontmatter.rulebook, "always");
  assert.equal(current.frontmatter.applies_when, "When inspecting fixtures");
  await editMemoryHandler(deps, { id: input.id, frontmatter: { rulebook: "on-demand", applies_when: "When revising fixtures" } });
  const afterEdit = await loadMemoryHandler(deps, { id: input.id });
  assert.equal(afterEdit.frontmatter.rulebook, "on-demand");
  assert.equal(afterEdit.frontmatter.applies_when, "When revising fixtures");
  // The older explicit proposal is preserved, but the edit creates none.
  assert.deepEqual(afterEdit.frontmatter.rulebook_proposed, { rulebook: "always", applies_when: "When writing" });
});


test("edit rejects mixed direct/proposed metadata instead of silently overwriting it", () => {
  for (const patch of [{ rulebook: "always" }, { applies_when: "When writing" }]) {
    assert.equal(EditMemoryArgs.safeParse({ id: input.id, frontmatter: { ...patch,
      rulebook_proposed: { rulebook: "on-demand", applies_when: "When revising" } } }).success, false);
  }
  assert.equal(EditMemoryArgs.safeParse({ id: input.id, frontmatter: {
    rulebook_proposed: { rulebook: "invalid", applies_when: "When writing" } } }).success, false);
});
