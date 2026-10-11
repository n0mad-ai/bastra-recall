import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mintTaskCredential } from "../src/task-auth.js";
import { callTaskCrud } from "../src/task-service.js";
import { transactTaskStore, readTaskStore, decodeTaskStore } from "../src/task-store.js";
import { newOwnerKey, unlockOwnerKey, signTaskApproval, verifyTaskApproval, bytesHash, readApprovalRegistry, type ApprovalRegistry } from "../src/task-approval-keys.js";
import { approvalBinding } from "../src/task-actions.js";
async function fixture(domains = ["personal"], protectedBoundary = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "task-actions-"))), targetPath = join(root, "artifact.txt"); await writeFile(targetPath, "old\n");
  const envelopes = domains.map(() => newOwnerKey("synthetic owner key password"));
  const registry: ApprovalRegistry = { schema_version: 1, revision: 1, protected_boundary: protectedBoundary,
    keys: domains.map((domain, i) => ({ id: `key-${i}`, domain, public_key: envelopes[i].public_key, fingerprint: bytesHash(envelopes[i].public_key) })),
    targets: [{ id: "artifact", root, path: "artifact.txt", owner_domains: domains, sensitivity: "private", adapter: "local-artifact-v1" }] };
  const ctx = { path: join(root, "tasks.json"), authPath: join(root, "auth.json"), now: () => 1000, approvalRegistry: Promise.resolve(registry), actionClock: () => ({ boot_id: "fixture-boot", monotonic: 1000 }) };
  const agent = await mintTaskCredential(ctx.authPath, { actor_id: "agent", role: "agent", domains });
  const owners = await Promise.all(domains.map(domain => mintTaskCredential(ctx.authPath, { actor_id: `owner-${domain}`, role: "owner", domains: [domain] })));
  const fullOwner = await mintTaskCredential(ctx.authPath, { actor_id: "owner-full", role: "owner", domains });
  const auth = `Bearer ${agent.token}`;
  await callTaskCrud(ctx, `Bearer ${fullOwner.token}`, "task_create", { idempotency_key: "prepare", original_request: "Prepare a local artifact", goal: "Prepare", resolution_condition: "Owner outcome", timezone: "Europe/Madrid", scope: { kind: "personal", name: "fixture" }, owner_domains: domains, arm: true, action_level: protectedBoundary ? "execute" : "prepare", schedule: { kind: "instant", at: 2000 } });
  const task = (await readTaskStore(ctx.path)).tasks[0];
  const prepared = await callTaskCrud(ctx, auth, "task_prepare", { id: task.id, expected_revision: `initial:${task.revision}`, target_id: "artifact", payload: "new\n" }) as any;
  const approve = async (index: number, decision: "approve" | "deny" = "approve") => {
    const ownerAuth = `Bearer ${owners[index].token}`;
    const challenge = await callTaskCrud(ctx, ownerAuth, "task_challenge", { proposal_id: prepared.proposal.id, domain: domains[index] }) as any;
    const key = unlockOwnerKey(envelopes[index], "synthetic owner key password");
    const proof = { challenge_id: challenge.challenge.id, decision, signature: signTaskApproval(key, approvalBinding(challenge.proposal, challenge.challenge, decision)) };
    return { result: await callTaskCrud(ctx, ownerAuth, "task_approval", proof) as any, proof, ownerAuth, challenge };
  };
  return { root, ctx, registry, targetPath, prepared, auth, approve, envelopes, owners };
}
test("v1 migrates only empty actions and keeps tasks/cursors; capabilities never silently migrate", async () => {
  const f = await fixture(); const store = await readTaskStore(f.ctx.path);
  const raw = { ...store, schema_version: 1, proposals: [] };
  assert.equal(decodeTaskStore(JSON.stringify(raw)).schema_version, 2);
  assert.deepEqual(decodeTaskStore(JSON.stringify(raw)).events, store.events);
  assert.deepEqual(decodeTaskStore(JSON.stringify(raw)).tasks, store.tasks);
  assert.throws(() => decodeTaskStore(JSON.stringify({ ...raw, approvals: [{ approved: true }] })), /empty/);
});
test("encrypted owner envelope signs exact bindings; wrong passphrase and changed binding fail", () => {
  const envelope = newOwnerKey("synthetic password 123"); const key = unlockOwnerKey(envelope, "synthetic password 123");
  const binding = ["test", "collision:a", "b"]; const signature = signTaskApproval(key, binding);
  assert.ok(verifyTaskApproval(envelope.public_key, binding, signature)); assert.ok(!verifyTaskApproval(envelope.public_key, ["test", "collision", "a:b"], signature));
  assert.throws(() => unlockOwnerKey(envelope, "wrong password")); assert.ok(!JSON.stringify(envelope).includes("PRIVATE KEY"));
});
test("prepare is an exact draft only, identical retry is one proposal, no target write", async () => {
  const f = await fixture(); const p = f.prepared.proposal;
  assert.equal(p.payload_hash, bytesHash("new\n")); assert.equal(p.actor, "agent"); assert.equal(f.prepared.executes, false);
  await callTaskCrud(f.ctx, f.auth, "task_prepare", { id: p.task_id, expected_revision: "initial:0", target_id: "artifact", payload: "new\n" });
  assert.equal((await readTaskStore(f.ctx.path)).proposals.length, 1); assert.equal(await readFile(f.targetPath, "utf8"), "old\n");
  await assert.rejects(callTaskCrud(f.ctx, f.auth, "task_approval", { challenge_id: "fake", decision: "approve", signature: "approved" }), /owner/);
});
test("every owner domain signs the exact same proposal; no quorum or fabricated boolean", async () => {
  const f = await fixture(["personal", "team"]); await transactTaskStore(f.ctx.path, undefined, s => { s.controls.execution_stopped = false; });
  const a = await f.approve(0); assert.equal(a.result.approved, false); assert.deepEqual(a.result.missing_domains, ["team"]);
  await assert.rejects(callTaskCrud(f.ctx, f.auth, "task_lease", { proposal_id: f.prepared.proposal.id }), /All exact/);
  const b = await f.approve(1); assert.equal(b.result.approved, true);
  await assert.rejects(callTaskCrud(f.ctx, a.ownerAuth, "task_approval", a.proof), /consumed/);
  const lease = await callTaskCrud(f.ctx, f.auth, "task_lease", { proposal_id: f.prepared.proposal.id }) as any;
  assert.equal(lease.lease.fence, 1); assert.equal((await readTaskStore(f.ctx.path)).leases[0].holder_token_hash, bytesHash(lease.holder_token));
  await assert.rejects(callTaskCrud(f.ctx, f.auth, "task_release", { lease_id: lease.lease.id, holder_token: "a".repeat(43), fence: 1 }), /holder/);
  await callTaskCrud(f.ctx, f.auth, "task_release", { lease_id: lease.lease.id, holder_token: lease.holder_token, fence: 1 });
  await callTaskCrud(f.ctx, b.ownerAuth, "task_revoke_approval", { approval_id: b.result.approval_id });
  await assert.rejects(callTaskCrud(f.ctx, f.auth, "task_lease", { proposal_id: f.prepared.proposal.id }), /All exact/);
});
test("denial, expiry, reboot, protected-boundary absence and target drift block admission", async () => {
  const denied = await fixture(); await denied.approve(0, "deny"); await assert.rejects(callTaskCrud(denied.ctx, denied.auth, "task_proposal", { proposal_id: denied.prepared.proposal.id }), /binding changed/);
  const unprotected = await fixture(["personal"], false); assert.equal((await unprotected.approve(0)).result.approved, false);
  const expired = await fixture(); const signed = await expired.approve(0); expired.ctx.now = () => 0; expired.ctx.actionClock = () => ({ boot_id: "fixture-boot", monotonic: 400000 });
  assert.equal((await callTaskCrud(expired.ctx, signed.ownerAuth, "task_proposal", { proposal_id: expired.prepared.proposal.id }) as any).approved, false);
  expired.ctx.actionClock = () => ({ boot_id: "new-boot", monotonic: 1 }); assert.equal((await callTaskCrud(expired.ctx, signed.ownerAuth, "task_proposal", { proposal_id: expired.prepared.proposal.id }) as any).approved, false);
  const changed = await fixture(); await writeFile(changed.targetPath, "external\n"); await assert.rejects(changed.approve(0), /Target changed/);
});
test("forged signatures and edited/recovered proposals cannot acquire authority", async () => {
  const f = await fixture(); const ownerAuth = `Bearer ${f.owners[0].token}`;
  const challenge = await callTaskCrud(f.ctx, ownerAuth, "task_challenge", { proposal_id: f.prepared.proposal.id, domain: "personal" }) as any;
  const other = unlockOwnerKey(newOwnerKey("different synthetic password"), "different synthetic password");
  await assert.rejects(callTaskCrud(f.ctx, ownerAuth, "task_approval", { challenge_id: challenge.challenge.id, decision: "approve", signature: signTaskApproval(other, approvalBinding(challenge.proposal, challenge.challenge, "approve")) }), /signature/);
  const task = (await readTaskStore(f.ctx.path)).tasks[0]; await callTaskCrud(f.ctx, ownerAuth, "task_edit", { id: task.id, expected_revision: "initial:0", patch: { goal: "Changed" } });
  await assert.rejects(callTaskCrud(f.ctx, ownerAuth, "task_approval", { challenge_id: challenge.challenge.id, decision: "approve", signature: "fake" }), /inactive/);
});
test("target root/symlink escapes fail closed and registry files require private permissions", async () => {
  const f = await fixture(); await symlink(f.targetPath, join(f.root, "link.txt")); f.registry.targets[0].path = "link.txt";
  const task = (await readTaskStore(f.ctx.path)).tasks[0]; await assert.rejects(callTaskCrud(f.ctx, f.auth, "task_prepare", { id: task.id, expected_revision: "initial:0", target_id: "artifact", payload: "new" }), /boundary/);
  const config = join(f.root, "keys.json"); await writeFile(config, JSON.stringify(f.registry), { mode: 0o644 }); await assert.rejects(readApprovalRegistry(config), /unavailable/);
});
test("two compiled processes contend for one local lease; expiration advances fencing", async () => {
  const f = await fixture(); await f.approve(0); await transactTaskStore(f.ctx.path, undefined, s => { s.controls.execution_stopped = false; });
  const script = `import {callTaskCrud} from ${JSON.stringify(new URL("../dist/task-service.js", import.meta.url).href)}; const ctx = JSON.parse(process.env.FIXTURE_CTX); ctx.approvalRegistry = Promise.resolve(JSON.parse(process.env.FIXTURE_REG)); ctx.now=()=>1000;ctx.actionClock=()=>({boot_id:'fixture-boot',monotonic:1000});try { await callTaskCrud(ctx,process.env.FIXTURE_AUTH,'task_lease',{proposal_id:process.env.FIXTURE_PROPOSAL});console.log('granted');}catch{console.log('blocked');}`;
  const run = async () => { const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, FIXTURE_CTX: JSON.stringify({path:f.ctx.path,authPath:f.ctx.authPath}), FIXTURE_REG: JSON.stringify(f.registry), FIXTURE_AUTH: f.auth, FIXTURE_PROPOSAL: f.prepared.proposal.id }, stdio: ["ignore", "pipe", "pipe"] }); let output=""; child.stdout.on("data", c=>{output+=c;}); await once(child,"exit");return output.trim(); };
  assert.deepEqual((await Promise.all([run(), run()])).sort(), ["blocked", "granted"]);
  f.ctx.actionClock = () => ({ boot_id: "fixture-boot", monotonic: 32000 });
  const next = await callTaskCrud(f.ctx, f.auth, "task_lease", { proposal_id: f.prepared.proposal.id }) as any; assert.equal(next.lease.fence, 2);
});
