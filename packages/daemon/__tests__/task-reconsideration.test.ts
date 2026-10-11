import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, memoryRevision } from "@bastra-recall/core";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { readTaskStore } from "../src/task-store.js";
import { taskMemoryReader, taskMemoryChanger, assessTaskFreshness } from "../src/task-freshness.js";
import { taskDecisionStatus } from "../src/task-reconsideration.js";
import { taskValueHash, reconcileTaskTime } from "../src/task-events.js";
async function fixture(long=false) {
  const root = await mkdtemp(join(tmpdir(), "task-reconsider-")); const vaultPath = join(root, "vault"); await mkdir(vaultPath);
  const decisionRaw = '---\nid: decision\ntitle: Decision\nscope: fixture\ntype: decision\nsummary: Chose A\nsensitivity: private\n---\nChose A because maintenance costs are high.\n';
  const assumptionRaw = '---\nid: assumption\ntitle: Assumption\nscope: fixture\ntype: reference\nsummary: Maintenance cost\nsensitivity: private\n---\ncostly\n';
  const decisionPath = join(vaultPath, "decision.md"); const assumptionPath = join(vaultPath, "assumption.md");
  await writeFile(decisionPath, decisionRaw); await writeFile(assumptionPath, assumptionRaw);
  const vault = new Vault(vaultPath); await vault.init(); const deps = { vault, vaultPath };
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => 1000, memoryRead: taskMemoryReader(deps), memoryChange: taskMemoryChanger(deps), memorySubscribe: (listener: (id: string) => void) => vault.on(e => listener(e.kind === "remove" ? e.id : e.memory.fm.id)) };
  const owner = await mintTaskCredential(ctx.authPath, { actor_id: "owner", domains: ["personal"], role: "owner" }); const auth = `Bearer ${owner.token}`;
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "agent", domains: ["personal"], role: "agent" });
  const source = { id: "producer", kind: "event", producer_actor: "owner", owner_domains: ["personal"], sensitivity: "private", max_age_ms: 1000, enabled: true };
  await callTaskCrud(ctx, auth, "task_source_register", source);
  const assumptionRevision = memoryRevision(assumptionRaw);
  const raw = JSON.stringify({ claim_id: "assumption", claim_revision: assumptionRevision, value: "cheap", state_updated_at: 1000, provenance: "attributable" });
  await writeFile(join(root, "evidence.json"), raw); const evidenceRevision = taskValueHash(raw);
  await callTaskCrud(ctx, auth, "task_source_register", { ...source, id: "evidence", kind: "file", producer_actor: "task-source-reader", root, path: "evidence.json" });
  await callTaskCrud(ctx, auth, "task_create", { idempotency_key: "reconsider", original_request: long?"Nach Prüfung der langfristigen ökonomischen Annahme sollen Alternativen vollständig erklärt werden. ".repeat(12):"Reconsider A when maintenance is cheaper", goal: long?"Ökonomische Neubewertung der Wartungskosten und sämtlicher begründeter Alternativen. ".repeat(8):"Reconsider A", resolution_condition: "Owner chooses", timezone: "Europe/Madrid", scope: { kind: "personal", name: "fixture" }, owner_domains: ["personal"], arm: true,
    schedule: { kind: "event", source_id: "producer", predicate: "premise", expected: "costly", verifier_id: "versioned-value-v1" },
    decision: { id: "decision", revision: memoryRevision(decisionRaw), option: "A", reason: long?"Die ursprünglich gewählte Alternative benötigt höhere Wartungskosten und zusätzliche Überprüfungen. ".repeat(12):"Maintenance cost", assumption_id: "assumption", assumption_revision: assumptionRevision, premise: "costly", alternatives: ["B"] },
    evidence: [{ source_id: "evidence", id: "evidence", revision: evidenceRevision, hash: evidenceRevision, observed_at: 1000, state_updated_at: 1000, max_age_ms: 1000, provenance: "attributable" }] });
  const event = { source_id: "producer", source_revision: 0, dedup_key: "cheaper", value: "Maintenance evidence", state_updated_at: 1000,
    claim: { claim_id: "assumption", claim_revision: assumptionRevision, value: "cheap", evidence_id: "evidence", evidence_revision: evidenceRevision } };
  await callTaskCrud(ctx, auth, "task_event", event); await assessTaskFreshness(ctx);
  await ctx.memoryRead("decision"); await ctx.memoryRead("assumption");
  const snapshot = await readTaskStore(ctx.path);
  assert.equal(await taskDecisionStatus(ctx, snapshot.tasks[0]), undefined);
  const command = async (choice: string, extra = {}) => {
    const s = await readTaskStore(ctx.path); return callTaskCrud(ctx, auth, "task_reconsider", { id: s.tasks[0].id, expected_revision: `${s.recovery_epoch}:${s.tasks[0].revision}`, occurrence_id: s.occurrences[0].id, choice, ...extra }) as Promise<any>;
  };
  return { root, ctx, auth, agent, event, vault, decisionRaw, decisionPath, assumptionPath, command };
}
test("actual decision/assumption revisions yield one explainable reconsideration; keep consumes only material", async () => {
  const f = await fixture(); await reconcileTaskTime(f.ctx); await reconcileTaskTime(f.ctx);
  const due = await callTaskCrud(f.ctx, f.auth, "task_due", {}) as any;
  assert.equal(due.cards.length, 1); assert.equal(due.cards[0].reconsideration.decision.option, "A");
  assert.equal(due.cards[0].reconsideration.old_premise, "costly"); assert.equal(due.cards[0].reconsideration.new_premise, "cheap");
  await f.command("keep"); await callTaskCrud(f.ctx, f.auth, "task_event", { ...f.event, dedup_key: "same-material" }); await assessTaskFreshness(f.ctx); await reconcileTaskTime(f.ctx);
  const s = await readTaskStore(f.ctx.path); assert.equal(s.occurrences.length, 1); assert.equal(s.tasks[0].armed, false);
  assert.equal((await callTaskCrud(f.ctx, f.auth, "task_due", {} ) as any).cards.length, 0);
  assert.ok(s.tasks[0].history.at(-2)?.decision_snapshot || s.tasks[0].history.some(h => h.operation === "decision-keep" && h.decision_snapshot));
});
test("edited/missing/cancelled/superseded bindings disarm old watch and never rebind or fire", async () => {
  for (const mode of ["edit-decision", "edit-assumption", "missing", "cancelled", "superseded"]) {
    const f = await fixture();
    if (mode === "missing") await unlink(f.assumptionPath);
    else if (mode === "edit-assumption") await writeFile(f.assumptionPath, "changed");
    else await writeFile(f.decisionPath, mode === "edit-decision" ? f.decisionRaw + "changed" : f.decisionRaw.replace('summary:', `${mode === "cancelled" ? "status: cancelled" : "superseded_by: another"}\nsummary:`));
    await reconcileTaskTime(f.ctx); const s = await readTaskStore(f.ctx.path);
    assert.equal(s.tasks[0].armed, false, mode); assert.equal(s.occurrences.length, 0, mode); assert.equal(s.tasks[0].decision!.revision, memoryRevision(f.decisionRaw));
    const bytes = await readFile(f.ctx.path, "utf8"); await reconcileTaskTime(f.ctx); assert.equal(await readFile(f.ctx.path, "utf8"), bytes);
  }
});
test("snooze and stop remain distinct; agent cannot confirm a new decision", async () => {
  const f = await fixture(); await reconcileTaskTime(f.ctx); await f.command("snooze", { until: 2000 });
  assert.equal((await readTaskStore(f.ctx.path)).tasks[0].state, "snoozed"); assert.equal((await callTaskCrud(f.ctx, f.auth, "task_due", {}) as any).cards.length, 0);
  const s = await readTaskStore(f.ctx.path);
  await assert.rejects(callTaskCrud(f.ctx, `Bearer ${f.agent.token}`, "task_reconsider", { id: s.tasks[0].id, expected_revision: `${s.recovery_epoch}:${s.tasks[0].revision}`, occurrence_id: s.occurrences[0].id, choice: "keep" }), /owner/);
  await f.command("stop"); assert.equal((await readTaskStore(f.ctx.path)).tasks[0].state, "cancelled"); assert.equal(await readFile(f.decisionPath, "utf8"), f.decisionRaw);
});
test("owner change writes a real new CAS memory revision, retains old history and disarms old watch", async () => {
  const f = await fixture(); await reconcileTaskTime(f.ctx);
  const change = { idempotency_key: "new-choice", expected_memory_revision: memoryRevision(f.decisionRaw), body: "Choose B now; password=0427", option: "B", reason: "Lower maintenance" };
  const result = await f.command("change", { change }); const raw = await readFile(f.decisionPath, "utf8");
  assert.ok(!raw.includes("proactive_change_id")); assert.match(raw, /Choose B now/); assert.equal(memoryRevision(raw), result.revision);
  const s = await readTaskStore(f.ctx.path); assert.equal(s.tasks[0].armed, false); assert.equal(s.tasks[0].decision!.option, "A"); assert.equal(s.tasks[0].decision_change!.status, "applied");
  assert.match(s.tasks[0].decision_change!.new_body_hash!, /^hmac-v1:/);
  const publicTask = await callTaskCrud(f.ctx,f.auth,"task_get",{id:s.tasks[0].id});assert.ok(!JSON.stringify(publicTask).includes(s.tasks[0].decision_change!.new_body_hash!));
  const retry = await f.command("change", { change }); assert.equal(retry.revision, result.revision); assert.equal(await readFile(f.decisionPath, "utf8"), raw);
  await assert.rejects(f.command("change", { change: { ...change, body: "different" } }), /differs/);
});
test("crash after memory write resumes exact intent without a second write; concurrent memory edit fails closed", async () => {
  const f = await fixture(); await reconcileTaskTime(f.ctx); const writer = f.ctx.memoryChange;
  f.ctx.memoryChange = async (...args) => { await writer(...args); throw new Error("simulated crash after CAS"); };
  const change = { idempotency_key: "crash", expected_memory_revision: memoryRevision(f.decisionRaw), body: "Choose B.", option: "B", reason: "Premise changed" };
  await assert.rejects(f.command("change", { change }), /simulated crash/); const raw = await readFile(f.decisionPath, "utf8");
  assert.equal((await readTaskStore(f.ctx.path)).tasks[0].decision_change!.status, "pending"); f.ctx.memoryChange = writer;
  await f.command("change", { change }); assert.equal(await readFile(f.decisionPath, "utf8"), raw);
  const g = await fixture(); await reconcileTaskTime(g.ctx); await writeFile(g.decisionPath, g.decisionRaw + "External edit");
  await assert.rejects(g.command("change", { change: { ...change, expected_memory_revision: memoryRevision(g.decisionRaw) } }), /binding changed/);
  assert.match(await readFile(g.decisionPath, "utf8"), /External edit/);
});

test("occurrence premise survives later verification and edited memories withdraw cached cards immediately", async () => {
  const f = await fixture(); await reconcileTaskTime(f.ctx);
  const { startProactiveTaskJob } = await import("../src/daemon-jobs.js"); const { cachedTaskSnapshot } = await import("../src/task-outbox.js");
  const { reconsiderationCard } = await import("../src/task-reconsideration.js"); const job = startProactiveTaskJob(f.ctx); await job.runtime.ready;
  try {
    const s = await readTaskStore(f.ctx.path); s.tasks[0].verification!.refuted_value = "unrelated later value";
    assert.equal(reconsiderationCard(s.tasks[0], s.occurrences[0], s)!.new_premise, "cheap");
    assert.ok(!JSON.stringify(reconsiderationCard(s.tasks[0],s.occurrences[0],s)).includes(s.events[0].claim!.value_hash!));
    await writeFile(f.decisionPath, f.decisionRaw + "Changed"); await f.vault.reindexFile(f.decisionPath);
    assert.equal(cachedTaskSnapshot(f.ctx.path)!.tasks[0].armed, false);
    assert.equal((await callTaskCrud(f.ctx, f.auth, "task_due", {}) as any).cards.length, 0);
  } finally { job.stop(); await job.runtime.settle(); }
});

test("long reconsideration survives the standard 2048-byte API/passive budget with choices and get details",async()=>{
 const f=await fixture(true);const {startProactiveTaskJob}=await import("../src/daemon-jobs.js"),{taskAttachment}=await import("../src/task-delivery.js"),{taskDueText}=await import("../src/task-outbox.js");let job:ReturnType<typeof startProactiveTaskJob>|undefined;
 try{await reconcileTaskTime(f.ctx);const due=await callTaskCrud(f.ctx,f.auth,"task_due",{}) as any;assert.equal(due.cards.length,1);assert.equal(due.overflow,0);assert.equal(due.cards[0].compact,true);assert.match(due.cards[0].detail_command,/bastra tasks get/);assert.deepEqual(due.cards[0].reconsideration.choices,["keep","change","snooze","stop"]);assert.ok(Buffer.byteLength(taskDueText(due))<=2048);
 job=startProactiveTaskJob(f.ctx);await job.runtime.ready;const credential=await mintTaskCredential(f.ctx.authPath,{actor_id:"long-card-reader",role:"agent",domains:["personal"]});const attached=await taskAttachment(f.ctx,`Bearer ${credential.token}`,"long-session","mcp");assert.ok(attached);assert.equal(attached.due.cards.length,1);assert.ok((attached.due.cards[0].reconsideration as any).choices.includes("change"));assert.match(attached.text,/bastra tasks get/);assert.ok(Buffer.byteLength(attached.text)<=2048);
 }finally{job?.stop();await job?.runtime.settle();await f.vault.stop();}
});
