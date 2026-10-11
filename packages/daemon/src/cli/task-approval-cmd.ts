import { taskIdentitySchema } from "../task-schema.js";
/** Owner CLI channel. Unlock never accepts argv/env/stdin passphrases. */
import { open, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { newOwnerKey, unlockOwnerKey, privateJson, readApprovalRegistry, approvalRegistryPath, approvalRegistrySchema, bytesHash, signTaskApproval, actionHash } from "../task-approval-keys.js";
import { approvalBinding } from "../task-actions.js";
import { withPathLock } from "../path-lock.js";
import { atomicWrite } from "../task-store.js";
import { taskPrivatePrompt } from "./task-private-prompt.js";
import { confirm } from "./prompt.js";
import { taskCliCall } from "./tasks-cmd.js";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
export async function taskOwnerKeys(words: string[]) {
  const [op, domain, destination] = words;
  if (op !== "enroll" || !domain || !destination || !await confirm("Enroll owner-held approval key; private file must be outside agent access. Continue?"))
    throw Object.assign(new Error("Use tasks keys enroll domain new-private-file from an owner terminal"), { code: "validation" });
  taskIdentitySchema.parse(domain);
  const passphrase = await taskPrivatePrompt("New owner-key passphrase (hidden, 12+ chars): ", true);
  if (passphrase !== await taskPrivatePrompt("Repeat passphrase: ", true)) throw Object.assign(new Error("Passphrases differ"), { code: "validation" });
  const envelope = newOwnerKey(passphrase), path = approvalRegistryPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(destination, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(envelope)); await file.sync(); } finally { await file.close(); }
  await withPathLock(path, async ownership => {
    const registry = await readApprovalRegistry(path) ?? { schema_version: 1 as const, revision: 0, protected_boundary: false, keys: [], targets: [] };
    registry.keys = registry.keys.filter(k => k.domain !== domain); registry.keys.push({ id: randomUUID(), domain, public_key: envelope.public_key, fingerprint: bytesHash(envelope.public_key) }); registry.revision++;
    await atomicWrite(path, JSON.stringify(approvalRegistrySchema.parse(registry)), ownership);
  }, { strictLocal: true });
  process.stdout.write("Owner key enrolled. Restart the isolated task daemon to pin the new registry; older approvals become stale. Execution remains stopped until a protected boundary is configured.\n");
}
export async function taskOwnerSign(words: string[], decision: "approve" | "deny", authorization: string) {
  const [proposalId, domain, privateFile] = words;
  if (!proposalId || !domain || !privateFile) throw Object.assign(new Error("Use tasks approve|deny proposal-id domain private-key-file"), { code: "validation" });
  const base = resolveDaemonEndpoint().baseUrl;
  const response = await taskCliCall("challenge", { proposal_id: proposalId, domain }, authorization, base) as any;
  const { proposal, challenge, preview } = response;
  if (proposal.id !== proposalId || challenge.domain !== domain || bytesHash(preview.after) !== proposal.payload_hash || bytesHash(preview.before) !== proposal.target_hash || actionHash(proposal) !== challenge.binding_hash
    || preview.after !== proposal.payload || challenge.expires_at <= Date.now()) throw Object.assign(new Error("Unsafe exact-action preview; refusing signature"), { code: "conflict" });
  // JSON quoting shows control characters and markup as data, without terminal effects.
  process.stdout.write(JSON.stringify({ decision, target: proposal.target_id, operation: proposal.operation, actor: proposal.actor,
    required_domains: proposal.required_domains, scope: proposal.scope, sensitivity: proposal.sensitivity, expires_at: new Date(challenge.expires_at).toISOString(),
    before: preview.before, after: preview.after, payload_hash: proposal.payload_hash }, null, 2) + "\n");
  if (!await confirm(`Sign ${decision} for these exact bytes and this binding?`)) throw Object.assign(new Error("Owner declined signing"), { code: "forbidden" });
  const key = unlockOwnerKey(await privateJson(privateFile), await taskPrivatePrompt("Owner key passphrase (hidden): ", true));
  const signature = signTaskApproval(key, approvalBinding(proposal, challenge, decision));
  const result = await taskCliCall("approval", { challenge_id: challenge.id, decision, signature }, authorization, base);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
