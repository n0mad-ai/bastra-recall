import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateConventions, renderConventions, cmdConventions } from "../src/cli/log-conventions.js";
import { parseArgs } from "../src/cli/commands.js";
const ts = "2026-10-29T08:00:00Z";
const event = (kind: string, session: string | null, extra = {}) => ({ kind, ts, session_id: session ?? "daemon-id", session_known: session !== null, ...extra });
const load = (session: string | null, id: string) => event("load_memory", session, { caller_session: session, id, found: true, delivered_chars: 20 });

test("three sessions: only the same session and denied memory can clear must-load; receipts remain mechanical", () => {
  const rows = aggregateConventions([
    event("convention_shown", "a", { memory_ids: ["rule", "rule"] }),
    event("gate_hook_call", "a", { outcome: "deny", must_load_ids: ["rule"] }),
    load("b", "rule"), load("a", "unrelated"), load("a", "rule"),
    event("session_harvest", "a", { stored_count: 2, stored_memory_ids: ["rule", "rule"] }),
    event("convention_validation", "b", { caller_session: "b", result: "pass", receipt: "sha256:synthetic", receipt_stored: true, task_kind: "approved-copy", rule_revision: "revision", generation: 3 }),
    event("convention_shown", "c", { memory_ids: ["rule"] }),
    event("hint_followed_shadow", "c", { memory_id: "rule", followed: true }),
  ]);
  assert.equal(rows.length, 3);
  const [a, b, c] = rows;
  assert.equal(a.followed, "deny-cleared"); assert.equal(a.shown.size, 1); assert.equal(a.loaded.size, 2);
  assert.equal(a.memories.get("rule")?.saidAgain, 2);
  assert.equal(a.memories.get("rule")?.inVaultAtRepetition, "unknown");
  assert.equal(b.followed, "receipt"); assert.equal(c.followed, "unknown");
  const text = renderConventions(rows);
  assert.match(text, /session=b .*task=approved-copy revision=revision generation=3 first-visible=unknown repaired=unknown/);
  assert.match(text, /total sessions=3 .*denied=1/);
  assert.match(text, /not semantic compliance/);
});

test("deny does not surface/load, plain pass and unknown/foreign loads do not clear it", () => {
  const rows = aggregateConventions([
    event("gate_hook_call", "a", { outcome: "deny", must_load_ids: ["rule"] }),
    event("gate_hook_call", "a", { outcome: "pass" }),
    load("b", "rule"), load(null, "rule"),
    event("gate_hook_call", "c", { outcome: "deny", reflex_ids: ["rule"] }), load("c", "rule"),
  ]);
  const a = rows.find(r => r.session === "a")!;
  assert.equal(a.shown.size, 0); assert.equal(a.loaded.size, 0); assert.equal(a.followed, "unknown");
  assert.equal(rows.find(r => r.session === "c")!.followed, "unknown");
});

test("failed, blocked and unattributed attempts retain their denominators; no daemon session guess", () => {
  const rows = aggregateConventions([
    event("gate_hook_call", "a", { outcome: "deny", must_load_ids: ["rule"] }),
    event("gate_hook_call", "a", { outcome: "pass", non_conformance: "gate_timeout" }),
    event("convention_validation", "a", { caller_session: "a", result: "fail", receipt: null, receipt_stored: false, first_visible_result: "invalid", repaired_result: "exhausted" }),
    event("convention_validation", "a", { caller_session: "a", result: "pass", receipt: "r", receipt_stored: false }),
    event("load_memory", "a", { caller_session: "a", id: "private", found: true }),
    event("load_memory", "a", { caller_session: "a", id: "missing", found: false }),
    event("convention_validation", null, { result: "pass", receipt: "r", receipt_stored: true }),
    { kind: "receipt_unattributed", ts, session_id: "daemon-boot" },
    { kind: "load_memory", ts, session_id: "daemon-boot", id: "rule", found: true, delivered_chars: 1 },
    { kind: "gate_hook_call", ts, session_id: "synthetic-client-uuid", outcome: "deny", must_load_ids: ["rule"] },
  ]);
  const a = rows.find(r => r.session === "a")!;
  assert.equal(a.gateAttempts, 2); assert.equal(a.validationAttempts, 2); assert.equal(a.failedValidations, 1);
  assert.equal(a.failedLoads, 1); assert.equal(a.unverifiedLoads, 1); assert.equal(a.loaded.size, 0); assert.equal(a.followed, "unknown");
  assert.equal(a.firstVisible.has("invalid"), true); assert.equal(a.repaired.has("exhausted"), true);
  const unknown = rows.find(r => r.session === null)!;
  assert.equal(unknown.session_known, false); assert.equal(unknown.followed, "unknown");
  assert.equal(unknown.unattributedReceipts, 1); assert.equal(unknown.legacyUnattributedEvents, 1);
  assert.equal(rows.some(r => r.session === "daemon-boot" || r.session === "synthetic-client-uuid"), false);
});

test("--conventions accepted only on logs; --since filters disk rows, eval excluded by default", async () => {
  const parsed = parseArgs(["logs", "--conventions", "--since", "7d"]);
  assert.equal(parsed.conventions, true); assert.deepEqual(parsed.errors, []);
  assert.ok(parseArgs(["status", "--conventions"]).errors!.length > 0);
  const dir = await mkdtemp(join(tmpdir(), "bastra-conventions-"));
  try {
    const now = Date.now();
    await mkdir(dir, { recursive: true });
    const lines = [
      { ...event("convention_shown", "recent", { memory_ids: ["r"] }), ts: new Date(now).toISOString() },
      { ...event("convention_shown", "old", { memory_ids: ["r"] }), ts: new Date(now - 3600_000).toISOString() },
      { ...event("convention_shown", "probe", { memory_ids: ["r"], dimensions: { client: "eval" } }), ts: new Date(now).toISOString() },
    ];
    await writeFile(join(dir, `events-${new Date(now).toISOString().slice(0, 10)}.jsonl`), lines.map(e => JSON.stringify(e)).join("\n"));
    let output = "";
    await cmdConventions({ sinceMs: 60_000, logDir: dir, write: text => { output += text; } });
    assert.match(output, /session=recent/); assert.doesNotMatch(output, /session=old|session=probe/);
    output = "";
    await cmdConventions({ sinceMs: 2 * 3600_000, includeEval: true, logDir: dir, write: text => { output += text; } });
    assert.match(output, /session=old/); assert.match(output, /session=probe/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a multi-memory denial clears only when its own complete group is loaded", () => {
  const deny = event("gate_hook_call", "a", { outcome: "deny", must_load_ids: ["one", "two"] });
  const partial = [deny, load("a", "one"), load("b", "two"), load(null, "two")];
  assert.equal(aggregateConventions(partial).find(r => r.session === "a")!.followed, "unknown");
  assert.equal(aggregateConventions([...partial, load("a", "two")]).find(r => r.session === "a")!.followed, "deny-cleared");
  // Another independent deny must not be combined with this incomplete one.
  const second = event("gate_hook_call", "a", { outcome: "deny", must_load_ids: ["three"] });
  assert.equal(aggregateConventions([...partial, second, load("a", "three")]).find(r => r.session === "a")!.followed, "deny-cleared");
});

test("missing or invalid validator outcomes are unverified attempts, never failures or passes", () => {
  const rows = aggregateConventions([
    event("convention_validation", "a", { caller_session: "a", receipt: "r", receipt_stored: true }),
    event("convention_validation", "a", { caller_session: "a", result: "unexpected", receipt: "r", receipt_stored: true }),
    event("convention_validation", "a", { caller_session: "a", result: "fail", receipt: null, receipt_stored: false }),
  ]);
  assert.equal(rows[0].validationAttempts, 3);
  assert.equal(rows[0].failedValidations, 1);
  assert.equal(rows[0].unverifiedValidations, 2);
  assert.equal(rows[0].receipts, 0);
  assert.equal(rows[0].followed, "unknown");
  assert.match(renderConventions(rows), /validator-attempts=3 failed-validations=1 unverified-validations=2/);
});
