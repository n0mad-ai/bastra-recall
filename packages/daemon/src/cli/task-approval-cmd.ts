import { authenticateTask, requireTaskOwner, requireTaskDomains } from "../task-auth.js";
import { taskIdentitySchema } from "../task-schema.js";
/** Owner CLI channel. Unlock never accepts argv/env/stdin passphrases. */
import { open, mkdir, realpath } from "node:fs/promises";
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
function readableBinding(value:unknown,prefix=""):string {
 const names:Record<string,string>={proposal_hash:"Vorschlags-Hash",task_id:"Aufgabe",task_revision:"Aufgabenrevision",generation:"Generation",recovery_epoch:"Wiederherstellungskennung",actor:"Ausführender Akteur",target_id:"Zielkennung",target_hash:"Vorzustand-Hash",payload_hash:"Inhalt-Hash",source_revisions:"Quellrevisionen",required_domains:"Pflichtdomänen",domain:"Signierende Domäne",nonce:"Einmal-Kennung",expires_at:"Ablauf",decision:"Zustimmung/Ablehnung",binding_hash:"Bindungs-Hash",kind:"Typ",proposal:"Vorschlag",challenge:"Signierabfrage",scope:"Bereich",sensitivity:"Vertraulichkeit",id:"Kennung",revision:"Revision",created_at:"Angelegt",boot_id:"Startkennung",monotonic_deadline:"Monotone Ablaufgrenze",key_id:"Schlüsselkennung",registry_hash:"Registry-Hash",task_binding:"Aufgabenbindung",status:"Zustand",payload:"Exakte Zielbytes",action:"Aktion",local_time:"Ortszeit",timezone:"Zeitzone",owner_domains:"Eigentümerdomänen",at:"Zeitpunkt",schedule:"Auslöser"};
 if(Array.isArray(value))return value.map((v,i)=>readableBinding(v,`${prefix}[${i+1}] `)).join("\n");
 if(value&&typeof value==="object")return Object.entries(value).map(([k,v])=>readableBinding(v,`${prefix}${names[k]??k.replaceAll("_"," ")}: `)).join("\n");
 return `${prefix}${JSON.stringify(value)}`;
}
export async function taskOwnerKeys(words: string[]) {
  const [op, domain, destination, oldPrivateFile] = words;
  if (!["enroll", "rotate"].includes(op) || !domain || !destination || !await confirm("Owner-Schlüssel einschreiben? Private Datei muss außerhalb des Agent-Zugriffs liegen."))
    throw Object.assign(new Error("Use tasks keys enroll domain new-private-file from an owner terminal"), { code: "validation" });
  taskIdentitySchema.parse(domain);
  const owner = await authenticateTask(`Bearer ${await taskPrivatePrompt("Owner-Aufgaben-Token (verborgen): ")}`); requireTaskOwner(owner); requireTaskDomains(owner, [domain]);
  const currentRegistry = await readApprovalRegistry(); const previous = currentRegistry?.keys.find(k => k.domain === domain);
  if (previous && op === "enroll") throw Object.assign(new Error("Domain key already enrolled; use rotate with old private key"), { code: "conflict" });
  if (op === "rotate") {
    if (!previous || !oldPrivateFile) throw Object.assign(new Error("Rotate needs enrolled domain and old private-key file"), { code: "validation" });
    const oldEnvelope = await privateJson(oldPrivateFile);
    try { unlockOwnerKey(oldEnvelope, await taskPrivatePrompt("Alte Schlüssel-Passphrase (verborgen): ", true)); } catch { throw Object.assign(new Error("Owner key unlock failed"), { code: "key_unlock_failed" }); }
    if (oldEnvelope.public_key !== previous.public_key) throw Object.assign(new Error("Old domain key mismatch"), { code: "forbidden" });
  }
  const passphrase = await taskPrivatePrompt("Neue Owner-Passphrase (verborgen, mindestens 12 Zeichen): ", true);
  if (passphrase !== await taskPrivatePrompt("Passphrase wiederholen: ", true)) throw Object.assign(new Error("Passphrases differ"), { code: "validation" });
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
    registry.key_storage_roots=[...new Set([...(registry.key_storage_roots??[]),await realpath(dirname(resolve(destination)))])];
    registry.keys = registry.keys.filter(k => k.domain !== domain); registry.keys.push({ id: randomUUID(), domain, public_key: envelope.public_key, fingerprint: bytesHash(envelope.public_key) }); registry.revision++;
    await atomicWrite(path, JSON.stringify(approvalRegistrySchema.parse(registry)), ownership);
  }, { strictLocal: true });
  process.stdout.write("Owner-Schlüssel gespeichert; Grenzerklärung zurückgesetzt, Ausführung gestoppt. Task-Prozesse neu starten. Alte Freigaben werden veraltet; neue Grenzerklärung und execution-enable erforderlich.\n");
}
export async function taskOwnerSign(words: string[], decision: "approve" | "deny", authorization: string, json=false) {
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
  process.stdout.write(`Aufgabe: ${JSON.stringify(response.task_goal??proposal.task_id)} (${proposal.task_id})\nRevision ${proposal.task_revision}, Generation ${proposal.generation}\nZiel: ${JSON.stringify(resolve(target.root,target.path))}\nAlle Pflichtdomänen: ${proposal.required_domains.join(", ")}\nDiese Signatur: ${domain} · ${decision==="approve"?"zustimmen":"ablehnen"}\nInhalt-Hash: ${proposal.payload_hash}\nQuellrevisionen: ${JSON.stringify(proposal.source_revisions)}\nAblauf: ${new Date(challenge.expires_at).toISOString()}\nVorher:\n${JSON.stringify(preview.before)}\nNachher (exakte Bytes):\n${JSON.stringify(preview.after)}\nGanze Bindung (zur Kontrolle):\n${json?JSON.stringify(binding,null,2):readableBinding(binding)}\n`);
  if (!await confirm(`Diese ganze Bindung und diese exakten Bytes ${decision==="approve"?"freigeben":"ablehnen"} und separat signieren?`)) throw Object.assign(new Error("Owner declined signing"), { code: "forbidden",reason:"owner_declined" });
  let key;
  try { key = unlockOwnerKey(envelope, await taskPrivatePrompt("Owner-Passphrase (verborgen): ", true)); }
  catch { throw Object.assign(new Error("Owner key unlock failed"), { code: "key_unlock_failed" }); }
  const signature = signTaskApproval(key, approvalBinding(proposal, challenge, decision));
  const result = await taskCliCall("approval", { challenge_id: challenge.id, decision, signature }, authorization, base);
  if(json){process.stdout.write(JSON.stringify(result,null,2)+"\n");return;}
  const status=result as any;process.stdout.write(`${decision==="approve"?"Signatur gespeichert":"Ablehnung gespeichert"}. ${status.approved?"Alle Pflichtdomänen vollständig freigegeben.":`Noch nicht ausführbar; fehlende Domänen: ${status.missing_domains?.join(", ")||"Status prüfen"}` } Noch kein Write, keine Aufgabe erledigt.\n`);
}
