/**
 * The Code-awareness section of the UI telemetry report (#589).
 *
 * Both halves in one object, because the tab has to answer one question —
 * "is code awareness doing anything, and is it doing it well?" — and the halves
 * only make sense side by side: the dependents block is what the feature spends
 * without being asked, the tool calls are what it is asked for.
 *
 * The active half is folded by `code-awareness-stats.ts`, the same fold the CLI
 * prints, so the two readouts cannot drift. The passive half is folded by
 * `cli/log-stats-code.ts`, likewise shared rather than reimplemented.
 *
 * Returns null when the window holds neither — a vault with code awareness
 * switched off should not grow a section of zeroes.
 */
import { aggregateCodeAwareness, type CodeAwarenessStats } from "./code-awareness-stats.js";
import { aggregateCodeRoi, type CodeRoiStats } from "./cli/log-stats-code.js";
import type { AnyEventLike } from "./stats-governor.js";

export interface CodeAwarenessSection {
  /** The tools an agent calls on purpose, and the graph refreshes behind them. */
  active: CodeAwarenessStats;
  /** #579: the dependents / affects_files blocks the Write/Edit lane injects. */
  block: CodeRoiStats;
}

export function summarizeCodeAwareness(events: AnyEventLike[]): CodeAwarenessSection | null {
  const active = aggregateCodeAwareness(events as Parameters<typeof aggregateCodeAwareness>[0]);
  const block = aggregateCodeRoi(
    events.filter((e) => e.kind === "hook_call") as Parameters<typeof aggregateCodeRoi>[0],
  );
  if (active.events === 0 && block.withCodeBlock === 0 && block.withAppliesTo === 0) return null;
  return { active, block };
}
