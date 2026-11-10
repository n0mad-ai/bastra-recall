import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { readTaskStore, transactTaskStore } from "../src/task-store.js";
import { reconcileTaskTime } from "../src/task-events.js";
import type { ApprovalRegistry } from "../src/task-approval-keys.js";

const authorization = { write_origin: "user-directed", session_id: "chat-session", program: "codex", user_request: "Bitte ersetze die lokale Datei durch new.", at: 1000 };
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "task-chat-authorization-")));
  await writeFile(join(root, "artifact.txt"), "old\n");
  const registry: ApprovalRegistry = { schema_version: 1, revision: 1, protected_boundary: false, keys: [], targets: [{ id: "artifact", root, path: "artifact.txt", owner_domains: ["personal"], sensitivity: "private", adapter: "local-artifact-v1" }] };
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), executionHost: true, now: () => 1000, actionClock: () => ({ boot_id: "fixture", monotonic: 1000 }), approvalRegistry: Promise.resolve(registry) };
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "agent", role: "agent", domains: ["personal"] });
  const owner = await mintTaskCredential(ctx.authPath, { actor_id: "owner", role: "owner", domains: ["personal"] });
  const auth = `Bearer ${agent.token}`, ownerAuth = `Bearer ${owner.token}`;
  await callTaskCrud(ctx, ownerAuth, "task_create", { idempotency_key: "chat", original_request: authorization.user_request, goal: "Replace local artifact", resolution_condition: "File replaced", schedule: { kind: "instant", at: 500 }, timezone: "Europe/Berlin", scope: { kind: "personal", name: "fixture" }, owner_domains: ["personal"], action_level: "execute", arm: true });
  await reconcileTaskTime(ctx);
  await callTaskCrud(ctx, ownerAuth, "task_controls", { execution_stopped: false, adapter: { id: "local-artifact-v1", enabled: true } });
  const task = (await readTaskStore(ctx.path)).tasks[0];
  const prepare = (proof?: typeof authorization) => callTaskCrud(ctx, auth, "task_prepare", { id: task.id, expected_revision: `initial:${task.revision}`, target_id: "artifact", payload: "new\n", ...(proof ? { authorization: proof } : {}) }) as Promise<any>;
  return { ctx, root, auth, ownerAuth, prepare };
}

test("user instruction supplied by a mapped agent executes without keys or a second approval and remains visible", async () => {
  const f = await fixture(), prepared = await f.prepare(authorization);
  const status = await callTaskCrud(f.ctx, f.auth, "task_proposal", { proposal_id: prepared.proposal.id }) as any;
  assert.equal(status.approved, true);
  assert.deepEqual(status.authorization, authorization);
  const lease = await callTaskCrud(f.ctx, f.auth, "task_lease", { proposal_id: prepared.proposal.id }) as any;
  const input = { proposal_id: prepared.proposal.id, lease_id: lease.lease.id, holder_token: lease.holder_token, fence: lease.lease.fence, idempotency_key: "chat-write" };
  const result = await callTaskCrud(f.ctx, f.auth, "task_execute", input) as any;
  assert.equal(result.state, "succeeded");
  assert.equal(await readFile(join(f.root, "artifact.txt"), "utf8"), "new\n");
  assert.deepEqual(await callTaskCrud(f.ctx, f.auth, "task_execute", input), result);
  const store = await readTaskStore(f.ctx.path);
  assert.deepEqual(store.approvals[0].authorization, authorization);
  assert.equal(store.receipts.length, 1);
  const statusAfter = await callTaskCrud(f.ctx, f.auth, "task_status", {}) as any;
  assert.deepEqual(statusAfter.authorizations[0].authorization, authorization);
  assert.equal(statusAfter.authorizations[0].consumed, true);
  for (const secret of ["signature", "binding_hash", "registry_hash"]) assert.equal(JSON.stringify(statusAfter.authorizations).includes(secret), false);
  // A requested undo records its instruction during preview; no second approval ceremony.
  const undoAuthorization = { ...authorization, user_request: "Mach diese Änderung rückgängig." };
  const rollback = await callTaskCrud(f.ctx, f.auth, "task_rollback_prepare", { receipt_id: result.receipt.id, authorization: undoAuthorization }) as any;
  assert.equal(rollback.approved, true);
  assert.equal(rollback.new_owner_approvals_required, false);
  const undoLease = await callTaskCrud(f.ctx, f.auth, "task_lease", { proposal_id: rollback.proposal.id }) as any;
  await callTaskCrud(f.ctx, f.auth, "task_execute", { proposal_id: rollback.proposal.id, lease_id: undoLease.lease.id, holder_token: undoLease.holder_token, fence: undoLease.lease.fence, idempotency_key: "chat-undo" });
  assert.equal(await readFile(join(f.root, "artifact.txt"), "utf8"), "old\n");
});

test("an unrequested action needs the chat yes once, with no interpretation of its language", async () => {
  const f = await fixture(), prepared = await f.prepare();
  await assert.rejects(callTaskCrud(f.ctx, f.auth, "task_lease", { proposal_id: prepared.proposal.id }), { code: "approval_missing" });
  const chatYes = { ...authorization, user_request: "はい、その変更を実行してください。" };
  const approval = await callTaskCrud(f.ctx, f.auth, "task_approval", { proposal_id: prepared.proposal.id, decision: "approve", authorization: chatYes }) as any;
  assert.equal(approval.approved, true);
  assert.deepEqual(approval.authorization, chatYes);
  const repeated = await callTaskCrud(f.ctx, f.auth, "task_approval", { proposal_id: prepared.proposal.id, decision: "approve", authorization: chatYes }) as any;
  assert.equal(repeated.approval_id, approval.approval_id);
  await callTaskCrud(f.ctx, f.auth, "task_lease", { proposal_id: prepared.proposal.id });
});

test("chat approval retains exact target binding, revocation and mandatory provenance", async () => {
  const f = await fixture(), prepared = await f.prepare(authorization);
  await writeFile(join(f.root, "artifact.txt"), "someone else changed this\n");
  await assert.rejects(callTaskCrud(f.ctx, f.auth, "task_lease", { proposal_id: prepared.proposal.id }), { code: "approval_stale" });
  const g = await fixture(), p = await g.prepare(authorization), store = await readTaskStore(g.ctx.path);
  const stranger = await mintTaskCredential(g.ctx.authPath, { actor_id: "stranger", role: "agent", domains: ["personal"] });
  await assert.rejects(callTaskCrud(g.ctx, `Bearer ${stranger.token}`, "task_revoke_approval", { approval_id: store.approvals[0].id }), { code: "forbidden" });
  await callTaskCrud(g.ctx, g.auth, "task_revoke_approval", { approval_id: store.approvals[0].id });
  await assert.rejects(callTaskCrud(g.ctx, g.auth, "task_lease", { proposal_id: p.proposal.id }), { code: "approval_revoked" });
  await assert.rejects(g.prepare({ ...authorization, session_id: "" }));
  await assert.rejects(g.prepare({ ...authorization, write_origin: "agent-observed" }));
  const repeatedRevocation = await callTaskCrud(g.ctx, g.auth, "task_approval", { proposal_id: p.proposal.id, decision: "approve", authorization }) as any;
  assert.equal(repeatedRevocation.approved, false);
  assert.equal(repeatedRevocation.domain_status[0].reason, "approval_revoked");
});

test("legacy signatures and exact action hashes never appear in the status provenance", async () => {
  const f = await fixture(), prepared = await f.prepare(authorization);
  await transactTaskStore(f.ctx.path, undefined, store => {
    const legacy = structuredClone(store.approvals[0]);
    legacy.id = "historical-signature"; delete legacy.authorization; delete legacy.actor; delete legacy.credential_id;
    legacy.signature = "legacy-secret-signature"; store.approvals.push(legacy);
  });
  const status = await callTaskCrud(f.ctx, f.auth, "task_status", {}) as any;
  assert.equal(status.authorizations.length, 1);
  assert.equal(status.authorizations[0].proposal_id, prepared.proposal.id);
  for (const secret of ["legacy-secret-signature", "signature", "binding_hash", "registry_hash"]) assert.equal(JSON.stringify(status.authorizations).includes(secret), false);
});

test("replaying the same chat instruction cannot renew a consumed approval even when exact target bytes still match", async () => {
  const f = await fixture(), task = (await readTaskStore(f.ctx.path)).tasks[0];
  const prepared = await callTaskCrud(f.ctx, f.auth, "task_prepare", { id: task.id, expected_revision: `initial:${task.revision}`, target_id: "artifact", payload: "old\n", authorization }) as any;
  const lease = await callTaskCrud(f.ctx, f.auth, "task_lease", { proposal_id: prepared.proposal.id }) as any;
  await callTaskCrud(f.ctx, f.auth, "task_execute", { proposal_id: prepared.proposal.id, lease_id: lease.lease.id, holder_token: lease.holder_token, fence: lease.lease.fence, idempotency_key: "no-op" });
  const replay = await callTaskCrud(f.ctx, f.auth, "task_approval", { proposal_id: prepared.proposal.id, decision: "approve", authorization }) as any;
  assert.equal(replay.approved, false);
  assert.equal(replay.domain_status[0].reason, "approval_consumed");
  assert.equal((await readTaskStore(f.ctx.path)).approvals.length, 1);
  await assert.rejects(callTaskCrud(f.ctx, f.auth, "task_lease", { proposal_id: prepared.proposal.id }), { code: "approval_consumed" });
});

test("account-local target registry is live without restarting and old prepared bindings become stale", async () => {
  const f = await fixture(), registry = await f.ctx.approvalRegistry;
  const path = join(f.root, "task-action-registry.json");
  const ctx = { ...f.ctx, approvalRegistryPath: path, approvalRegistry: Promise.resolve(undefined) };
  const before = await callTaskCrud(ctx, f.auth, "task_status", {}) as any;
  assert.equal(before.approval.configured, false);
  await writeFile(path, JSON.stringify(registry), { mode: 0o600 });
  const task = (await readTaskStore(ctx.path)).tasks[0];
  await callTaskCrud(ctx, f.auth, "task_controls", { execution_stopped: false, adapter: { id: "local-artifact-v1", enabled: true } });
  const prepared = await callTaskCrud(ctx, f.auth, "task_prepare", { id: task.id, expected_revision: `initial:${task.revision}`, target_id: "artifact", payload: "new\n", authorization }) as any;
  assert.equal(prepared.approved, true);
  assert.equal((await callTaskCrud(ctx, f.auth, "task_status", {}) as any).approval.configured, true);
  await writeFile(path, JSON.stringify({ ...registry, revision: registry.revision + 1 }), { mode: 0o600 });
  await assert.rejects(callTaskCrud(ctx, f.auth, "task_lease", { proposal_id: prepared.proposal.id }), { code: "approval_stale" });
});
