import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, memoryRevision } from "@bastra-recall/core";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { readTaskStore } from "../src/task-store.js";
import { taskValueHash, reconcileTaskTime, observeTaskSources } from "../src/task-events.js";
import { assessTaskFreshness, taskMemoryReader, verifyTaskEvent } from "../src/task-freshness.js";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-freshness-"));
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => 1000 };
  const owner = await mintTaskCredential(ctx.authPath, { actor_id: "owner", domains: ["personal"], role: "owner" });
  const auth = `Bearer ${owner.token}`;
  const source = { id: "producer", kind: "event", producer_actor: "owner", owner_domains: ["personal"], sensitivity: "private", max_age_ms: 1000, enabled: true };
  await callTaskCrud(ctx, auth, "task_source_register", source);
  const input = { idempotency_key: "fixture", original_request: "Reconsider", goal: "Reconsider", resolution_condition: "Owner decision",
    timezone: "Europe/Madrid", scope: { kind: "personal", name: "fixture" }, owner_domains: ["personal"], arm: true,
    schedule: { kind: "event", source_id: "producer", predicate: "equals", expected: "yes" } };
  return { root, ctx, auth, input, source };
}
test("five outcomes preserve source, revision and actual state age, never turn stale into false", async () => {
  const f = await fixture(); await callTaskCrud(f.ctx, f.auth, "task_create", f.input);
  await callTaskCrud(f.ctx, f.auth, "task_event", { source_id: "producer", source_revision: 0, dedup_key: "yes", value: "yes", state_updated_at: 1000 });
  const s = await readTaskStore(f.ctx.path); const task = s.tasks[0]; const event = s.events[0];
  assert.equal(verifyTaskEvent(task, event, s, 1000).outcome, "verified");
  assert.equal(verifyTaskEvent(task, { ...event, value_hash: taskValueHash("no") }, s, 1000).outcome, "refuted");
  assert.equal(verifyTaskEvent(task, event, s, 2001).outcome, "stale");
  assert.equal(verifyTaskEvent(task, { ...event, state_updated_at: undefined }, s, 1000).outcome, "inconclusive");
  s.sources[0].enabled = false; assert.equal(verifyTaskEvent(task, event, s, 1000).outcome, "unavailable");
  const result = verifyTaskEvent(task, event, s, 1000); assert.equal(result.state_updated_at, 1000); assert.equal(result.source_revision, "0");
});
async function premiseFixture(value: string, provenance = "attributable") {
  const f = await fixture(); const raw = JSON.stringify({ claim_id: "assumption", claim_revision: "v1", value, state_updated_at: 1000, provenance });
  const evidenceRevision = taskValueHash(raw); await writeFile(join(f.root, "evidence.json"), raw);
  await callTaskCrud(f.ctx, f.auth, "task_source_register", { ...f.source, id: "evidence", kind: "file", producer_actor: "task-source-reader", root: f.root, path: "evidence.json" });
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input,
    schedule: { kind: "event", source_id: "producer", predicate: "premise", expected: "costly", verifier_id: "versioned-value-v1" },
    decision: { id: "decision", revision: "v1", option: "A", reason: "Maintenance", assumption_id: "assumption", assumption_revision: "v1", premise: "costly", alternatives: ["B"] },
    evidence: [{ source_id: "evidence", id: "evidence", revision: evidenceRevision, hash: evidenceRevision, observed_at: 1000, state_updated_at: 1000, max_age_ms: 1000, provenance: "attributable" }],
  });
  const event = { source_id: "producer", source_revision: 0, dedup_key: "claim", value: "structured claim event", state_updated_at: 1000,
    claim: { claim_id: "assumption", claim_revision: "v1", value, evidence_id: "evidence", evidence_revision: evidenceRevision } };
  await callTaskCrud(f.ctx, f.auth, "task_event", event); return { ...f, event };
}
test("versioned-value verifier refutes only matching fresh attributed snapshot; unchanged stays quiet", async () => {
  for (const value of ["costly", "cheap"]) {
    const f = await premiseFixture(value); await assessTaskFreshness(f.ctx); await reconcileTaskTime(f.ctx);
    const s = await readTaskStore(f.ctx.path); assert.equal(s.tasks[0].verification?.outcome, value === "costly" ? "verified" : "refuted");
    assert.equal(s.occurrences.length, value === "costly" ? 0 : 1);
  }
});
test("contested, irrelevant, missing, revised and stale evidence cannot fabricate refutation", async () => {
  const contested = await premiseFixture("cheap", "contested"); await assessTaskFreshness(contested.ctx); await reconcileTaskTime(contested.ctx);
  assert.equal((await readTaskStore(contested.ctx.path)).tasks[0].verification?.outcome, "inconclusive");
  assert.equal((await readTaskStore(contested.ctx.path)).occurrences.length, 0);
  const changed = await premiseFixture("cheap"); await writeFile(join(changed.root, "evidence.json"), "revised"); await assessTaskFreshness(changed.ctx); await reconcileTaskTime(changed.ctx);
  assert.equal((await readTaskStore(changed.ctx.path)).tasks[0].verification?.outcome, "stale");
  const old = await premiseFixture("cheap"); old.ctx.now = () => 2001; await assessTaskFreshness(old.ctx); await reconcileTaskTime(old.ctx);
  assert.equal((await readTaskStore(old.ctx.path)).tasks[0].verification?.outcome, "stale");
  const irrelevant = await premiseFixture("cheap");
  await callTaskCrud(irrelevant.ctx, irrelevant.auth, "task_event", { ...irrelevant.event, dedup_key: "other", claim: { ...irrelevant.event.claim, claim_id: "irrelevant" } });
  await assessTaskFreshness(irrelevant.ctx); await reconcileTaskTime(irrelevant.ctx); assert.equal((await readTaskStore(irrelevant.ctx.path)).occurrences.length, 0);
});
test("unavailable evidence retries the same journal event after recovery, not condition=false", async () => {
  const f = await premiseFixture("cheap"); const raw = await readFile(join(f.root, "evidence.json"), "utf8");
  const { unlink } = await import("node:fs/promises"); await unlink(join(f.root, "evidence.json"));
  await assessTaskFreshness(f.ctx); await reconcileTaskTime(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).tasks[0].verification?.outcome, "unavailable");
  await writeFile(join(f.root, "evidence.json"), raw); await assessTaskFreshness(f.ctx); await reconcileTaskTime(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 1);
});
test("secret claim values retain exact pre-redaction comparison without executing verify_cmd", async () => {
  const secret = "api_key=sk_" + "z".repeat(36); const f = await premiseFixture(secret);
  await assessTaskFreshness(f.ctx); await reconcileTaskTime(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).tasks[0].verification?.outcome, "refuted");
  assert.ok(!(await readFile(f.ctx.path, "utf8")).includes(secret));
  const malicious = await premiseFixture("cheap"); const marker = join(malicious.root, "should-not-exist");
  await writeFile(join(malicious.root, "evidence.json"), JSON.stringify({ verify_cmd: `touch ${marker}` }));
  await assessTaskFreshness(malicious.ctx); await reconcileTaskTime(malicious.ctx);
  await assert.rejects(readFile(marker), { code: "ENOENT" }); assert.equal((await readTaskStore(malicious.ctx.path)).occurrences.length, 0);
});
test("actual temporary memory source uses disk revision, handles move/duplicate/edit and bounds scan", async () => {
  const f = await fixture(); const root = join(f.root, "vault"); await mkdir(root);
  const raw = '---\nid: fixture-note\ntitle: Fixture\ntype: decision\nsummary: Fixture decision\nscope: fixture\n---\nFixture decision';
  await writeFile(join(root, "note.md"), raw); const vault = new Vault(root); await vault.init();
  try {
    const reader = taskMemoryReader({ vault, vaultPath: root }); const context = { ...f.ctx, memoryRead: reader };
    assert.equal((await reader("fixture-note")).revision, memoryRevision(raw));
    await callTaskCrud(context, f.auth, "task_source_register", { ...f.source, id: "memory", kind: "memory", producer_actor: "task-source-reader", memory_id: "fixture-note" });
    await observeTaskSources(context); assert.equal((await readTaskStore(f.ctx.path)).events.at(-1)?.value, memoryRevision(raw));
    await writeFile(join(root, "duplicate.md"), raw); await assert.rejects(reader("fixture-note"));
    const { unlink } = await import("node:fs/promises"); await unlink(join(root, "duplicate.md"));
    await rename(join(root, "note.md"), join(root, "moved.md"));
    assert.equal((await reader("fixture-note")).revision, memoryRevision(raw));
    await writeFile(join(root, "moved.md"), raw + " changed"); assert.equal((await reader("fixture-note")).revision, memoryRevision(raw + " changed"));
    await writeFile(join(root, "huge.md"), "a".repeat(1024 * 1024 + 1)); await assert.rejects(reader("fixture-note"));
  } finally { await vault.stop(); }
});
test("time reminders with bound evidence wait on actual source freshness and revision", async () => {
  const f = await fixture(); const raw = "evidence"; const revision = taskValueHash(raw); await writeFile(join(f.root, "time-evidence.txt"), raw);
  await callTaskCrud(f.ctx, f.auth, "task_source_register", { ...f.source, id: "time-evidence", kind: "file", producer_actor: "task-source-reader", root: f.root, path: "time-evidence.txt" });
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, schedule: { kind: "instant", at: 1000 }, evidence: [{ source_id: "time-evidence", id: "evidence", revision, observed_at: 1000, state_updated_at: 1000, max_age_ms: 1000, provenance: "attributable" }] });
  await writeFile(join(f.root, "time-evidence.txt"), "changed"); await assessTaskFreshness(f.ctx); await reconcileTaskTime(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).tasks[0].verification?.outcome, "stale"); assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 0);
  await writeFile(join(f.root, "time-evidence.txt"), raw); await assessTaskFreshness(f.ctx); await reconcileTaskTime(f.ctx);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 1);
});
test("event dedup cannot retroactively add or change a structured claim", async () => {
  const f = await premiseFixture("cheap");
  await assert.rejects(callTaskCrud(f.ctx, f.auth, "task_event", { ...f.event, claim: { ...f.event.claim, value: "costly" } }), { code: "conflict" });
  await assert.rejects(callTaskCrud(f.ctx, f.auth, "task_event", { ...f.event, claim: undefined }), { code: "conflict" });
  await assessTaskFreshness(f.ctx); await reconcileTaskTime(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 1);
});
test("twenty identical checks with advancing clocks do not change revisions, audit or snapshot bytes", async () => {
  for (const missing of [false, true]) {
    const f = await premiseFixture("cheap");
    if (missing) { const { unlink } = await import("node:fs/promises"); await unlink(join(f.root, "evidence.json")); }
    await assessTaskFreshness(f.ctx); const initial = await readFile(f.ctx.path, "utf8");
    for (let i = 1; i <= 20; i++) { f.ctx.now = () => 1000 + i * 10; await assessTaskFreshness(f.ctx); }
    assert.equal(await readFile(f.ctx.path, "utf8"), initial);
  }
});
test("future bound state age and persisted future verified cache never cause a time occurrence", async () => {
  const f = await fixture(); const raw = "evidence"; const revision = taskValueHash(raw); await writeFile(join(f.root, "future.txt"), raw);
  await callTaskCrud(f.ctx, f.auth, "task_source_register", { ...f.source, id: "future", kind: "file", producer_actor: "task-source-reader", root: f.root, path: "future.txt" });
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, schedule: { kind: "instant", at: 1000 }, evidence: [{ source_id: "future", id: "evidence", revision, observed_at: 1000, state_updated_at: 999999, max_age_ms: 1000, provenance: "attributable" }] });
  await assessTaskFreshness(f.ctx); await reconcileTaskTime(f.ctx); let s = await readTaskStore(f.ctx.path);
  assert.equal(s.tasks[0].verification?.outcome, "inconclusive"); assert.equal(s.occurrences.length, 0);
  s.tasks[0].verification!.outcome = "verified"; s.tasks[0].verification!.state_updated_at = 999999;
  await writeFile(f.ctx.path, JSON.stringify(s)); await reconcileTaskTime(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 0);
});
test("a disabled evidence source invalidates a previously verified cached time check", async () => {
  const f = await fixture(); const raw = "evidence"; const revision = taskValueHash(raw); await writeFile(join(f.root, "enabled.txt"), raw);
  await callTaskCrud(f.ctx, f.auth, "task_source_register", { ...f.source, id: "enabled", kind: "file", producer_actor: "task-source-reader", root: f.root, path: "enabled.txt" });
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, schedule: { kind: "instant", at: 1000 }, evidence: [{ source_id: "enabled", id: "evidence", revision, observed_at: 1000, state_updated_at: 1000, max_age_ms: 1000, provenance: "attributable" }] });
  await assessTaskFreshness(f.ctx); const s = await readTaskStore(f.ctx.path); assert.equal(s.tasks[0].verification?.outcome, "verified");
  s.sources.find(source => source.id === "enabled")!.enabled = false; await writeFile(f.ctx.path, JSON.stringify(s));
  await reconcileTaskTime(f.ctx); assert.equal((await readTaskStore(f.ctx.path)).occurrences.length, 0);
});
test("twenty unchanged clock/evidence checks keep the entire snapshot unchanged", async () => {
  const f = await fixture(); const raw = "clock evidence"; const revision = taskValueHash(raw); await writeFile(join(f.root, "quiet.txt"), raw);
  await callTaskCrud(f.ctx, f.auth, "task_source_register", { ...f.source, id: "quiet", kind: "file", producer_actor: "task-source-reader", root: f.root, path: "quiet.txt" });
  await callTaskCrud(f.ctx, f.auth, "task_create", { ...f.input, schedule: { kind: "instant", at: 2000 }, evidence: [{ source_id: "quiet", id: "evidence", revision, observed_at: 1000, state_updated_at: 1000, max_age_ms: 1000, provenance: "attributable" }] });
  await assessTaskFreshness(f.ctx); const initial = await readFile(f.ctx.path, "utf8");
  for (let i = 1; i <= 20; i++) { f.ctx.now = () => 1000 + i * 10; await assessTaskFreshness(f.ctx); }
  assert.equal(await readFile(f.ctx.path, "utf8"), initial);
});
test("versioned claim retry ignores input/persisted key order and preserves its original journal identity", async () => {
  const f = await premiseFixture("cheap"); const first = (await readTaskStore(f.ctx.path)).events[0];
  const again = await callTaskCrud(f.ctx, f.auth, "task_event", f.event) as { event_id: string };
  assert.equal(again.event_id, first.id); assert.equal((await readTaskStore(f.ctx.path)).events.length, 1);
  const reordered = { ...f.event, claim: Object.fromEntries(Object.entries(f.event.claim).reverse()) };
  assert.equal((await callTaskCrud(f.ctx, f.auth, "task_event", reordered) as {event_id:string}).event_id, first.id);
  await assert.rejects(callTaskCrud(f.ctx, f.auth, "task_event", { ...f.event, claim: { ...f.event.claim, value: "different" } }), { code: "conflict" });
  await assert.rejects(callTaskCrud(f.ctx, f.auth, "task_event", { ...f.event, claim: { ...f.event.claim, evidence_revision: "different" } }), { code: "conflict" });
});
