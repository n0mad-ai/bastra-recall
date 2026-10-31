/** #1323: explicit validator metadata through real files, public handlers and lanes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { Vault, SearchIndex, saveMemory, memoryRevision } from "@bastra-recall/core";
import { vaultConventionOf } from "../src/convention-source.js";
import { runTaskStep } from "../src/prompt-task.js";
import { runGateLane, actionReflexPool } from "../src/gate-lane.js";
import { loadSessionState, mutateSessionState, bookPendingMustLoad } from "../src/session-state.js";
import { loadMemoryHandler } from "../src/load-memory-handler.js";
import { editMemoryHandler } from "../src/edit-memory-handler.js";
import { assembleHookRecallPayload } from "../src/hook-recall-payload.js";
import { collectPoolReflexHits } from "../src/recall-pipeline.js";
import { Telemetry } from "../src/telemetry.js";
import type { ToolDeps } from "../src/tool-deps.js";

const validator = { tool: "validate_artifact", channel: "invented-channel", limit: 500, unit: "codepoints" } as const;
const input = { id: "invented-convention", title: "Invented convention", type: "workflow" as const,
  summary: "Use the explicit mechanical check", body: "Translate, draft and then check copy.",
  topic_path: ["fixture"], tags: ["fixture"], scope: "all-projects", recall_when: ["fixture_copy_tool"],
  recall_mode: "reflex" as const, write_origin: "user-directed" as const, salience: 0.9, validator };

async function fixture(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(join(tmpdir(), "bastra-convention-validator-"));
  const saved = process.env.BASTRA_HOOK_STATE_DIR;
  process.env.BASTRA_HOOK_STATE_DIR = join(root, "state");
  const file = await saveMemory(root, input);
  const vault = new Vault(root);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const deps: ToolDeps = { vault, search, telemetry: new Telemetry(), vaultPath: root };
  t.after(async () => {
    search.stop(); await vault.stop();
    if (saved === undefined) delete process.env.BASTRA_HOOK_STATE_DIR; else process.env.BASTRA_HOOK_STATE_DIR = saved;
    await rm(root, { recursive: true, force: true });
  });
  // Keep the index stale for direct MCP checks; hook/task cases reindex explicitly.
  async function replace(value: unknown) {
    const raw = await readFile(file.file_path, "utf8");
    const parsed = matter(raw);
    const data = { ...parsed.data };
    if (value === undefined) delete data.validator; else data.validator = value;
    await writeFile(file.file_path, matter.stringify(parsed.content, data));
  }
  return { vault, deps, file: file.file_path, replace };
}

test("task activation reads indexed declaration and revision together after reindex; replacement/removal drops old metadata", async (t) => {
  const f = await fixture(t);
  const sid = "validator-task";
  const candidate = { id: input.id, type: input.type, matched_recall_when: true, validator };
  const step = async (prompt: string) => runTaskStep({ sessionId: sid, prompt, snapshot: await loadSessionState(sid),
    mode: "none", candidates: [candidate], surface: "claude-code", conventionOf: vaultConventionOf(f.vault) });
  const {rulebookCheckHandler} = await import("../src/rulebook-check.js");
  await rulebookCheckHandler(f.deps, {applicable: [input.id], task: "draft-for-review"}, {sessionId: sid});
  await step("ich arbeite jetzt eine eingegangene Nachricht ab");
  let state = await loadSessionState(sid);
  assert.deepEqual(state.activeConventions?.[0]?.validator, validator);
  assert.equal(state.activeConventions?.[0]?.revision, memoryRevision(await readFile(f.file, "utf8")));
  await f.replace({ ...validator, channel: "another-channel", limit: 1000, unit: "utf16" });
  await f.vault.reindexFile(f.file);
  await step("ok");
  state = await loadSessionState(sid);
  assert.equal(state.activeConventions?.[0]?.validator?.limit, 1000);
  assert.equal(state.activeConventions?.[0]?.revision, memoryRevision(await readFile(f.file, "utf8")));
  await f.replace(undefined);
  await f.vault.reindexFile(f.file);
  await step("zweiten Satz kürzer");
  assert.equal((await loadSessionState(sid)).activeConventions?.[0]?.validator, undefined);
  await f.replace({ ...validator, tool: "invented-shell" });
  await f.vault.reindexFile(f.file);
  await step("zweiten Satz kürzer");
  assert.equal((await loadSessionState(sid)).activeConventions?.[0]?.validator, undefined);
});

test("action reflex gate binds explicit source metadata; load refreshes/removes it even after pending claim released", async (t) => {
  const f = await fixture(t);
  const sid = "validator-gate";
  const result = JSON.parse(await runGateLane({ hook_event_name: "PreToolUse", session_id: sid,
    tool_name: "ToolSearch", tool_input: { query: "select:fixture_copy_tool" } }, { reflexPool: () => actionReflexPool(f.vault.list()) }));
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual((await loadSessionState(sid)).activeConventions?.[0]?.validator, validator);
  await f.replace(undefined);
  const reloaded = await loadMemoryHandler(f.deps, { id: input.id }, { sessionId: sid });
  assert.equal(reloaded?.frontmatter.validator, undefined);
  assert.equal((await loadSessionState(sid)).activeConventions?.[0]?.validator, undefined);
  assert.equal((await loadSessionState(sid)).activeConventions?.[0]?.revision, memoryRevision(await readFile(f.file, "utf8")));
});

test("MCP edit stages changes to an existing validator; trusted source changes and initial addition remain effective", async (t) => {
  const f = await fixture(t);
  const sid = "validator-load";
  await mutateSessionState(sid, (state) => bookPendingMustLoad(state, [input.id], "fixture"));
  const loaded = await loadMemoryHandler(f.deps, { id: input.id }, { sessionId: sid });
  assert.deepEqual(loaded?.frontmatter.validator, validator);
  assert.deepEqual((await loadSessionState(sid)).activeConventions?.[0]?.validator, validator);
  await assert.rejects(editMemoryHandler(f.deps, { id: input.id, frontmatter: { validator: { ...validator, limit: 0 } } }));
  await editMemoryHandler(f.deps, { id: input.id, frontmatter: { validator: { ...validator, channel: "edited-channel", unit: "utf16" } } });
  assert.equal(matter(await readFile(f.file, "utf8")).data.validator.channel, validator.channel);
  assert.equal(matter(await readFile(f.file, "utf8")).data.rulebook_proposed.validator.channel, "edited-channel");
  await editMemoryHandler(f.deps, { id: input.id, frontmatter: { validator: null } });
  assert.deepEqual(matter(await readFile(f.file, "utf8")).data.validator, validator);
  assert.equal(matter(await readFile(f.file, "utf8")).data.rulebook_proposed.validator,null);
  await f.replace(undefined);await f.vault.reindexFile(f.file);
});

test("hook recall and deeper reflex projections carry explicit frontmatter metadata", async (t) => {
  const f = await fixture(t);
  const pool = collectPoolReflexHits([{ id: input.id, score: 150 }], new Set(), f.vault);
  assert.deepEqual(pool[0]?.validator, validator);
  const response = assembleHookRecallPayload({ hits: [{ ...input, score: 150, matched_recall_when: true, matched_terms: ["fixture_copy_tool"] }],
    candidatePool: [], vault: f.vault, maxTokens: 0, totalLatencyMs: 1, recallId: "fixture", weakResult: false,
    noHome: false, hookProject: null, hybridActiveAtRecall: true, degradedReason: undefined });
  assert.deepEqual(response.payload.hits[0]?.validator, validator);
});

test("#1330 final review: revision and inline provenance are bound to current source bytes",async t=>{
 const {readConventionSource}=await import("../src/convention-source.js"),f=await fixture(t),before=await readFile(f.file,"utf8"),parsed=matter(before);
 await writeFile(f.file,matter.stringify(parsed.content+"\nchanged rule",{...parsed.data,summary:"changed summary",write_origin:"agent-session"}));
 const raw=await readFile(f.file,"utf8"),source=await readConventionSource(f.vault.get(input.id),true);
 const response=assembleHookRecallPayload({hits:[{...input,score:150,matched_recall_when:true,matched_terms:["fixture_copy_tool"]}],candidatePool:[],vault:f.vault,maxTokens:0,totalLatencyMs:1,recallId:"fixture",weakResult:false,noHome:false,hookProject:null,hybridActiveAtRecall:true,degradedReason:undefined,conventionSources:new Map([[input.id,source]])});
 assert.notEqual(memoryRevision(before),memoryRevision(raw));assert.equal((response.payload.hits[0]as any).revision,memoryRevision(raw));assert.equal(response.payload.hits[0].write_origin,"agent-session");assert.equal(response.payload.hits[0].summary,"changed summary");
});
test("#1330 final review: stale cached body never records the new disk revision as loaded",async t=>{
 const f=await fixture(t),raw=await readFile(f.file,"utf8"),parsed=matter(raw);await writeFile(f.file,matter.stringify("new rule not present in cached body",parsed.data));
 await loadMemoryHandler(f.deps,{id:input.id},{sessionId:"fixture-stale-rule-load",agentId:null});
 assert.equal((await loadSessionState("fixture-stale-rule-load")).loadedConventions,undefined);
});
test("#1330 final review: source metadata cannot expose a newly private rule through a stale index",async t=>{
 const {readConventionSource}=await import("../src/convention-source.js"),f=await fixture(t),old=matter(await readFile(f.file,"utf8"));await writeFile(f.file,matter.stringify("PRIVATE BODY SENTINEL",{...old.data,sensitivity:"private",summary:"PRIVATE SUMMARY SENTINEL"}));
 const source=await readConventionSource(f.vault.get(input.id),true);
 const response=assembleHookRecallPayload({hits:[{...input,score:150,matched_recall_when:true,matched_terms:["fixture_copy_tool"]}],candidatePool:[{id:input.id,score:150}],vault:f.vault,maxTokens:0,totalLatencyMs:1,recallId:"fixture",weakResult:false,noHome:false,hookProject:null,hybridActiveAtRecall:true,degradedReason:undefined,conventionSources:new Map([[input.id,source]])});
 assert.equal(response.payload.hits.length,0);assert.doesNotMatch(JSON.stringify(response.payload),/PRIVATE SUMMARY|PRIVATE BODY|invented-convention/);
});

test("fix2: stdio load without ctx activates pending conventions and caller-session receipts", async t => {
  const f=await fixture(t), sid="stdio-normal-load";
  const {callerSessionStore}=await import("../src/caller-session.js");
  await mutateSessionState(sid,s=>bookPendingMustLoad(s,[input.id],"stdio"));
  await callerSessionStore.run(sid,()=>loadMemoryHandler(f.deps,{id:input.id}));
  const state=await loadSessionState(sid);
  assert.equal(state.loadedConventions?.[0]?.id,input.id);
  assert.deepEqual(state.activeConventions?.[0]?.validator,validator);
  assert.equal(state.pendingMustLoad,undefined);
});
