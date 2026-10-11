import { z } from "zod";
import { taskIdentitySchema } from "../task-schema.js";
/** Owner-only interactive CLI cache, NEVER used by hooks/MCP/agents. */
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { authenticateTask, requireTaskOwner } from "../task-auth.js";
import { tasksPath, atomicWrite } from "../task-store.js";
import { privateJson } from "../task-approval-keys.js";
import { withPathLock } from "../path-lock.js";
import { taskPrivatePrompt } from "./task-private-prompt.js";
import { confirm } from "./prompt.js";
const ownerCacheSchema = z.strictObject({ schema_version: z.literal(1), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), credential_id: taskIdentitySchema });
export function ownerTaskAccessPath() { return join(dirname(tasksPath()), "task-owner-token.json"); }
export async function ownerTaskAuthorization(): Promise<string> {
  if (!process.stdin.isTTY) throw Object.assign(new Error("Owner terminal required"), { code: "forbidden" });
  let saved: unknown;
  try { saved = await privateJson(ownerTaskAccessPath()); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw Object.assign(new Error("Unsafe owner credential cache"), { code: "owner_cache_invalid" }); }
  const parsed = saved === undefined ? undefined : ownerCacheSchema.safeParse(saved);
  if (parsed && !parsed.success) throw Object.assign(new Error("Owner credential cache invalid"), { code: "owner_cache_invalid" });
  const token = parsed?.success ? parsed.data.token : await taskPrivatePrompt("Owner task token (hidden): ");
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw Object.assign(new Error("Owner credential invalid"), { code: "unauthorized" });
  const authorization = `Bearer ${token}`, principal = await authenticateTask(authorization); requireTaskOwner(principal);
  if (parsed?.success && parsed.data.credential_id !== principal.credential_id) throw Object.assign(new Error("Owner credential cache changed"), { code: "owner_cache_invalid" });
  return authorization;
}
export async function saveOwnerTaskAccess(authorization: string) {
  const principal = await authenticateTask(authorization); requireTaskOwner(principal); const path = ownerTaskAccessPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await withPathLock(path, ownership => atomicWrite(path, JSON.stringify({ schema_version: 1, token: authorization.slice(7), credential_id: principal.credential_id }), ownership), { strictLocal: true });
}
export async function loginOwnerTaskAccess() {
  if (!await confirm("Owner-Zugang nur für interaktive CLI privat speichern? Dieses Datenverzeichnis muss außerhalb des Agent-Zugriffs liegen; Hooks/MCP bekommen diesen Token nie.")) throw Object.assign(new Error("Owner declined credential cache"), { code: "forbidden" });
  const authorization = `Bearer ${await taskPrivatePrompt("Owner task token (hidden): ")}`;
  await saveOwnerTaskAccess(authorization);
  process.stdout.write("Owner-Zugang privat für die interaktive CLI gespeichert. Wird bei jedem Befehl frisch geprüft; Signing-Schlüssel weiterhin separat entsperren.\n");
}
