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
  await checks.recordRulebookLoad(sid, "invented-correspondence");
  assert.equal(denied(await gate(sid)), false);
  assert.equal(denied(await gate("other-session")), true);
  await checks.resetRulebookContext(sid);
  assert.equal(denied(await gate(sid)), true);
});

test("concurrent calls cannot exceed the denial cap and missing attribution cannot inherit a receipt", async () => {
  const sid = "parallel";
  const results = await Promise.all(Array.from({ length: 8 }, () => gate(sid)));
  assert.equal(results.filter(denied).length, 2);
  await checks.recordRulebookCheck(sid, { applicable: [] }, catalog);
  const unknown = { ...payload(sid), bastra_client: "codex", bastra_codex_version: "0.162.1" };
  assert.equal(denied(JSON.parse(await runGateLane(unknown, deps))), true);
});

test("Stop checks pasted correspondence in EN/JA/RU/ES once, with no classification and no human input", async () => {
  for (const text of ["Could you send the contract?", "契約書を送っていただけますか。", "Пришлите договор, пожалуйста.", "¿Puedes enviar el contrato?"]) {
    const sid = `stop-${text}`;
    const promptOutput = JSON.parse(await runPromptLane({ ...payload(sid), hook_event_name: "UserPromptSubmit", prompt: text }, null,
      "http://127.0.0.1:1", undefined, () => [], { kernel: deps.kernel }));
    assert.match(promptOutput.hookSpecificOutput.additionalContext, /1.*Index.*vor der Antwort prüfen/);
    const p = { ...payload(sid), hook_event_name: "Stop", transcript: [{ role: "user", content: text }], stop_hook_active: false };
    const first = JSON.parse(await runStopLane(p, "http://127.0.0.1:1", { kernel: deps.kernel }));
    assert.equal(first.decision, "block"); assert.match(first.reason, /rulebook_check/);
    const second = JSON.parse(await runStopLane({ ...p, stop_hook_active: true }, "http://127.0.0.1:1", { kernel: deps.kernel }));
    assert.notEqual(second.decision, "block");
    await checks.recordRulebookLoad(sid, "invented-correspondence");
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
  await loadMemoryHandler(deps, { id: "invented-correspondence" }, { sessionId: "handler" });
  assert.equal(denied(await gate("handler")), false);
  await checks.beginRulebookRound(payload("handler"), catalog);
  await loadMemoryHandler(deps, { id: "invented-correspondence" }, { sessionId: "elsewhere" });
  assert.equal(denied(await gate("handler")), true);
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
