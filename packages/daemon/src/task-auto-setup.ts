import { tasksEnabled } from "./tasks-enabled.js";
/** Local single-user upgrade: shared private Agent credential, no client-config rewrite. */
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { authenticateTask, mintTaskCredential, taskAuthPath, localTaskDomains } from "./task-auth.js";
import { taskHookConfigPath, taskClientToken } from "./task-client-auth.js";
import { atomicWrite, tasksPath } from "./task-store.js";
import { withPathLock } from "./path-lock.js";
async function ensureLocalTaskAgentInner(): Promise<{ configured: boolean; reason: string }> {
  if (!tasksEnabled() || process.env.BASTRA_CONVERSATIONAL_REMINDERS === "0") return { configured: false, reason: "disabled" };
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
    const credential = await mintTaskCredential(taskAuthPath(), { actor_id: `local-agent.${randomUUID()}`, role: "agent", domains }, undefined, true);
    await atomicWrite(path, JSON.stringify({ schema_version: 1, token: credential.token, credential_id: credential.credential_id }), ownership);
    return { configured: true, reason: "automatic-local-agent" };
  }, { strictLocal: true });
}

/** Explicit diagnostics: no repair/reissue and no raw token/path in the result. */
export async function taskAgentAccessStatus(path = tasksPath(), authPath = taskAuthPath()) {
  if (!tasksEnabled() || process.env.BASTRA_CONVERSATIONAL_REMINDERS === "0") return { configured: false, authorized: false, reason: "disabled", hint: "Gesprächserinnerungen sind ausgeschaltet." };
  const config = join(dirname(path), "task-hook-token.json"), token = taskClientToken(config);
  if (!token) {
    let present = false; try { await lstat(config); present = true; } catch {}
    return { configured: present, authorized: false, reason: present ? "unsafe-or-corrupt" : "missing", hint: present ? "Erinnerungszugang beschädigt oder zu offen; Karten bleiben stumm. Owner: bastra tasks setup-hooks." : "Erinnerungszugang fehlt. Daemon starten; falls weiterhin fehlend: bastra tasks setup-hooks." };
  }
  try { const p = await authenticateTask(`Bearer ${token}`, authPath); return { configured: true, authorized: p.role === "agent", reason: p.role === "agent" ? "ready" : "owner-not-for-agents", hint: p.role === "agent" ? "Bei nächstem Kontakt, solange der Daemon läuft." : "Owner-Zugang nicht für automatische Agent-Karten verwenden." }; }
  catch { return { configured: true, authorized: false, reason: "revoked-or-invalid", hint: "Erinnerungszugang widerrufen/ungültig; Karten bleiben stumm. Owner: bastra tasks setup-hooks." }; }
}

let startupAccess: { path: string; configured: boolean; reason: string } | undefined;
export async function ensureLocalTaskAgent() {
  const result = await ensureLocalTaskAgentInner(); startupAccess = { path: tasksPath(), ...result }; return result;
}
export function cachedTaskAccessWarning(path: string): string | undefined {
  return startupAccess?.path === path && !startupAccess.configured && ["existing-config-unsafe", "existing-credential-revoked-or-invalid"].includes(startupAccess.reason)
    ? "Erinnerungszugang beschädigt, zu offen oder widerrufen; Karten bleiben stumm. Owner: bastra tasks setup-hooks."
    : undefined;
}
