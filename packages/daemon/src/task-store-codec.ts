/** Decode a bounded task snapshot before any store or archive operation. */
import { TASK_MAX_BYTES, taskStoreSchema, type TaskStore } from "./task-schema.js";
import { TaskStoreError } from "./task-store-error.js";

function requireEmptyLegacyRows(snapshot: Record<string, unknown>, fields: string[], message: string): void {
  for (const field of fields) {
    const rows = snapshot[field];
    if (!Array.isArray(rows) || rows.length) throw new TaskStoreError("corrupt", message);
  }
}

function upgradeTaskSnapshot(snapshot: object): object {
  if (!("schema_version" in snapshot)) return snapshot;
  switch (snapshot.schema_version) {
    case 1:
      // V1 never carried actions. Check all its restricted rows before upgrading.
      requireEmptyLegacyRows(
        snapshot,
        ["proposals", "challenges", "approvals", "leases", "intents", "receipts"],
        "v1 actions must be empty"
      );
      return { ...snapshot, schema_version: 4 };
    case 2:
      requireEmptyLegacyRows(snapshot, ["intents", "receipts"], "v2 execution state must be empty");
      return { ...snapshot, schema_version: 4 };
    case 3:
      // V4 only adds optional pause/expiry/delivery metadata.
      return { ...snapshot, schema_version: 4 };
    case 4:
      return snapshot;
    default:
      throw new TaskStoreError("unsupported_version", "unsupported task schema; original preserved");
  }
}

export function decodeTaskStore(raw: string): TaskStore {
  if (Buffer.byteLength(raw) > TASK_MAX_BYTES)
    throw new TaskStoreError("capacity", "task snapshot exceeds its hard limit; original preserved");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TaskStoreError("corrupt", "invalid task JSON; original preserved");
  }
  if (value && typeof value === "object") {
    value = upgradeTaskSnapshot(value);
    dropLegacyTaskComparisons(value);
  }
  const parsed = taskStoreSchema.safeParse(value);
  if (!parsed.success) throw new TaskStoreError("corrupt", "invalid task schema or references; original preserved");
  return parsed.data;
}

/** Drop unsafe legacy verifiers; raw secrets cannot be recovered for migration. */
export function dropLegacyTaskComparisons(store: any): void {
  for (const t of store.tasks ?? []) {
    if (typeof t.reminder_fingerprint === "string" && /^[a-f0-9]{64}$/.test(t.reminder_fingerprint))
      delete t.reminder_fingerprint;
    if (typeof t.creation_hash === "string" && /^[a-f0-9]{64}$/.test(t.creation_hash)) delete t.creation_hash;
  }
}
