/** Types of code-lines.js for the daemon's question status (task-report-status.ts). */
/** fence: an opening or closing fence line; code: a line of code as the reader shows it; null: no code. */
export type CodeLine = { fence: "open" | "close" } | { code: string } | null;

export function codeLines(lines: readonly string[]): CodeLine[];
