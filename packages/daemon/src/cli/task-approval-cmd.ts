import { authenticateTask, requireTaskOwner, requireTaskDomains } from "../task-auth.js";
import { taskIdentitySchema } from "../task-schema.js";
/** Owner CLI channel. Unlock never accepts argv/env/stdin passphrases. */
import { open, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { newOwnerKey, unlockOwnerKey, privateJson, readApprovalRegistry, approvalRegistryPath, approvalRegistrySchema, bytesHash, signTaskApproval, actionHash, registryHash } from "../task-approval-keys.js";
import { approvalBinding } from "../task-actions.js";
import { withPathLock } from "../path-lock.js";
import { atomicWrite, tasksPath, transactTaskStore } from "../task-store.js";
import { taskPrivatePrompt } from "./task-private-prompt.js";
import { confirm } from "./prompt.js";
import { taskCliCall } from "./tasks-cmd.js";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
export async function taskOwnerKeys(words: string[]) {
  const [op, domain, destination, oldPrivateFile] = words;
  if (!["enroll", "rotate"].includes(op) || !domain || !destination || !await confirm("Enroll owner-held approval key; private file must be outside agent access. Continue?"))
    throw Object.assign(new Error("Use tasks keys enroll domain new-private-file from an owner terminal"), { code: "validation" });
  taskIdentitySchema.parse(domain);
  const owner = await authenticateTask(`Bearer ${await taskPrivatePrompt("Owner task token (hidden): ")}`); requireTaskOwner(owner); requireTaskDomains(owner, [domain]);
  const currentRegistry = await readApprovalRegistry(); const previous = currentRegistry?.keys.find(k => k.domain === domain);
  if (previous && op === "enroll") throw Object.assign(new Error("Domain key already enrolled; use rotate with old private key"), { code: "conflict" });
  if (op === "rotate") {
    if (!previous || !oldPrivateFile) throw Object.assign(new Error("Rotate needs enrolled domain and old private-key file"), { code: "validation" });
    const oldEnvelope = await privateJson(oldPrivateFile);
    try { unlockOwnerKey(oldEnvelope, await taskPrivatePrompt("Old key passphrase (hidden): ", true)); } catch { throw Object.assign(new Error("Owner key unlock failed"), { code: "key_unlock_failed" }); }
    if (oldEnvelope.public_key !== previous.public_key) throw Object.assign(new Error("Old domain key mismatch"), { code: "forbidden" });
  }
  const passphrase = await taskPrivatePrompt("New owner-key passphrase (hidden, 12+ chars): ", true);
  if (passphrase !== await taskPrivatePrompt("Repeat passphrase: ", true)) throw Object.assign(new Error("Passphrases differ"), { code: "validation" });
  const envelope = newOwnerKey(passphrase), path = approvalRegistryPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await transactTaskStore(tasksPath(), undefined, store => { store.controls.execution_stopped = true; }, "control");
  const file = await open(destination, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(envelope)); await file.sync(); } finally { await file.close(); }
  await withPathLock(path, async ownership => {
    const registry = await readApprovalRegistry(path) ?? { schema_version: 1 as const, revision: 0, protected_boundary: false, keys: [], targets: [] };
    const actual = registry.keys.find(k => k.domain === domain);
    if (actual?.fingerprint !== previous?.fingerprint) throw Object.assign(new Error("Domain key changed concurrently"), { code: "conflict" });
    registry.protected_boundary = false;
    registry.keys = registry.keys.filter(k => k.domain !== domain); registry.keys.push({ id: randomUUID(), domain, public_key: envelope.public_key, fingerprint: bytesHash(envelope.public_key) }); registry.revision++;
    await atomicWrite(path, JSON.stringify(approvalRegistrySchema.parse(registry)), ownership);
  }, { strictLocal: true });
  process.stdout.write("Owner key enrolled/rotated; protected_boundary reset to false and execution stopped. Restart the isolated task daemon to pin the new registry; older approvals become stale. Execution remains stopped until a protected boundary is configured.\n");
}
export async function taskOwnerSign(words: string[], decision: "approve" | "deny", authorization: string) {
  const [proposalId, domain, privateFile] = words;
  if (!proposalId || !domain || !privateFile) throw Object.assign(new Error("Use tasks approve|deny proposal-id domain private-key-file"), { code: "validation" });
  const base = resolveDaemonEndpoint().baseUrl;
  const response = await taskCliCall("challenge", { proposal_id: proposalId, domain }, authorization, base) as any;
  const { proposal, challenge, preview } = response;
  if (proposal.id !== proposalId || challenge.domain !== domain || bytesHash(preview.after) !== proposal.payload_hash || bytesHash(preview.before) !== proposal.target_hash || actionHash(proposal) !== challenge.binding_hash
    || preview.after !== proposal.payload || challenge.expires_at <= Date.now()) throw Object.assign(new Error("Unsafe exact-action preview; refusing signature"), { code: "conflict" });
  const registry = await readApprovalRegistry(); const envelope = await privateJson(privateFile);
  const target = registry?.targets.find(t => t.id === proposal.target_id), domainKey = registry?.keys.find(k => k.domain === domain);
  if (!registry || registryHash(registry) !== proposal.registry_hash || !target || envelope.public_key !== domainKey?.public_key)
    throw Object.assign(new Error("Local target/registry/domain-key binding differs"), { code: "approval_stale" });
  const binding = approvalBinding(proposal, challenge, decision);
  // Complete signed object plus locally pinned concrete target path; JSON quoted.
  process.stdout.write(JSON.stringify({ binding, task: { id: proposal.task_id, goal: response.task_goal, revision: proposal.task_revision, generation: proposal.generation },
    target_path: resolve(target.root, target.path), registry_revision: registry.revision, preview }, null, 2) + "\n");
  if (!await confirm(`Sign ${decision} for these exact bytes and this binding?`)) throw Object.assign(new Error("Owner declined signing"), { code: "forbidden" });
  let key;
  try { key = unlockOwnerKey(envelope, await taskPrivatePrompt("Owner key passphrase (hidden): ", true)); }
  catch { throw Object.assign(new Error("Owner key unlock failed"), { code: "key_unlock_failed" }); }
  const signature = signTaskApproval(key, approvalBinding(proposal, challenge, decision));
  const result = await taskCliCall("approval", { challenge_id: challenge.id, decision, signature }, authorization, base);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
