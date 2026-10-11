/** Local single-user upgrade: shared private Agent credential, no client-config rewrite. */
import { lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { authenticateTask, mintTaskCredential, taskAuthPath, localTaskDomains } from "./task-auth.js";
import { taskHookConfigPath, taskClientToken } from "./task-client-auth.js";
import { atomicWrite } from "./task-store.js";
import { withPathLock } from "./path-lock.js";
export async function ensureLocalTaskAgent(): Promise<{ configured: boolean; reason: string }> {
  if (process.env.BASTRA_CONVERSATIONAL_REMINDERS === "0") return { configured: false, reason: "disabled" };
  if (process.env.BASTRA_TASK_TOKEN !== undefined) return { configured: !!taskClientToken(), reason: "explicit-override" };
  const path = taskHookConfigPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withPathLock(path, async ownership => {
    try {
      await lstat(path);
      const token = taskClientToken();
      if (!token) return { configured: false, reason: "existing-config-unsafe" };
      try { const principal = await authenticateTask(`Bearer ${token}`); return { configured: principal.role === "agent", reason: principal.role === "agent" ? "existing-agent" : "existing-owner-not-for-agents" }; }
      catch { return { configured: false, reason: "existing-credential-revoked-or-invalid" }; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const domains = await localTaskDomains();
    if (!domains) return { configured: false, reason: "multiple-owner-identities-use-explicit-setup" };
    const credential = await mintTaskCredential(taskAuthPath(), { actor_id: `local-agent.${randomUUID()}`, role: "agent", domains });
    await atomicWrite(path, JSON.stringify({ schema_version: 1, token: credential.token, credential_id: credential.credential_id }), ownership);
    return { configured: true, reason: "automatic-local-agent" };
  }, { strictLocal: true });
}
