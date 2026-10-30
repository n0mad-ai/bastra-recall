import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGateLane } from "../src/gate-lane.js";
import { runStopLane } from "../src/stop-lane.js";
import { runPromptLane } from "../src/prompt-lane.js";
import { setPrimaryLanguage } from "../src/settings.js";
import * as checks from "../src/rulebook-check.js";
import type { KernelCandidates } from "../src/rulebook-catalog.js";
import { ALL_TOOL_DEFS, toolNamesForSurface } from "../src/tool-defs.js";
const catalog: KernelCandidates = { entries: [{ id: "invented-correspondence", title: "Invented convention", group: "explicit",
  revision: "rev-1", updated: null, stale_status: "unknown", body: "", rulebook: "on-demand",
  applies_when: "wenn der Nutzer eine Nachricht von jemand anderem einfügt oder eine Antwort an eine Person entsteht" }], omitted: 0 };
const deps = { reflexPool: () => [], kernel: async () => catalog };
const payload = (sid: string, tool_name = "Write", tool_input = {}) => ({ session_id: sid,
  bastra_client: "claude-code", hook_event_name: "PreToolUse", tool_name, tool_input });
const gate = async (sid: string, name = "Write", input = {}) => JSON.parse(await runGateLane(payload(sid, name, input), deps));
const denied = (out: any) => out.hookSpecificOutput?.permissionDecision === "deny";
let root: string;
before(async () => { root = await mkdtemp(join(tmpdir(), "rulebook-gate-")); process.env.BASTRA_HOOK_STATE_DIR = root; process.env.BASTRA_TELEMETRY = "off"; await setPrimaryLanguage("de"); });
after(async () => { await rm(root, { recursive: true, force: true }); });

test("rulebook gate denies at most twice, reports violations next prompt and resets the round", async () => {
  const sid = "bounded";
  await checks.beginRulebookRound(payload(sid), catalog);
  assert.equal(denied(await gate(sid)), true);
  assert.equal(denied(await gate(sid)), true);
  assert.equal(denied(await gate(sid)), false);
  assert.equal(denied(await gate(sid)), false);
  const notice = await checks.beginRulebookRound(payload(sid), catalog);
  assert.match(notice, /2.*ungeprüft/);
  assert.equal(denied(await gate(sid)), true);
});

test("read tools and Bastra read/check tools are never held; own and foreign writes are held", async () => {
  for (const [name, input] of [["Read", {}], ["Grep", {}], ["view_image", {}], ["WebSearch", {}],
    ["Bash", { command: "git status --short" }], ["exec_command", { cmd: "rg rulebook packages" }],
    ["Bash", { command: "cat file.txt" }], ["mcp__bastra_recall__load_memory", {}],
    ["load_memory", {}], ["rulebook_check", {}], ["mcp__bastra_recall__list_rules", {}], ["mcp__bastra_recall__rulebook_check", {}]] as const) {
    assert.equal(denied(await gate(`read-${name}`, name, input)), false, name);
  }
  for (const name of ["Write", "apply_patch", "mcp__bastra_recall__save_memory", "mcp__codex_apps__bastra_recall_edit_memory", "mcp__mail__send"]) {
    assert.equal(denied(await gate(`write-${name}`, name)), true, name);
  }
  assert.equal(denied(await gate("shell-write", "Bash", { command: "cat a > b" })), true);
});

test("a check is an honest round self-report; none accepted without an approval or complete catalog ritual", async () => {
  const sid = "receipt";
  await checks.beginRulebookRound(payload(sid), catalog);
  assert.equal((await checks.recordRulebookCheck(sid, { applicable: [] }, catalog)).ok, true);
  assert.equal(denied(await gate(sid)), false);
  const childDeny = await runAgentGate(sid, "child");
  assert.equal(denied(childDeny), true, "child cannot inherit parent proof");
  assert.match(childDeny.hookSpecificOutput.permissionDecisionReason, /"agent_id":"child"/);
  assert.match(childDeny.hookSpecificOutput.permissionDecisionReason, /"session_id":"receipt"/);
  assert.equal((await checks.recordRulebookCheck(sid, { applicable: ["invented-correspondence"], agent_id: "child" }, catalog)).ok, true);
  assert.equal(denied(await runAgentGate(sid, "child")), false);
  await checks.beginRulebookRound(payload(sid), catalog);
  assert.equal(denied(await gate(sid)), true, "next round expires receipt");
  assert.equal((await checks.recordRulebookCheck(sid, { applicable: ["missing"] }, catalog)).ok, false);
});
async function runAgentGate(sid: string, agent_id: string) { return JSON.parse(await runGateLane({ ...payload(sid), agent_id }, deps)); }

test("full rule load answers only its own session/round; compact invalidates it", async () => {
  const sid = "loaded";
  await checks.beginRulebookRound(payload(sid), catalog);
  await checks.recordRulebookLoad(sid, "invented-correspondence", null);
  assert.equal(denied(await gate(sid)), false);
  assert.equal(denied(await gate("other-session")), true);
  await checks.resetRulebookContext(sid);
  assert.equal(denied(await gate(sid)), true);
});

test("concurrent calls cannot exceed the denial cap and Codex main can answer its receipt", async () => {
  const sid = "parallel";
  const results = await Promise.all(Array.from({ length: 8 }, () => gate(sid)));
  assert.equal(results.filter(denied).length, 2);
  await checks.recordRulebookCheck(sid, { applicable: [] }, catalog);
  const unknown = { ...payload(sid), bastra_client: "codex", bastra_codex_version: "0.162.1" };
  assert.equal(denied(JSON.parse(await runGateLane(unknown, deps))), false);
});

test("Stop checks pasted correspondence in EN/JA/RU/ES once, with no classification and no human input", async () => {
  for (const client of ["claude-code", "codex"]) for (const text of ["Could you send the contract?", "契約書を送っていただけますか。", "Пришлите договор, пожалуйста.", "¿Puedes enviar el contrato?"]) {
    const sid = `stop-${client}-${text}`;
    const common = { ...payload(sid), bastra_client: client, bastra_codex_version: "0.162.1" };
    const promptOutput = JSON.parse(await runPromptLane({ ...common, hook_event_name: "UserPromptSubmit", prompt: text }, null,
      "http://127.0.0.1:1", undefined, () => [], { kernel: deps.kernel }));
    assert.match(promptOutput.hookSpecificOutput.additionalContext, /1.*Index.*vor der Antwort prüfen/);
    const p = { ...common, hook_event_name: "Stop", transcript: [{ role: "user", content: text }], stop_hook_active: false };
    const first = JSON.parse(await runStopLane(p, "http://127.0.0.1:1", { kernel: deps.kernel }));
    assert.equal(first.decision, "block"); assert.match(first.reason, /rulebook_check/);
    const second = JSON.parse(await runStopLane({ ...p, stop_hook_active: true }, "http://127.0.0.1:1", { kernel: deps.kernel }));
    assert.notEqual(second.decision, "block");
    await checks.recordRulebookLoad(sid, "invented-correspondence", null);
    assert.notEqual(JSON.parse(await runStopLane(p, "http://127.0.0.1:1", { kernel: deps.kernel })).decision, "block");
  }
});

test("no rules, unsupported hosts and state failures stay fail-open", async () => {
  assert.equal(denied(JSON.parse(await runGateLane(payload("empty"), { ...deps, kernel: async () => ({ entries: [], omitted: 0 }) }))), false);
  assert.equal(denied(JSON.parse(await runGateLane({ ...payload("unsupported"), bastra_client: "codex", bastra_codex_version: "0.1" }, deps))), false);
  const previous = process.env.BASTRA_HOOK_STATE_DIR;
  process.env.BASTRA_HOOK_STATE_DIR = "/dev/null/not-a-directory";
  try { assert.equal(denied(await gate("broken-state")), false); }
  finally { process.env.BASTRA_HOOK_STATE_DIR = previous; }
});

test("rulebook_check is registered even on search surface", () => {
  assert.ok(ALL_TOOL_DEFS.some(t => t.name === "rulebook_check"));
  assert.ok(toolNamesForSurface("search")?.includes("rulebook_check"));
});

test("real load and HTTP handlers record the receipt; lean loads and another caller cannot answer it", async t => {
  const { Vault, SearchIndex, saveMemory } = await import("@bastra-recall/core");
  const { Telemetry } = await import("../src/telemetry.js");
  const { loadMemoryHandler } = await import("../src/load-memory-handler.js");
  const { dispatchApi } = await import("../src/http-api-routes.js");
  const dir = await mkdtemp(join(tmpdir(), "rulebook-load-"));
  const saved = await saveMemory(dir, { id: "invented-correspondence", title: "Invented rule", summary: "Invented description",
    type: "workflow", scope: "all-projects", tags: ["fixture"], topic_path: ["fixture"], recall_when: ["fixture"],
    write_origin: "user-directed", rulebook: "on-demand", applies_when: "When composing an invented message", body: "Invented complete rule." });
  const vault = new Vault(dir); await vault.init(); const search = new SearchIndex(vault); search.start();
  t.after(async () => { search.stop(); await vault.stop(); await rm(dir, { recursive: true, force: true }); });
  const deps = { vault, search, telemetry: new Telemetry(), vaultPath: dir };
  await checks.beginRulebookRound(payload("handler"), catalog);
  await loadMemoryHandler(deps, { id: "invented-correspondence", verbosity: "lean" }, { sessionId: "handler" });
  assert.equal(denied(await gate("handler")), true);
  const { mutateSessionState: mutateLoadState, bookPendingMustLoad: bookLoad } = await import("../src/session-state.js");
  await mutateLoadState("handler", s => bookLoad(s, ["invented-correspondence"], "main-only-hint"));
  await loadMemoryHandler(deps, { id: "invented-correspondence" }, { sessionId: "handler", agentId: "child" });
  assert.equal(denied(await gate("handler")), true, "a child load cannot answer the main thread");
  const { loadSessionState: readState } = await import("../src/session-state.js");
  assert.equal((await readState("handler")).loadedConventions, undefined, "child load is not a legacy main load receipt");
  assert.equal((await readState("handler")).activeConventions, undefined, "a child load does not promote a main-only hint");
  await loadMemoryHandler(deps, { id: "invented-correspondence" }, { sessionId: "handler", agentId: null });
  assert.equal(denied(await gate("handler")), false);
  await checks.beginRulebookRound(payload("handler"), catalog);
  await loadMemoryHandler(deps, { id: "invented-correspondence" }, { sessionId: "elsewhere" });
  assert.equal(denied(await gate("handler")), true);
  await loadMemoryHandler(deps, { id: "invented-correspondence" }, { sessionId: "unknown-load" });
  assert.equal(denied(await gate("unknown-load")), true, "unattributed loads cannot answer main");
  const receipt = await dispatchApi("rulebook_check", { applicable: [], session_id: "elsewhere" }, { toolDeps: deps, documentWriteEnabled: false, ccSessionId: "handler" }) as { ok: boolean };
  assert.equal(receipt.ok, true);
  assert.equal(denied(await gate("handler")), false, "transport session wins over supplied session id");
  await checks.beginRulebookRound(payload("stale-handler"), catalog);
  const raw = await readFile(saved.file_path, "utf8");
  await writeFile(saved.file_path, raw.replace("Invented complete rule.", "Changed current source; cached body is stale."));
  await loadMemoryHandler(deps, { id: "invented-correspondence" }, { sessionId: "stale-handler" });
  assert.equal(denied(await gate("stale-handler")), true, "stale body cannot supply a new check receipt");
});

test("outage spool is delivered once at the next prompt and replay cannot drain or reset real state", async () => {
  const { spoolRulebookFailure } = await import("../src/rulebook-spool.js");
  const sid = "outage-notice";
  await spoolRulebookFailure(sid, 3);
  assert.equal(await checks.beginRulebookRound({ ...payload(sid), bastra_client: "replay" }, catalog), "");
  assert.match(await checks.beginRulebookRound(payload(sid), catalog), /3.*ungeprüft/);
  assert.doesNotMatch(await checks.beginRulebookRound(payload(sid), catalog), /ungeprüft/);
  await checks.recordRulebookCheck(sid, { applicable: [] }, catalog);
  await checks.beginRulebookRound({ ...payload(sid), bastra_client: "replay" }, catalog);
  assert.equal(denied(await gate(sid)), false);
});

test("a catalog outage at the next prompt still invalidates the preceding receipt", async () => {
  const sid = "catalog-outage";
  await checks.recordRulebookCheck(sid, { applicable: [] }, catalog);
  await runPromptLane({ ...payload(sid), hook_event_name: "UserPromptSubmit", prompt: "ok" }, null, "http://127.0.0.1:1",
    undefined, () => [], { kernel: async () => { throw Error("unavailable"); } });
  assert.equal(denied(await gate(sid)), true);
});

test("review: legacy pending and reflex gates still run after a rulebook receipt, with one shared denial cap", async () => {
  const { mutateSessionState, bookPendingMustLoad, loadSessionState } = await import("../src/session-state.js");
  await checks.beginRulebookRound(payload("review-combined"), catalog);
  await mutateSessionState("review-combined", s => bookPendingMustLoad(s, ["combined-legacy"], "review"));
  const combined = await gate("review-combined");
  assert.equal(denied(combined), true);
  assert.match(combined.hookSpecificOutput.permissionDecisionReason, /combined-legacy/);
  assert.match(combined.hookSpecificOutput.permissionDecisionReason, /rulebook_check/);
  const sid = "review-legacy";
  await checks.beginRulebookRound(payload(sid), catalog);
  await checks.recordRulebookCheck(sid, { applicable: [] }, catalog);
  await mutateSessionState(sid, s => bookPendingMustLoad(s, ["invented-legacy"], "review"));
  const out = await gate(sid);
  assert.equal(denied(out), true);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /invented-legacy/);
  assert.equal((await loadSessionState(sid)).pendingMustLoad, undefined);
  for (let i = 0; i < 4; i++) {
    await mutateSessionState(sid, s => bookPendingMustLoad(s, [`legacy-${i}`], "review"));
    assert.equal(denied(await gate(sid)), i === 0, "all legacy denials share the two-attempt cap");
  }
  const { actionReflexPool } = await import("../src/gate-lane.js");
  const reflex = { fm: { id: "invented-reflex", title: "Invented reflex", summary: "Fixture", type: "workflow", scope: "all-projects",
    recall_mode: "reflex", write_origin: "user-directed", salience: 0.9, recall_when: ["fixture_send_message"] }, body: "Invented reflex body." } as import("@bastra-recall/core").Memory;
  await checks.recordRulebookCheck("review-reflex", { applicable: [] }, catalog);
  const reflexOut = JSON.parse(await runGateLane(payload("review-reflex", "fixture_send_message"), { ...deps, reflexPool: () => actionReflexPool([reflex]) }));
  assert.equal(denied(reflexOut), true); assert.match(reflexOut.hookSpecificOutput.permissionDecisionReason, /invented-reflex/);

});

test("review: read classification avoids catalog I/O; task_controls remains a write", async () => {
  let scans = 0;
  const kernel = async () => { scans++; return catalog; };
  assert.equal(await runGateLane(payload("cheap-read", "Read"), { ...deps, kernel }), "{}");
  assert.equal(scans, 0);
  assert.equal(denied(await gate("controls-write", "mcp__bastra_recall__task_controls")), true);
});

test("review: an always-only catalog also gets the prompt check notice", async () => {
  const always = { ...catalog, entries: catalog.entries.map(e => ({ ...e, rulebook: "always" as const })) };
  assert.match(await checks.beginRulebookRound(payload("always-prompt"), always), /1.*Index.*vor der Antwort prüfen/);
});

test("review: cached catalog coalesces scans and invalidates on vault generation changes", async t => {
  const { Vault, saveMemory } = await import("@bastra-recall/core");
  const { cachedRulebookCatalog } = await import("../src/rulebook-catalog.js");
  const dir = await mkdtemp(join(tmpdir(), "rulebook-cache-"));
  const saved = await saveMemory(dir, { id: "cache-rule", title: "Invented cache rule", summary: "Fixture description", type: "workflow",
    scope: "all-projects", tags: ["fixture"], topic_path: ["fixture"], recall_when: ["fixture"], write_origin: "user-directed",
    rulebook: "on-demand", applies_when: "When editing a fixture", body: "Invented first body." });
  const vault = new Vault(dir); await vault.init();
  t.after(async () => { await vault.stop(); await rm(dir, { recursive: true, force: true }); });
  const list = vault.list.bind(vault); let scans = 0;
  vault.list = () => { scans++; return list(); };
  const opts = { project: null, active: [], floors: async () => [] };
  const [first, second] = await Promise.all([cachedRulebookCatalog(vault, opts), cachedRulebookCatalog(vault, opts)]);
  assert.strictEqual(first, second); assert.equal(scans, 1);
  await writeFile(saved.file_path, (await readFile(saved.file_path, "utf8")).replace("Invented first body.", "Invented changed body."));
  await vault.reindexFile(saved.file_path);
  const third = await cachedRulebookCatalog(vault, opts);
  assert.notEqual(third.catalog_hash, first.catalog_hash); assert.equal(scans, 2);
});

test("review: Stop continuation performs deferred harvest and save evaluation exactly once", async () => {
  const sid = "deferred-stop", transcript = join(root, "deferred.jsonl"), logs = join(root, "deferred-logs"), queue = join(root, "harvest.json");
  await writeFile(transcript, JSON.stringify({ role: "user", content: "An invented short prompt." }) + "\n");
  const p = { ...payload(sid), hook_event_name: "Stop", transcript_path: transcript };
  const env = { BASTRA_TELEMETRY: "on", BASTRA_LOG_PATH: logs, BASTRA_HARVEST_QUEUE_PATH: queue, BASTRA_SESSION_HARVEST: "on" };
  const old = new Map(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  try {
    assert.equal(JSON.parse(await runStopLane(p, "http://127.0.0.1:1", { kernel: deps.kernel })).decision, "block");
    await checks.recordRulebookCheck(sid, { applicable: [] }, catalog);
    await runStopLane({ ...p, stop_hook_active: true }, "http://127.0.0.1:1", { kernel: deps.kernel });
    const rows = JSON.parse(await readFile(queue, "utf8"));
    assert.ok(rows.some((r: { session_id: string }) => r.session_id === sid));
    const { readdir } = await import("node:fs/promises");
    const events = (await Promise.all((await readdir(logs)).filter(f => f.startsWith("events-")).map(f => readFile(join(logs, f), "utf8")))).join("\n");
    assert.equal(events.split("\n").filter(s => s && JSON.parse(s).kind === "save_eval_call").length, 1);
  } finally { for (const [k, v] of old) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});


test("review: a continued Stop cannot block again after context reset", async () => {
  const sid = "continued-compact";
  const p = { ...payload(sid), hook_event_name: "Stop", transcript: [] };
  assert.equal(JSON.parse(await runStopLane(p, "http://127.0.0.1:1", {kernel:deps.kernel})).decision, "block");
  await checks.resetRulebookContext(sid);
  assert.notEqual(JSON.parse(await runStopLane({...p,stop_hook_active:true}, "http://127.0.0.1:1", {kernel:deps.kernel})).decision, "block");
});
