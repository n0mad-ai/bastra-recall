/** Explicit task deletion preserves global spent proofs and execution fences. */
import { readTaskArchive } from "./task-archive.js";
import type { TaskStore } from './task-schema.js';
import { TaskStoreError } from './task-store.js';
import { canonicalTaskValue } from './task-canonical.js';

export function deleteTaskRows(store: TaskStore, ids: Set<string>): void {
  if (store.intents.some(i => ids.has(i.task_id) && (['pending', 'unknown'].includes(i.state) || i.temp_cleanup_pending))
    || store.leases.some(l => ids.has(l.task_id) && l.state === 'active'))
    throw new TaskStoreError('conflict', 'Reconcile in-flight or unknown execution before deleting its task');
  const proposals = new Set(store.proposals.filter(p => ids.has(p.task_id)).map(p => p.id));
  store.tasks = store.tasks.filter(t => !ids.has(t.id));
  store.occurrences = store.occurrences.filter(o => !ids.has(o.task_id));
  store.proposals = store.proposals.filter(p => !ids.has(p.task_id));
  store.challenges = store.challenges.filter(c => !proposals.has(c.proposal_id));
  store.approvals = store.approvals.filter(a => !proposals.has(a.proposal_id));
  store.leases = store.leases.filter(l => !ids.has(l.task_id));
  store.intents = store.intents.filter(i => !ids.has(i.task_id));
  store.receipts = store.receipts.filter(r => !ids.has(r.task_id));
}

/** A delete mutation may only remove selected task groups, never change other state. */
export async function validateTaskDeletePrune(path: string, before: TaskStore, after: TaskStore): Promise<TaskStore> {
  const ids = new Set(before.tasks.filter(t => !after.tasks.some(n => n.id === t.id)).map(t => t.id));
  const expected = structuredClone(before);
  deleteTaskRows(expected, ids);
  let coldDeleted = false;
  for (const entry of expected.archives) {
    const next = after.archives.find(a => a.id === entry.id);
    if (!next) throw new TaskStoreError('conflict', 'Deletion cannot remove archive indexes');
    const oldIds = entry.deleted_task_ids ?? [], nextIds = next.deleted_task_ids ?? [];
    if (oldIds.some(id => !nextIds.includes(id)) || new Set(nextIds).size !== nextIds.length)
      throw new TaskStoreError('conflict', 'Deleted archive tasks cannot return');
    const added = nextIds.filter(id => !oldIds.includes(id));
    if (added.length) {
      const original = await readTaskArchive(path, entry, true);
      if (added.some(id => !original.tasks.some(t => t.id === id) || before.tasks.some(t => t.id === id)))
        throw new TaskStoreError('conflict', 'Cold deletion requires exact archived tasks, without active copies');
      entry.deleted_task_ids = nextIds;
      coldDeleted = true;
    }
  }
  if (!ids.size && !coldDeleted) throw new TaskStoreError('conflict', 'Task deletion requires a removed task');
  if (canonicalTaskValue(expected) !== canonicalTaskValue(after))
    throw new TaskStoreError('conflict', 'Task deletion cannot change unrelated rows or spent authority');
  return expected;
}
