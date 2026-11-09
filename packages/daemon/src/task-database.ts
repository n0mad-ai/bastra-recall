/** Task snapshots only. Private keys and portable archive exports stay files. */
import { lstatSync } from "node:fs";
import { appRecordDatabasePath, readAppRecord, writeAppRecord } from "./app-record-store.js";
import { decodeTaskStore } from "./task-store.js";

export function readTaskSnapshotText(path: string, validate = true): string {
  const absent = (candidate: string): boolean => {
    try { lstatSync(candidate); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
  };
  // A pre-feature idle read must not create the database/schema and wake its
  // watcher. Other I/O failures remain failures, never an empty task store.
  if (absent(path) && absent(appRecordDatabasePath(path))) {
    throw Object.assign(new Error("Task snapshot is absent"), { code: "ENOENT", path });
  }
  return readAppRecord("tasks", path, validate ? text => { decodeTaskStore(text); } : undefined);
}

/** The existing strict local task lock spans async effects and every commit. */
export function writeTaskSnapshotText(path: string, payload: string, assertOwnership: () => void): void {
  assertOwnership();
  writeAppRecord("tasks", path, payload, text => { decodeTaskStore(text); });
}
