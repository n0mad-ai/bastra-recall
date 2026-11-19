/** Explicit task deletion preserves global spent proofs and execution fences. */
import { readTaskArchive } from "./task-archive.js";
import type { TaskStore } from "./task-schema.js";
import { TaskStoreError } from "./task-store-error.js";
import { canonicalTaskValue } from "./task-canonical.js";
import { deleteTaskRows } from "./task-delete-rows.js";

// The row removal itself lives in task-delete-rows.ts (archive reads use it
// too); re-exported so every importer keeps `from "./task-delete.js"`.
export { deleteTaskRows } from "./task-delete-rows.js";

/** A delete mutation may only remove selected task groups, never change other state. */
export async function validateTaskDeletePrune(path: string, before: TaskStore, after: TaskStore): Promise<TaskStore> {
  const ids = new Set(before.tasks.filter((t) => !after.tasks.some((n) => n.id === t.id)).map((t) => t.id));
  const expected = structuredClone(before);
  deleteTaskRows(expected, ids);
  let coldDeleted = false;
  for (const entry of expected.archives) {
    const next = after.archives.find((a) => a.id === entry.id);
    if (!next) throw new TaskStoreError("conflict", "Deletion cannot remove archive indexes");
    const oldIds = entry.deleted_task_ids ?? [],
      nextIds = next.deleted_task_ids ?? [];
    if (oldIds.some((id) => !nextIds.includes(id)) || new Set(nextIds).size !== nextIds.length)
      throw new TaskStoreError("conflict", "Deleted archive tasks cannot return");
    const added = nextIds.filter((id) => !oldIds.includes(id));
    if (added.length) {
      const original = await readTaskArchive(path, entry, true);
      if (added.some((id) => !original.tasks.some((t) => t.id === id) || before.tasks.some((t) => t.id === id)))
        throw new TaskStoreError("conflict", "Cold deletion requires exact archived tasks, without active copies");
      entry.deleted_task_ids = nextIds;
      coldDeleted = true;
    }
  }
  if (!ids.size && !coldDeleted) throw new TaskStoreError("conflict", "Task deletion requires a removed task");
  if (canonicalTaskValue(expected) !== canonicalTaskValue(after))
    throw new TaskStoreError("conflict", "Task deletion cannot change unrelated rows or spent authority");
  return expected;
}
