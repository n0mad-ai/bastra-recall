/**
 * Removing task groups from a snapshot: the one rule the store's recovery,
 * archive reads and explicit deletion share. Imports no task module that
 * reads or writes the store.
 */
import type { TaskStore } from "./task-schema.js";
import { TaskStoreError } from "./task-store-error.js";

export function deleteTaskRows(store: TaskStore, ids: Set<string>): void {
  if (
    store.intents.some(
      (i) => ids.has(i.task_id) && (["pending", "unknown"].includes(i.state) || i.temp_cleanup_pending)
    ) ||
    store.leases.some((l) => ids.has(l.task_id) && l.state === "active")
  )
    throw new TaskStoreError("conflict", "Reconcile in-flight or unknown execution before deleting its task");
  const proposals = new Set(store.proposals.filter((p) => ids.has(p.task_id)).map((p) => p.id));
  store.tasks = store.tasks.filter((t) => !ids.has(t.id));
  store.occurrences = store.occurrences.filter((o) => !ids.has(o.task_id));
  store.proposals = store.proposals.filter((p) => !ids.has(p.task_id));
  store.challenges = store.challenges.filter((c) => !proposals.has(c.proposal_id));
  store.approvals = store.approvals.filter((a) => !proposals.has(a.proposal_id));
  store.leases = store.leases.filter((l) => !ids.has(l.task_id));
  store.intents = store.intents.filter((i) => !ids.has(i.task_id));
  store.receipts = store.receipts.filter((r) => !ids.has(r.task_id));
}
