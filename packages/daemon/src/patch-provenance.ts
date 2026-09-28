/** Durable write-ahead evidence for local patches. `last-run.json` is written
 * after reapply; if that write fails, a later update must not mistake our own
 * reverse-applying patch for a change merged upstream and retire it. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { LastRun } from "./patch-registry.js";

interface RecordOnDisk { root: string; version: string; ids: string[] }

export function canonicalPatchRoot(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export function appliedByLastRun(last: LastRun | null, id: string, applyRoot: string, version?: string): boolean {
  if (!last || !last.applied.includes(id)) return false;
  if (last.root && canonicalPatchRoot(last.root) !== canonicalPatchRoot(applyRoot)) return false;
  if (version !== undefined && last.version !== undefined) return version === last.version;
  return true;
}

function fileOf(home: string): string {
  return join(home, ".bastra", "patches", "reapply-provenance.json");
}

function readRecords(home: string): RecordOnDisk[] {
  let raw: string;
  try {
    raw = readFileSync(fileOf(home), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((r) => r && typeof r.root === "string" && typeof r.version === "string" && Array.isArray(r.ids) && r.ids.every((id: unknown) => typeof id === "string"))) {
    throw new Error("invalid patch provenance record");
  }
  return parsed as RecordOnDisk[];
}

function writeRecords(home: string, records: RecordOnDisk[]): void {
  const path = fileOf(home);
  mkdirSync(join(home, ".bastra", "patches"), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(records) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Null means the provenance file is unreadable: uncertain attribution must
 * keep a patch registered, never retire it. */
export function priorPatchIds(root: string, version?: string, home: string = homedir()): Set<string> | null {
  try {
    const record = readRecords(home).find((r) => r.root === root && r.version === (version ?? ""));
    return new Set(record?.ids ?? []);
  } catch {
    return null;
  }
}

/** Called BEFORE a git apply/3-way attempt. A failed marker write prevents the
 * patch from being applied; there is then no unrecorded local change to lose. */
export function rememberPatch(root: string, version: string | undefined, id: string, home: string = homedir()): void {
  const records = readRecords(home);
  let record = records.find((r) => r.root === root && r.version === (version ?? ""));
  if (!record) {
    record = { root, version: version ?? "", ids: [] };
    records.push(record);
  }
  if (!record.ids.includes(id)) record.ids.push(id);
  writeRecords(home, records);
}

/** `last-run.json` has taken over the provenance only after its write succeeds. */
export function clearPatchProvenance(root: string, version?: string, home: string = homedir()): void {
  const records = readRecords(home).filter((r) => r.root !== root || r.version !== (version ?? ""));
  writeRecords(home, records);
}
