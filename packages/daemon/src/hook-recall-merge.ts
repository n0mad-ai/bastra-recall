/**
 * Merge two hook-recall axes by score without combining evidence from different
 * queries. The winning hit travels intact: score, trigger match and anchor
 * strength must describe the same query, never a synthetic union of both hits.
 */
import type { RecallHit } from "@bastra-recall/core";

export function mergeHookRecallHits(
  first: RecallHit[],
  second: RecallHit[],
  limit: number,
): RecallHit[] {
  const byId = new Map<string, RecallHit>();
  for (const hit of [...first, ...second]) {
    const previous = byId.get(hit.id);
    if (!previous || hit.score > previous.score) byId.set(hit.id, hit);
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
