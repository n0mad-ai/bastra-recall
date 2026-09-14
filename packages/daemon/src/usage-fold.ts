/** Pure folding for the append-only usage sidecar. */
import type { UsageAggregate, UsageEntry, UsageEvent } from "./usage-sidecar.js";

const emptyEntry = (): UsageEntry => ({ surfaced: 0, loaded: 0, acted_on: 0 });

export function foldUsageEvent(agg: UsageAggregate, e: UsageEvent, measurementKind: string): void {
  if (!e || typeof e.id !== "string" || e.id.length === 0) return;
  const kind = e.kind;
  if (kind !== "surfaced" && kind !== "loaded" && kind !== "acted_on" && kind !== measurementKind) return;
  const entry = (agg[e.id] ??= emptyEntry());
  if (kind !== measurementKind) entry[kind as "surfaced" | "loaded" | "acted_on"] += 1;

  if (kind !== measurementKind && typeof e.revision === "string" && e.revision.length > 0) {
    const seenAt = entry.revision_seen_at;
    const olderRevision =
      entry.revision !== undefined
      && entry.revision !== e.revision
      && typeof seenAt === "string"
      && typeof e.ts === "string"
      && e.ts < seenAt;
    if (!olderRevision) {
      if (entry.revision !== e.revision) {
        entry.revision = e.revision;
        entry.revision_surfaced = 0;
        entry.revision_loaded = 0;
        entry.revision_acted_on = 0;
      }
      const field = `revision_${kind}` as "revision_surfaced" | "revision_loaded" | "revision_acted_on";
      entry[field] = (entry[field] ?? 0) + 1;
      if (typeof e.ts === "string" && (!seenAt || e.ts > seenAt)) entry.revision_seen_at = e.ts;
    }
  }

  const tsField = `last_${kind}_at` as
    | "last_surfaced_at"
    | "last_loaded_at"
    | "last_acted_on_at"
    | "last_sampled_at";
  if (typeof e.ts === "string" && (!entry[tsField] || e.ts > entry[tsField]!)) {
    entry[tsField] = e.ts;
  }
}
