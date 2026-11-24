/**
 * #1591 (owner decision B, 24.11.2026) and #1622: the rulebook check is asked
 * for only when the rules changed since the last confirmed check of this
 * session; Recall's own tools are never held; the session start's full kernel
 * counts as the agent's last delivered kernel.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGateLane } from "../src/gate-lane.js";
import { runSessionLane } from "../src/session-lane.js";
import * as checks from "../src/rulebook-check.js";
import { RULE_KERNEL_TOOL_CALLS } from "../src/rule-kernel.js";
import { kernelFingerprint } from "../src/rule-kernel.js";
import { bookPendingMustLoad, loadSessionState, mutateSessionState } from "../src/session-state.js";
import { cachedRulebookCatalog, type KernelCandidates, type KernelEntry } from "../src/rulebook-catalog.js";
import { rulebookFingerprint } from "../src/rulebook-round-state.js";
import { Vault, saveMemory } from "@bastra-recall/core";

const rule = (id: string, extra: Partial<KernelEntry> = {}): KernelEntry => ({
  id,
  title: "Invented rule",
  group: "explicit",
  revision: "rev-1",
  updated: null,
  stale_status: "unknown",
  body: "",
  rulebook: "on-demand",
  applies_when: "When writing an invented fixture file",
  rule_hash: `${id}@1`,
  ...extra,
});
const catalog: KernelCandidates = { entries: [rule("fixture-rule")], omitted: 0 };
const withNewRule: KernelCandidates = { entries: [rule("fixture-rule"), rule("second-rule")], omitted: 0 };
const edited: KernelCandidates = { entries: [rule("fixture-rule", { rule_hash: "fixture-rule@2" })], omitted: 0 };
const expired: KernelCandidates = { entries: [rule("fixture-rule", { expired_on: "2026-11-01" })], omitted: 0 };
const empty: KernelCandidates = { entries: [], omitted: 0 };

const payload = (sid: string, tool_name = "Write", agent_id?: string) => ({
  session_id: sid,
  bastra_client: "claude-code",
  hook_event_name: "PreToolUse",
  tool_name,
  tool_input: {},
  ...(agent_id ? { agent_id } : {}),
});
const gate = async (sid: string, kernel = catalog, tool = "Write", agent_id?: string) =>
  JSON.parse(await runGateLane(payload(sid, tool, agent_id), { reflexPool: () => [], kernel: async () => kernel }));
const denied = (out: { hookSpecificOutput?: { permissionDecision?: string } }) =>
  out.hookSpecificOutput?.permissionDecision === "deny";
const asksForCheck = /check before|vor (der|dieser) Antwort prüfen/;

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "rulebook-carry-"));
  process.env.BASTRA_HOOK_STATE_DIR = root;
  process.env.BASTRA_TELEMETRY = "off";
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("an unchanged catalog keeps the last confirmed check: no reminder, no deny in the next round", async () => {
  const sid = "carry-unchanged";
  assert.match(await checks.beginRulebookRound(payload(sid), catalog), asksForCheck);
  assert.equal(denied(await gate(sid)), true, "the first round still needs its check");
  assert.equal((await checks.recordRulebookCheck(sid, { applicable: [] }, catalog)).ok, true);
  assert.equal(denied(await gate(sid)), false);
  for (const round of [2, 3]) {
    const notice = await checks.beginRulebookRound(payload(sid), catalog);
    assert.doesNotMatch(notice, asksForCheck, `round ${round} asks nothing`);
    assert.equal(denied(await gate(sid)), false, `round ${round} needs no new check`);
  }
});

test("a new, edited or expired rule asks for a new check at once, also mid-round", async () => {
  for (const [name, next] of [
    ["new", withNewRule],
    ["edited", edited],
    ["expired", expired],
  ] as const) {
    const sid = `carry-change-${name}`;
    await checks.beginRulebookRound(payload(sid), catalog);
    await checks.recordRulebookCheck(sid, { applicable: [] }, catalog);
    assert.equal(denied(await gate(sid)), false);
    // The rule changes while the round runs: the next boundary sees it.
    assert.equal(denied(await gate(sid, next)), true, `${name}: mid-round`);
    await checks.recordRulebookCheck(sid, { applicable: [] }, next);
    assert.equal(denied(await gate(sid, next)), false, `${name}: the new check answers it`);
    assert.doesNotMatch(await checks.beginRulebookRound(payload(sid), next), asksForCheck);
    // Changed at the prompt: the round start asks right away.
    assert.match(await checks.beginRulebookRound(payload(sid), catalog), asksForCheck, `${name}: at the prompt`);
    assert.equal(denied(await gate(sid)), true);
  }
});

test("a context reset ends the carried check; another session and another agent never share it", async () => {
  const sid = "carry-reset";
  await checks.beginRulebookRound(payload(sid), catalog);
  await checks.recordRulebookCheck(sid, { applicable: [] }, catalog);
  await checks.resetRulebookContext(sid);
  assert.match(await checks.beginRulebookRound(payload(sid), catalog), asksForCheck);
  assert.equal(denied(await gate(sid)), true, "after compact/clear the check is asked again");

  const a = "carry-session-a",
    b = "carry-session-b";
  await checks.beginRulebookRound(payload(a), catalog);
  await checks.beginRulebookRound(payload(b), catalog);
  await checks.recordRulebookCheck(a, { applicable: [] }, catalog);
  await checks.beginRulebookRound(payload(a), catalog);
  await checks.beginRulebookRound(payload(b), catalog);
  assert.equal(denied(await gate(a)), false);
  assert.equal(denied(await gate(b)), true, "session B never checked");

  const sub = "carry-subagent";
  await checks.beginRulebookRound(payload(sub), catalog);
  await checks.recordRulebookCheck(sub, { applicable: [], agent_id: "worker-1" }, catalog);
  await checks.beginRulebookRound(payload(sub), catalog);
  assert.equal(denied(await gate(sub, catalog, "Write", "worker-1")), false, "the worker keeps its own check");
  assert.equal(denied(await gate(sub, catalog, "Write", "worker-2")), true, "another worker does not inherit it");
  assert.equal(denied(await gate(sub)), true, "the main thread does not inherit it");
});

test("an empty rulebook asks nothing until a rule arrives; a catalog outage is no rule change", async () => {
  const sid = "carry-empty";
  assert.equal(await checks.beginRulebookRound(payload(sid), empty), "");
  assert.equal(denied(await gate(sid, empty)), false);
  assert.equal(denied(await gate(sid, catalog)), true, "the first rule asks for a check");

  const outage = "carry-outage";
  await checks.beginRulebookRound(payload(outage), catalog);
  await checks.recordRulebookCheck(outage, { applicable: [] }, catalog);
  await checks.beginRulebookRound(payload(outage), empty, { unavailable: true });
  assert.equal(denied(await gate(outage)), false, "the unchanged catalog behind the outage keeps the check");
});

test("Recall's own tools are never held, not by the round check and not by a pending must-load", async () => {
  const sid = "carry-own-tools";
  await checks.beginRulebookRound(payload(sid), catalog);
  await mutateSessionState(sid, (s) => bookPendingMustLoad(s, ["fixture-rule"], "prompt:first", 1));
  for (const tool of [
    "mcp__bastra-recall__save_memory",
    "mcp__bastra-recall__edit_memory",
    "mcp__bastra-recall__review_draft",
    "mcp__bastra-recall__task_create",
    "mcp__plugin_bastra-recall_bastra-recall__save_memory",
    "mcp__codex_apps__bastra_recall_save_memory",
  ])
    assert.equal(denied(await gate(sid, catalog, tool)), false, tool);
  assert.deepEqual(
    (await loadSessionState(sid)).pendingMustLoad?.map((e) => e.id),
    ["fixture-rule"],
    "the must-load waits for the next other tool"
  );
  assert.equal(denied(await gate(sid)), true, "a foreign write is still held");
});

test("the fingerprint is the same in both catalog modes and ignores a tier that follows session state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rulebook-carry-vault-"));
  const vault = new Vault(dir);
  t.after(async () => {
    await vault.stop();
    await rm(dir, { recursive: true, force: true });
  });
  await vault.init();
  // A user-directed preference without a rulebook field: on-demand, "always" while active.
  const m = await saveMemory(vault.root, {
    id: "legacy-pref",
    title: "Invented preference",
    summary: "Invented scope",
    body: "Invented body",
    type: "user-preference",
    scope: "all-projects",
    write_origin: "user-directed",
    tags: ["fixture"],
    topic_path: ["fixture"],
    recall_when: ["invented-trigger"],
  });
  await vault.reindexFile(m.file_path);
  const at = (mode: "ids" | "content", active: { id: string; revision: null; setAt: number }[] = []) =>
    cachedRulebookCatalog(vault, { project: null, active, mode });
  const idle = await at("ids");
  const activeContent = await at("content", [{ id: "legacy-pref", revision: null, setAt: 1 }]);
  assert.equal(activeContent.entries[0]?.rulebook, "always", "fixture: the tier really follows the session");
  assert.equal(idle.entries[0]?.rulebook, "on-demand");
  assert.equal(rulebookFingerprint(idle), rulebookFingerprint(await at("content")));
  assert.equal(rulebookFingerprint(idle), rulebookFingerprint(activeContent));
});

test("#1622: the kernel fingerprint ignores the trigger", () => {
  const body = "\nRulebook: 1 rules\n</rule-kernel>";
  assert.equal(
    kernelFingerprint(`<rule-kernel trigger="after startup">${body}`),
    kernelFingerprint(`<rule-kernel trigger="25 tool calls without a prompt">${body}`)
  );
  assert.notEqual(
    kernelFingerprint(`<rule-kernel trigger="after startup">${body}`),
    kernelFingerprint(`<rule-kernel trigger="after startup">${body} changed`)
  );
});

test("#1622: a delivered session-start kernel makes the gate's next unchanged kernel a reminder", async () => {
  const content: KernelCandidates = {
    entries: [
      rule("always-rule", {
        title: "Invented always rule",
        rulebook: "always",
        body: "Invented always body.",
        stale_status: "fresh",
      }),
    ],
    omitted: 0,
  };
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const response =
        req.url === "/hook/session-context" || req.url === "/session-context"
          ? { data: { kernel: content, recalls: [] } }
          : { hits: [], vault_size: 0, latency_ms: 0, recall_id: "fixture", score_kind: "rrf" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const kernelAfterCalls = async (sid: string) => {
      let text = "";
      for (let i = 0; i < RULE_KERNEL_TOOL_CALLS; i++) {
        const out = JSON.parse(
          await runGateLane(
            { ...payload(sid, "Read"), cwd: "/tmp" },
            { reflexPool: () => [], kernel: async () => content }
          )
        );
        text = out.hookSpecificOutput?.additionalContext ?? text;
      }
      return text;
    };
    const started = "kernel-after-start";
    const start = await runSessionLane(
      { hook_event_name: "SessionStart", session_id: started, cwd: "/tmp", bastra_client: "claude-code" },
      base
    );
    assert.match(start, /Invented always body/, "the session start delivered the full kernel");
    assert.match(await kernelAfterCalls(started), /unchanged="[0-9a-f]{16}"/);
    // Without a session start the gate still sends the full text first.
    assert.match(await kernelAfterCalls("kernel-without-start"), /Invented always body/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
