import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTaskCredential, authenticateTask } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { readTaskStore, transactTaskStore } from "../src/task-store.js";
import { reconcileTaskTime } from "../src/task-events.js";
import { taskDueInput, taskDueProjection } from "../src/task-outbox.js";
import { notifyDueTasks } from "../src/task-notification.js";
import { deliverTaskChats, type TaskChatDeliveryOptions } from "../src/task-chat-delivery.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task-chat-delivery-"));
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => 3000 };
  const credential = await mintTaskCredential(ctx.authPath, { actor_id: "owner", domains: ["personal"], role: "owner" });
  const auth = `Bearer ${credential.token}`;
  await callTaskCrud(ctx, auth, "task_create", { idempotency_key: "chat", original_request: "Synthetic task", goal: "Synthetic $(do not execute)", resolution_condition: "Done", schedule: { kind: "instant", at: 2000 }, timezone: "Europe/Berlin", scope: { kind: "personal", name: "fixture" }, owner_domains: ["personal"], arm: true });
  await reconcileTaskTime(ctx);
  const target = { sessionId: "test-session", client: "claude-code", generation: "test-generation", socketPath: "/test/socket", token: "private", transcriptPath: "/test/transcript", transcriptDev: 1, transcriptIno: 1, generationOffset: 0, offset: 0, registeredAt: 1000, expiresAt: 999999, lastHumanAt: 2500 };
  const events: Record<string, unknown>[] = [];
  const sent: string[] = [];
  const options: TaskChatDeliveryOptions = { settings: async () => ({ consent: true, activeMinutes: 30 }), latest: async () => target, sessions: async () => [target], validate: async () => true, transcript: async () => events, send: async (_target, content) => { sent.push(content); } };
  return { ctx, auth, target, options, events, sent };
}
test("atomic chat claim survives concurrent dispatch and restart, without acknowledging", async () => {
  const f = await fixture();
  await Promise.all([deliverTaskChats(f.ctx, f.options), deliverTaskChats(f.ctx, f.options)]);
  await deliverTaskChats(f.ctx, f.options);
  assert.equal(f.sent.length, 1);
  const s = await readTaskStore(f.ctx.path); const delivery = s.occurrences[0].chat_delivery!;
  assert.equal(delivery.session_id, f.target.sessionId); assert.equal(delivery.generation, f.target.generation);
  assert.ok(delivery.submitted_at); assert.equal(delivery.processed_at, undefined);
  assert.equal(s.occurrences[0].acknowledgement, undefined); assert.equal(s.tasks[0].state, "due");
  assert.ok(!JSON.stringify(delivery).includes("private")); assert.ok(!JSON.stringify(delivery).includes("/test/socket"));
  assert.match(f.sent[0], /DATA/); assert.match(f.sent[0], new RegExp(delivery.event_id));
});
test('Codex bridge uses the same durable claim without requiring Claude settings consent',async()=>{
 const f=await fixture();Object.assign(f.target,{client:'codex',codexBridge:true});
 f.options.settings=async()=>({consent:false,activeMinutes:30});
 await deliverTaskChats(f.ctx,f.options);await deliverTaskChats(f.ctx,f.options);
 assert.equal(f.sent.length,1);const claim=(await readTaskStore(f.ctx.path)).occurrences[0].chat_delivery!;
 assert.equal(claim.session_id,f.target.sessionId);assert.equal(claim.generation,f.target.generation);
 f.events.push({type:'user',uuid:'peer',origin:{kind:'peer'},message:{content:f.sent[0]}},{type:'assistant',uuid:'reply',parentUuid:'peer',message:{content:claim.event_id}});
 await deliverTaskChats(f.ctx,f.options);
 assert.equal((await readTaskStore(f.ctx.path)).occurrences[0].chat_delivery?.processed_at,3000);
 // A newer Claude tab cannot announce the same occurrence after a restart.
 f.target.client='claude-code';f.options.settings=async()=>({consent:true,activeMinutes:30});
 await deliverTaskChats(f.ctx,f.options);assert.equal(f.sent.length,1);
});
test("processing receipt needs exact peer payload and an assistant descendant, never a socket write or human text", async () => {
  const f = await fixture(); await deliverTaskChats(f.ctx, f.options);
  f.events.push({ type: "user", uuid: "human", origin: { kind: "human" }, message: { content: f.sent[0] } }, { type: "assistant", parentUuid: "human", uuid: "assistant-human" });
  await deliverTaskChats(f.ctx, f.options); assert.equal((await readTaskStore(f.ctx.path)).occurrences[0].chat_delivery?.processed_at, undefined);
  f.events.push({ type: "user", uuid: "peer", origin: { kind: "peer" }, turnOrigin: "peer", message: { content: `Another Claude session sent a message:\n${f.sent[0]}\n\nProvider security envelope` } });
  await deliverTaskChats(f.ctx, f.options); assert.equal((await readTaskStore(f.ctx.path)).occurrences[0].chat_delivery?.processed_at, undefined);
  f.events.push({ type: "assistant", uuid: "assistant-unrelated", parentUuid: "peer", message: { content: [{ type: "thinking", thinking: "reasoning" }] } });
  await deliverTaskChats(f.ctx, f.options); assert.equal((await readTaskStore(f.ctx.path)).occurrences[0].chat_delivery?.processed_at, undefined);
  const eventId = (await readTaskStore(f.ctx.path)).occurrences[0].chat_delivery!.event_id;
  f.events.push({ type: "assistant", uuid: "assistant-peer", parentUuid: "assistant-unrelated", message: { content: [{ type: "text", text: `Recall task due (${eventId})` }] } });
  await deliverTaskChats(f.ctx, f.options); assert.equal((await readTaskStore(f.ctx.path)).occurrences[0].chat_delivery?.processed_at, 3000);
  const principal = await authenticateTask(f.auth, f.ctx.authPath); const s = await readTaskStore(f.ctx.path);
  assert.equal(taskDueProjection(s, principal, taskDueInput.parse({}), 3000, true).cards.length, 0);
  assert.equal(taskDueProjection(s, principal, taskDueInput.parse({}), 3000).cards.length, 1, "board inspection stays visible");
  assert.equal(s.occurrences[0].acknowledgement, undefined);
});
test("ambiguous or refused sends never retry and Mac notification remains independent", async () => {
  const f = await fixture(); let calls = 0;
  f.options.send = async () => { calls++; throw new Error("connection outcome unknown"); };
  await deliverTaskChats(f.ctx, f.options); await deliverTaskChats(f.ctx, f.options); assert.equal(calls, 1);
  let os = 0; await notifyDueTasks(f.ctx, { platform: "darwin", enabled: true, send: async () => { os++; } });
  await notifyDueTasks(f.ctx, { platform: "darwin", enabled: true, send: async () => { os++; } }); assert.equal(os, 1);
  assert.equal((await readTaskStore(f.ctx.path)).occurrences[0].chat_delivery?.processed_at, undefined);
});
test("no consent, inactive/unsupported latest chat, changed generation or muted task never sends", async () => {
  for (const mode of ["consent", "inactive", "unsupported", "generation", "muted"]) {
    const f = await fixture();
    if (mode === "consent") f.options.settings = async () => ({ consent: false, activeMinutes: 30 });
    if (mode === "inactive") f.target.lastHumanAt = 1;
    if (mode === "inactive") f.ctx.now = () => 2000000;
    if (mode === "unsupported") f.target.client = "codex";
    if (mode === "generation") f.options.validate = async () => false;
    if (mode === "muted") await transactTaskStore(f.ctx.path, undefined, s => { s.controls.muted = true; });
    await deliverTaskChats(f.ctx, f.options); assert.equal(f.sent.length, 0, mode);
  }
});
test("a resumed generation cannot confirm a previous generation's delivery", async () => {
  const f = await fixture(); await deliverTaskChats(f.ctx, f.options);
  f.target.generation = "resumed";
  f.events.push({ type: "user", uuid: "peer", origin: { kind: "peer" }, message: { content: f.sent[0] } }, { type: "assistant", uuid: "assistant", parentUuid: "peer" });
  await deliverTaskChats(f.ctx, f.options); assert.equal((await readTaskStore(f.ctx.path)).occurrences[0].chat_delivery?.processed_at, undefined);
});
test("latest-chat changes after the atomic claim cannot send to the older chat", async () => {
  const f = await fixture(); let selections = 0;
  f.options.latest = async () => ++selections === 1 ? f.target : { ...f.target, sessionId: "newer-codex", client: "codex" };
  await deliverTaskChats(f.ctx, f.options); assert.equal(f.sent.length, 0);
  assert.ok((await readTaskStore(f.ctx.path)).occurrences[0].chat_delivery, "uncertain claim is never reused");
});
test("pending and confirmed inbox deliveries never reappear in normal agent contact", async () => {
  const f = await fixture(); await deliverTaskChats(f.ctx, f.options);
  const principal = { ...await authenticateTask(f.auth, f.ctx.authPath), role: "agent" as const };
  const s = await readTaskStore(f.ctx.path);
  assert.equal(taskDueProjection(s, principal, taskDueInput.parse({}), 3000).cards.length, 0);
  assert.equal(taskDueProjection(s, principal, taskDueInput.parse({}), 3000).pending, 1);
});
test("busy-session queued peer command has a receipt only for its visible assistant descendant", async () => {
  const f = await fixture(); await deliverTaskChats(f.ctx, f.options);
  const eventId = (await readTaskStore(f.ctx.path)).occurrences[0].chat_delivery!.event_id;
  f.events.push({ type: "attachment", uuid: "queued-human", attachment: { type: "queued_command", origin: { kind: "human" }, prompt: f.sent[0] } },
    { type: "assistant", uuid: "human-response", parentUuid: "queued-human", message: { content: eventId } });
  await deliverTaskChats(f.ctx, f.options); assert.equal((await readTaskStore(f.ctx.path)).occurrences[0].chat_delivery?.processed_at, undefined);
  f.events.push({ type: "attachment", uuid: "queued-peer", attachment: { type: "queued_command", origin: { kind: "peer", from: "unknown" }, isMeta: true, prompt: f.sent[0] } },
    { type: "assistant", uuid: "busy-response", parentUuid: "queued-peer", message: { content: [{ type: "text", text: `Recall: ${eventId}` }] } });
  await deliverTaskChats(f.ctx, f.options); assert.equal((await readTaskStore(f.ctx.path)).occurrences[0].chat_delivery?.processed_at, 3000);
});
