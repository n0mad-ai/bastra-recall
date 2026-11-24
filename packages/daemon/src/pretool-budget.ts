/**
 * #1460: the upper bound for the text one PreToolUse lane adds to the agent's
 * context. The prompt lane has had one since #1363 (10,000 characters); the
 * pre-tool lanes had none, so a four-file Codex patch could carry ~7,000
 * characters of code-impact blocks on a single call (event log 2026-10-30..
 * 11-16: write-lane p99 1,011, max 1,748 estimated tokens).
 *
 * The bound is for what a lane may leave out: optional sections (code-impact
 * and applies-to blocks, lower-ranked plan hints, draft quotes) are dropped
 * WHOLE once they would cross it — never cut in the middle of a frame. What a
 * lane must say (a tripwire warning, the file-size convention, a rule the user
 * wired to the action) is never dropped for it.
 *
 * Owner decision (#1460 F5, 24.11.2026): the bound stays at 4,000. The agent's
 * Soul (#1504, not built yet) gets its own character budget later and never
 * counts against this one.
 */
export const PRE_TOOL_CONTEXT_CHAR_BUDGET = 4000;

/**
 * Keep `optional` sections in order while they fit next to `usedChars`
 * already taken; a section that does not fit is skipped and a later, shorter
 * one may still fit. Each kept section costs its length plus one newline.
 */
export function fitOptional<T>(
  usedChars: number,
  optional: readonly T[],
  size: (section: T) => number,
  budget = PRE_TOOL_CONTEXT_CHAR_BUDGET
): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let used = usedChars;
  let dropped = 0;
  for (const section of optional) {
    const cost = size(section) + 1;
    if (used + cost > budget) {
      dropped++;
      continue;
    }
    kept.push(section);
    used += cost;
  }
  return { kept, dropped };
}

/**
 * Drop items from the end (the lowest-ranked) until `render` fits the budget;
 * at least one item is always kept. Returns the kept items and their text.
 */
export function trimToBudget<T>(
  items: readonly T[],
  render: (kept: readonly T[]) => string,
  budget = PRE_TOOL_CONTEXT_CHAR_BUDGET
): { kept: T[]; text: string } {
  let kept = [...items];
  let text = render(kept);
  while (text.length > budget && kept.length > 1) {
    kept = kept.slice(0, -1);
    text = render(kept);
  }
  return { kept, text };
}
