import { bastraDataDir } from "./platform-paths.js";
import { tasksEnabled } from "./tasks-enabled.js";
/** Tiny hook/client-only credential reader; never loads task/runtime modules. */
import { constants, openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
export function taskHookConfigPath() { return join(dirname(resolve(process.env.BASTRA_TASKS_PATH ?? join(bastraDataDir(), "proactive-tasks.json"))), "task-hook-token.json"); }
export function taskClientToken(configPath = taskHookConfigPath()): string | undefined {
  if (!tasksEnabled()) return undefined;
  if (process.env.BASTRA_TASK_TOKEN !== undefined) return /^[A-Za-z0-9_-]{43}$/.test(process.env.BASTRA_TASK_TOKEN) ? process.env.BASTRA_TASK_TOKEN : undefined;
  let fd: number | undefined;
  try { fd = openSync(configPath, constants.O_RDONLY | constants.O_NOFOLLOW); const info = fstatSync(fd);
    if (!info.isFile() || info.mode & 0o077 || info.size > 4096) return undefined;
    const config = JSON.parse(readFileSync(fd, "utf8")); return config.schema_version === 1 && /^[A-Za-z0-9_-]{43}$/.test(config.token) ? config.token : undefined;
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}
export function taskClientHeaders(): Record<string, string> {
  const token = taskClientToken(); return token ? { "x-bastra-task-authorization": `Bearer ${token}` } : {};
}
