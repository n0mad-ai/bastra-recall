/** Types of the part of tasks-reports-model.js the daemon's question status reads (task-report-status.ts). */
export type ReportBlock = { kind: "md"; text: string } | { kind: "table"; head: string[]; rows: string[][] };

export function reportBlocks(md: unknown): ReportBlock[];
export function askOf(text: string, previous?: string): { question: string; options: string[]; at: number } | null;
export const OPTION_MAX: number;
