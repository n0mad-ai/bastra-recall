import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { Vault, SearchIndex, saveMemory, type SaveMemoryInput } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { loadMemoryHandler } from "../src/load-memory-handler.js";
import { recallHandler } from "../src/recall-handler.js";
import { editMemoryHandler } from "../src/edit-memory-handler.js";
import { assembleHookRecallPayload } from "../src/hook-recall-payload.js";
import * as sources from "../src/convention-source.js";
import { addFloor } from "../src/floors.js";
import { mutateSessionState, recordActiveConventions } from "../src/session-state.js";
import { TRUSTED_LOCAL_APP } from "../src/private-access.js";
import type { ToolDeps } from "../src/tool-deps.js";

const base = { title: "Invented artifact rule", type: "workflow" as const, summary: "Invented artifact summary",
  body: "Keep the invented artifact complete.", topic_path: ["fixture"], tags: ["fixture"], scope: "all-projects",
  recall_when: ["invented artifact"] };
const metadata = (fm: Record<string, unknown>) => Object.fromEntries(
  ["rulebook", "applies_when", "applies_when_derived", "rulebook_proposed"].filter(k => fm[k] !== undefined).map(k => [k, fm[k]]));
async function fixture(t: { after: (fn: () => unknown) => void }, extra: Partial<SaveMemoryInput> = {}) {
  const root = await mkdtemp(join(tmpdir(), "bastra-rulebook-projections-"));
  const old = { state: process.env.BASTRA_HOOK_STATE_DIR, floors: process.env.BASTRA_FLOORS_PATH };
  process.env.BASTRA_HOOK_STATE_DIR = join(root, "state"); process.env.BASTRA_FLOORS_PATH = join(root, "floors.json");
  const saved = await saveMemory(root, { ...base, id: "invented-artifact", ...extra });
  const vault = new Vault(root); await vault.init(); const search = new SearchIndex(vault); search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: root };
  t.after(async () => { search.stop(); await vault.stop();
    for (const [key, value] of [["BASTRA_HOOK_STATE_DIR", old.state], ["BASTRA_FLOORS_PATH", old.floors]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    } await rm(root, { recursive: true, force: true }); });
  const sid = "rulebook-projection-session";
  async function hook() {
    const hits = search.recall("invented artifact", { k: 10 });
    const conventionSources = await sources.readRulebookSources(vault, hits.map(h => h.id), sid);
    return assembleHookRecallPayload({ hits, candidatePool: [], vault, maxTokens: 0, totalLatencyMs: 0,
      recallId: "fixture", weakResult: false, noHome: false, hookProject: null,
      hybridActiveAtRecall: false, degradedReason: undefined, conventionSources }).payload;
  }
  return { root, saved, vault, deps, sid, hook };
}

test("recall, hook and load agree on active/floor defaults and mark summary fallbacks", async (t) => {
  const f = await fixture(t, { write_origin: "user-directed" });
  await mutateSessionState(f.sid, state => recordActiveConventions(state, [{ id: "invented-artifact", revision: null }]));
  for (const active of [true, false]) {
    if (!active) {
      await mutateSessionState(f.sid, state => { state.activeConventions = []; });
      await addFloor({ memory_id: "invented-artifact", condition: "fixture", reason: "Invented floor" });
    }
    const loaded = await loadMemoryHandler(f.deps, { id: "invented-artifact" }, { sessionId: f.sid });
    const recall = await recallHandler(f.deps, { query: "invented artifact", min_score: 0 }, { session_id: f.sid });
    const hook = await f.hook();
    const expected = { rulebook: "always", applies_when: base.summary, applies_when_derived: true };
    assert.deepEqual(metadata(loaded.frontmatter), expected);
    assert.deepEqual(metadata(recall.hits[0] as Record<string, unknown>), expected);
    assert.deepEqual(metadata(hook.hits[0] as Record<string, unknown>), expected);
  }
  // Current source beats a stale index consistently on all three paths.
  const parsed = matter(await readFile(f.saved.file_path, "utf8"));
  await writeFile(f.saved.file_path, matter.stringify(parsed.content, { ...parsed.data, rulebook: "on-demand", applies_when: "When revising" }));
  const loaded = await loadMemoryHandler(f.deps, { id: "invented-artifact" }, { sessionId: f.sid });
  const recall = await recallHandler(f.deps, { query: "invented artifact", min_score: 0 }, { session_id: f.sid });
  const hook = await f.hook();
  const expected = { rulebook: "on-demand", applies_when: "When revising" };
  assert.deepEqual(metadata(loaded.frontmatter), expected);
  assert.deepEqual(metadata(recall.hits[0] as Record<string, unknown>), expected);
  assert.deepEqual(metadata(hook.hits[0] as Record<string, unknown>), expected);
});

test("edit can propose an applies_when description for a legacy rule", async (t) => {
  const f = await fixture(t, { type: "meta-working", write_origin: "user-directed" });
  await editMemoryHandler(f.deps, { id: "invented-artifact", frontmatter: { applies_when: "Beim Prüfen" } });
  const loaded = await loadMemoryHandler(f.deps, { id: "invented-artifact" });
  assert.deepEqual(loaded.frontmatter.rulebook_proposed, { rulebook: "on-demand", applies_when: "Beim Prüfen" });
  assert.equal(loaded.frontmatter.applies_when_derived, true);
});

test("private rule metadata stays private across recall, hook and load, including a stale public index", async (t) => {
  const f = await fixture(t, { rulebook: "always", applies_when: "When inspecting secrets", write_origin: "user-directed" });
  const parsed = matter(await readFile(f.saved.file_path, "utf8"));
  await writeFile(f.saved.file_path, matter.stringify(parsed.content, { ...parsed.data, sensitivity: "private" }));
  await assert.rejects(loadMemoryHandler(f.deps, { id: "invented-artifact" }), /not found/);
  assert.deepEqual((await recallHandler(f.deps, { query: "invented artifact", min_score: 0 })).hits, []);
  assert.deepEqual((await f.hook()).hits, []);
  await f.vault.reindexFile(f.saved.file_path);
  await assert.rejects(loadMemoryHandler(f.deps, { id: "invented-artifact" }), /not found/);
  assert.deepEqual((await recallHandler(f.deps, { query: "invented artifact", min_score: 0 })).hits, []);
  assert.deepEqual((await f.hook()).hits, []);
  const trusted = await loadMemoryHandler(f.deps, { id: "invented-artifact" }, TRUSTED_LOCAL_APP);
  assert.equal(trusted.frontmatter.rulebook, "always");
});
