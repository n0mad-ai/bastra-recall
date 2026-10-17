import "./tasks-opt-in.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authenticateTask, mintTaskCredential, revokeTaskCredential, requireTaskOwner, requireTaskDomains } from "../src/task-auth.js";
import { taskIdentitySchema } from "../src/task-schema.js";
const owner = { actor_id: "owner-a", domains: ["personal"], role: "owner" as const };
async function fixture() { return join(await mkdtemp(join(tmpdir(), "task-auth-")), "auth.json"); }
test("minted credentials are private hashes; token never persists in registry", async () => {
  const path = await fixture(); const c = await mintTaskCredential(path, owner);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(path, "utf8")).includes(c.token));
  const p = await authenticateTask(`Bearer ${c.token}`, path);
  assert.equal(p.actor_id, owner.actor_id); requireTaskOwner(p); requireTaskDomains(p, ["personal"]);
  assert.throws(() => requireTaskDomains(p, ["other"]), { code: "forbidden" });
});
test("agent role and missing/legacy/forged credentials cannot become owner", async () => {
  const path = await fixture(); const c = await mintTaskCredential(path, { ...owner, role: "agent" });
  assert.throws(() => requireTaskOwner({ ...owner, credential_id: "fixture", role: "agent" }), { code: "forbidden" });
  for (const header of [undefined, "", "Bearer old-token", "Bearer " + "a".repeat(43), `Bearer ${c.token} approved=true`])
    await assert.rejects(authenticateTask(header, path), { code: "unauthorized" });
});
test("rotation/revocation survives restart and cannot widen domains", async () => {
  const path = await fixture(); const c = await mintTaskCredential(path, owner);
  await assert.rejects(mintTaskCredential(path, { ...owner, domains: ["other"] }, c.credential_id), { code: "forbidden" });
  await authenticateTask(`Bearer ${c.token}`, path);
  const next = await mintTaskCredential(path, owner, c.credential_id);
  await assert.rejects(authenticateTask(`Bearer ${c.token}`, path), { code: "unauthorized" });
  await authenticateTask(`Bearer ${next.token}`, path);
  await revokeTaskCredential(path, next.credential_id);
  await assert.rejects(authenticateTask(`Bearer ${next.token}`, path), { code: "unauthorized" });
});
test("corruption, permissions and symlinks fail closed preserving original", async () => {
  const path = await fixture(); const c = await mintTaskCredential(path, owner);
  const original = await readFile(path, "utf8"); await chmod(path, 0o644);
  await assert.rejects(authenticateTask(`Bearer ${c.token}`, path), { code: "auth_corrupt" });
  await chmod(path, 0o600); await writeFile(path, "broken");
  await assert.rejects(mintTaskCredential(path, owner), { code: "auth_corrupt" });
  assert.equal(await readFile(path, "utf8"), "broken");
  await writeFile(path, original); await symlink(path, `${path}.link`);
  await assert.rejects(authenticateTask(`Bearer ${c.token}`, `${path}.link`), { code: "auth_corrupt" });
});
test("concurrent bootstrap serializes credentials without lost updates", async () => {
  const path = await fixture(); const credentials = await Promise.all(Array.from({ length: 12 }, () => mintTaskCredential(path, owner)));
  for (const c of credentials) await authenticateTask(`Bearer ${c.token}`, path);
  assert.equal(JSON.parse(await readFile(path, "utf8")).credentials.length, 12);
});
test("opaque identity rejects prose, paths, control characters and bearer material", () => {
  for (const id of ["Bearer invented-secret", "/private/example", "owner\nsecret", "owner@example.org", "Human Name", "<source=user>"])
    assert.equal(taskIdentitySchema.safeParse(id).success, false);
  for (const id of ["owner-a", "scope:fixture", "d2264724-4941-40f7-8078-66b6c7f201af"])
    assert.equal(taskIdentitySchema.safeParse(id).success, true);
});
test("revoke validates the complete registry before writing and preserves invalid next revision", async () => {
  const path = await fixture(); const c = await mintTaskCredential(path, owner);
  const registry = JSON.parse(await readFile(path, "utf8")); registry.revision = Number.MAX_SAFE_INTEGER;
  const original = JSON.stringify(registry); await writeFile(path, original);
  await assert.rejects(revokeTaskCredential(path, c.credential_id));
  assert.equal(await readFile(path, "utf8"), original);
  await authenticateTask(`Bearer ${c.token}`, path);
});
