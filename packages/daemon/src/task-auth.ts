/** Owner bootstrap only; deliberately no enrollment API/tool. */
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { withPathLock } from "./path-lock.js";
import { atomicWrite, tasksPath } from "./task-store.js";
import { taskIdentitySchema as identity } from "./task-schema.js";
import { safeEqual } from "./http-auth.js";

const credentialSchema = z.strictObject({
  credential_id: identity, token_hash: z.string().regex(/^[a-f0-9]{64}$/),
  actor_id: identity, domains: z.array(identity).min(1).max(32)
    .refine(v => new Set(v).size === v.length), role: z.enum(["owner", "agent"]),
  created_at: z.number().int().nonnegative().safe(),
  revoked_at: z.number().int().nonnegative().safe().optional(),
});
const registrySchema = z.strictObject({ schema_version: z.literal(1),
  revision: z.number().int().nonnegative().safe(), credentials: z.array(credentialSchema).max(1000),
}).refine(r => new Set(r.credentials.map(c => c.credential_id)).size === r.credentials.length
  && new Set(r.credentials.map(c => c.token_hash)).size === r.credentials.length);
export type TaskPrincipal = Pick<z.infer<typeof credentialSchema>, "credential_id" | "actor_id" | "domains" | "role">;
export class TaskAuthError extends Error {
  constructor(public readonly code: "unauthorized" | "forbidden" | "auth_corrupt" | "not_found", message: string) {
    super(message); this.name = "TaskAuthError";
  }
}
export function taskAuthPath(): string { return join(dirname(tasksPath()), "task-auth.json"); }
function digest(token: string): string { return createHash("sha256").update(token).digest("hex"); }
async function readRegistry(path: string): Promise<z.infer<typeof registrySchema>> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { schema_version: 1, revision: 0, credentials: [] };
    throw new TaskAuthError("auth_corrupt", "credential registry cannot be read safely");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 1024 * 1024)
      throw new Error("unsafe registry");
    return registrySchema.parse(JSON.parse(await handle.readFile("utf8")));
  } catch { throw new TaskAuthError("auth_corrupt", "credential registry invalid; original preserved"); }
  finally { await handle.close(); }
}
/** Reload on every request: revocation does not wait for daemon restart. */
export async function authenticateTask(authorization: string | undefined, path = taskAuthPath()): Promise<TaskPrincipal> {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
  if (!match) throw new TaskAuthError("unauthorized", "mapped task credential required");
  const hash = digest(match[1]);
  const registry = await readRegistry(path);
  const entry = registry.credentials.find(c => safeEqual(c.token_hash, hash) && c.revoked_at === undefined);
  if (!entry) throw new TaskAuthError("unauthorized", "mapped task credential required");
  return { credential_id: entry.credential_id, actor_id: entry.actor_id, domains: [...entry.domains], role: entry.role };
}
export function requireTaskOwner(principal: TaskPrincipal): void {
  if (principal.role !== "owner") throw new TaskAuthError("forbidden", "owner command required");
}
export function requireTaskDomains(principal: TaskPrincipal, domains: readonly string[]): void {
  if (!domains.every(d => principal.domains.includes(d)))
    throw new TaskAuthError("forbidden", "task ownership domain denied");
}
/** Only called by offline owner bootstrap; raw token goes to a private destination. */
export async function mintTaskCredential(path: string, input: Pick<TaskPrincipal, "actor_id" | "domains" | "role">,
  rotate?: string, retireAutomatic = false): Promise<{ credential_id: string; token: string }> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withPathLock(path, async assertOwnership => {
    const registry = await readRegistry(path);
    const token = randomBytes(32).toString("base64url");
    const entry = credentialSchema.parse({ ...input, credential_id: randomUUID(), token_hash: digest(token), created_at: Date.now() });
    if (rotate) {
      const previous = registry.credentials.find(c => c.credential_id === rotate && c.revoked_at === undefined);
      if (!previous) throw new TaskAuthError("not_found", "active credential absent");
      if (previous.actor_id !== entry.actor_id || previous.role !== entry.role
        || JSON.stringify(previous.domains) !== JSON.stringify(entry.domains))
        throw new TaskAuthError("forbidden", "rotation cannot widen identity or domains");
      previous.revoked_at = Date.now();
    }
    if (retireAutomatic) for (const old of registry.credentials) if (old.role === "agent" && old.actor_id.startsWith("local-agent.") && old.revoked_at === undefined) old.revoked_at = Date.now();
    registry.credentials.push(entry); registry.revision++;
    await atomicWrite(path, JSON.stringify(registrySchema.parse(registry)), assertOwnership);
    return { credential_id: entry.credential_id, token };
  }, { strictLocal: true });
}
export async function revokeTaskCredential(path: string, credentialId: string): Promise<void> {
  identity.parse(credentialId);
  await withPathLock(path, async assertOwnership => {
    const registry = await readRegistry(path);
    const entry = registry.credentials.find(c => c.credential_id === credentialId);
    if (!entry) throw new TaskAuthError("not_found", "credential absent");
    entry.revoked_at ??= Date.now(); registry.revision++;
    await atomicWrite(path, JSON.stringify(registrySchema.parse(registry)), assertOwnership);
  }, { strictLocal: true });
}

/** Automatic setup is scoped to a local single-owner installation. */
export async function localTaskDomains(path = taskAuthPath()): Promise<string[] | undefined> {
  const registry = await readRegistry(path);
  const owners = registry.credentials.filter(c => c.role === "owner" && c.revoked_at === undefined);
  if (new Set(owners.map(c => c.actor_id)).size > 1) return;
  const domains = [...new Set(owners.flatMap(c => c.domains))];
  return domains.length ? domains : ["personal"];
}
