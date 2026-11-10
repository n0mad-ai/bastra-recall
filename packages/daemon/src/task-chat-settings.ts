/** Claude's account-wide inbound setting is changed only by explicit setup consent. */
import { constants } from "node:fs";
import { open, mkdir, writeFile, rename, unlink, lstat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { managedSettingsPath } from "./cc-permissions.js";
import { readSettings, mutateSettings, settingsFilePath } from "./settings-file.js";
import { SETTINGS_REGISTRY } from "./settings-registry.js";
import { TASKS_DEFAULT } from "./settings-defaults.js";
import { withPathLock } from "./path-lock.js";

export interface TaskChatSetupPaths { settingsPath?: string; userPath?: string; managedPath?: string; managedPolicyPaths?: string[]; }
function paths(input: TaskChatSetupPaths) {
  const userPath = input.userPath ?? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
  const managedPath = input.managedPath ?? (process.platform === "win32" ? "C:\\Program Files\\ClaudeCode\\managed-settings.json" : managedSettingsPath());
  const mdm = process.platform === "darwin" ? [
    "/Library/Managed Preferences/com.anthropic.claudecode.plist",
    join("/Library/Managed Preferences", userInfo().username, "com.anthropic.claudecode.plist"),
    join(homedir(), "Library/Managed Preferences/com.anthropic.claudecode.plist"),
  ] : [];
  return { settingsPath: input.settingsPath ?? settingsFilePath(), userPath, managedPath,
    managedPolicyPaths: input.managedPolicyPaths ?? [join(dirname(managedPath), "managed-settings.d"), join(dirname(userPath), "remote-settings.json"), ...mdm] };
}
/** Presence, including unreadable/symlinked policies, is enough to preserve the
 * managed tier. Never execute a policy helper or try to weaken its result.
 * Sources: code.claude.com/docs/en/managed-settings and server-managed-settings. */
export async function hasManagedTaskChatPolicy(input: TaskChatSetupPaths = {}): Promise<boolean> {
  const p = paths(input);
  for (const path of [p.managedPath, ...p.managedPolicyPaths]) {
    try { await lstat(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true; }
  }
  return false;
}
async function jsonDocument(path: string): Promise<{ data: Record<string, unknown>; raw: string } | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("Claude settings cannot be safely read; nothing changed"); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid Claude settings file");
    const raw = await file.readFile("utf8");
    const json: unknown = JSON.parse(raw);
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Invalid Claude settings object");
    return { data: json as Record<string, unknown>, raw };
  } catch { throw new Error("Claude settings are unavailable or invalid; nothing changed"); }
  finally { await file.close(); }
}
async function jsonFile(path: string) { return (await jsonDocument(path))?.data; }
function restrictive(user: Record<string, unknown> | undefined) {
  return user?.crossSessionInbound !== undefined && user.crossSessionInbound !== "accept";
}
/** A changed user/managed preference closes delivery immediately, without resetting the saved answer. */
export async function taskChatSettings(input: TaskChatSetupPaths = {}): Promise<{ consent: boolean; activeMinutes: number }> {
  const p = paths(input), settings = await readSettings(p.settingsPath);
  const activeMinutes = settings.tasks?.chatActiveMinutes ?? SETTINGS_REGISTRY.tasks.chatActiveMinutes.default;
  let consent = false;
  if (settings.tasks?.chatConsent === "accepted") {
    try { const user = await jsonFile(p.userPath);
      consent = user?.crossSessionInbound === "accept" && !await hasManagedTaskChatPolicy(p);
    } catch { /* Unknown settings are closed. */ }
  }
  return { consent, activeMinutes };
}
export async function inspectTaskChatSetup(input: TaskChatSetupPaths = {}) {
  const p = paths(input), saved = (await readSettings(p.settingsPath)).tasks?.chatConsent;
  if (saved) return { ask: false, answer: saved };
  return { ask: true, answer: undefined };
}
export async function applyTaskChatConsent(answer: boolean, input: TaskChatSetupPaths = {}) {
  if (answer !== true && answer !== false) throw new Error("An explicit setup answer is required; nothing changed");
  const p = paths(input);
  let result: { answer: "accepted" | "declined" | "blocked"; backupPath?: string } = { answer: "declined" };
  // A second setup process cannot overwrite an earlier yes/no. Generic settings cannot set this field.
  await withPathLock(`${p.settingsPath}.chat-setup`, async () => {
    const prior = (await readSettings(p.settingsPath)).tasks?.chatConsent;
    if (prior) { result = { answer: prior }; return; }
    if (answer) {
      await mkdir(dirname(p.userPath), { recursive: true, mode: 0o700 });
      const directory = await lstat(dirname(p.userPath));
      if (!directory.isDirectory() || directory.isSymbolicLink() || (process.getuid && directory.uid !== process.getuid())) throw new Error("Unsafe Claude settings directory; nothing changed");
      await withPathLock(p.userPath, async () => {
        const document = await jsonDocument(p.userPath), user = document?.data;
        if (await hasManagedTaskChatPolicy(p) || restrictive(user)) { result = { answer: "blocked" }; return; }
        const suffix = randomUUID(); const tmp = `${p.userPath}.bastra-${suffix}`;
        const current = user ?? {};
        if (user) {
          const stat = await lstat(p.userPath);
          if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Claude settings ownership mismatch; nothing changed");
          result.backupPath = `${p.userPath}.bak-bastra-${suffix}`;
          await writeFile(result.backupPath, document!.raw, { flag: "wx", mode: 0o600 });
        }
        try {
          await writeFile(tmp, JSON.stringify({ ...current, crossSessionInbound: "accept" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
          await rename(tmp, p.userPath);
        } finally { await unlink(tmp).catch(() => {}); }
        result.answer = "accepted";
      }, { strictLocal: true });
    }
    await mutateSettings(p.settingsPath, settings => ({ ...settings, tasks: { enabled: settings.tasks?.enabled ?? TASKS_DEFAULT, ...settings.tasks, chatConsent: result.answer } }), { refuseCorrupt: true, requireLock: true });
  }, { strictLocal: true });
  return result;
}
