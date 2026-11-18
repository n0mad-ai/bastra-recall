/** Types of inline-scan.js for the daemon's question status (task-report-status.ts). */
export interface InlineMatch {
  /** Where the element starts, as the expression's match index (emphasis: with its leading character). */
  index: number;
  /** Where it ends. */
  end: number;
  /** [0] the whole match, [1]–[9] the expression's groups, undefined when not taking part. */
  groups: (string | undefined)[];
}

export function inlineMatches(text: string): InlineMatch[];
