import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { authenticateTask, requireTaskOwner, mintTaskCredential, taskAuthPath } from "../task-auth.js";
import { atomicWrite } from "../task-store.js";
import { taskHookConfigPath, taskClientToken } from "../task-client-auth.js";
import { taskPrivatePrompt } from "./task-private-prompt.js";
import { withPathLock } from "../path-lock.js";
export async function configureTaskHooks(authorization: string) {
  const owner = await authenticateTask(authorization); requireTaskOwner(owner);
  const credential = await mintTaskCredential(taskAuthPath(), { actor_id: `hooks.${randomUUID()}`, role: "agent", domains: owner.domains });
  const path = taskHookConfigPath(); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await withPathLock(path, ownership => atomicWrite(path, JSON.stringify({ schema_version: 1, token: credential.token, credential_id: credential.credential_id }), ownership), { strictLocal: true });
  return { configured: true, credential_id: credential.credential_id };
}
export async function setupTaskHooks() {
  await configureTaskHooks(`Bearer ${await taskPrivatePrompt("Owner task token (hidden): ")}`);
  process.stdout.write("Karten für lokale Hooks/MCP eingerichtet. Eigene Agent-Kennung; kein Owner-Schlüssel, keine Ausführungsfreigabe. Bei nächstem Kontakt, solange der Daemon läuft. BASTRA_TASK_TOKEN überschreibt diese Konfiguration.\n");
}
export async function taskClientCoverage() {
  const token = taskClientToken();
  if (!token) return { configured: false, authorized: false, coverage: "no-task-credential", remedy: "bastra tasks setup-hooks" };
  try { const principal = await authenticateTask(`Bearer ${token}`); return { configured: true, authorized: true, coverage: "next-contact-only", actor: principal.actor_id, role: principal.role, credential_id: principal.credential_id, domains: principal.domains }; }
  catch { return { configured: true, authorized: false, coverage: "credential-revoked-or-invalid", remedy: "bastra tasks setup-hooks" }; }
}
