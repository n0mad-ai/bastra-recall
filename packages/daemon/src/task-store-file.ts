/**
 * Where the task store lives and how every private task file is written
 * durably. The store, its credentials (task-auth.ts), archives and comparison
 * keys build on this; it imports none of them.
 */
import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { bastraDataDir } from "./platform-paths.js";

export function tasksPath(): string {
  return resolve(process.env.BASTRA_TASKS_PATH ?? join(bastraDataDir(), "proactive-tasks.json"));
}

export async function atomicWrite(path: string, payload: string, assertOwnership: () => void): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    assertOwnership();
    // Strict live-owner lock cannot be age-displaced; no await before commit.
    renameSync(tmp, path);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(tmp).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
