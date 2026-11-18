/** The one state a task report shows in the owner's list (Daniel 18.11.2026), derived from data the
 * store already holds plus the follow-up link (`follow_up_of`) a report may carry:
 * - in_progress: the owner has notes not handed over yet (drafts);
 * - handed: every note is handed over, but an agent has not closed all of them yet;
 * - question: a follow-up report asks the owner something ([? … | …] answer options) and that
 *   follow-up is not done itself; `follow_up` names it;
 * - done: there are notes and an agent closed every one (task_report_note_done);
 * - new: unread, no notes; read: read, no notes.
 * Only the notes the caller may see count, so an agent never learns of the owner's drafts. A
 * follow-up's own state is taken from its notes alone (no second follow-up step), so a chain of
 * follow-ups can never loop. Questions are recognised by the fixed syntax only, never by words. */

// One scanner for the reader and this status (#1656): the web reader's own module, which the daemon
// finds next to its code as it finds the rest of the web UI (webui.ts).
import { inlineMatches } from "../webui/app/js/views/inline-scan.js";

export type ReportStatus = "new" | "read" | "in_progress" | "handed" | "question" | "done";

export interface StatusNote {
  state: "open" | "done";
  handed_at?: number;
}
export interface StatusReport {
  id: string;
  title: string;
  body: string;
  created_at: number;
  read_at?: number;
  follow_up_of?: string;
}

// The marker the UI shows as answer buttons (tasks-reports-model.js askOf, tasks-report-notes.js
// takeAsk): 2 to 6 distinct options of at most 40 characters after a question, at the end of a list
// item or paragraph line. One contract with the reader (#1656): the lines are taken apart as its
// renderer (webui views/memory-browser.js markdown()) does, so a marker in code, in a heading, behind
// a backslash (#1652) or with formatting inside it stays text here as well.
const ASK = /\[\?([^[\]]*)\]\s*$/;
const ASK_MIN = 2;
const ASK_MAX = 6;
const OPTION_MAX = 40;

const FENCE = /^```/;
const HEADING = /^#{1,6}\s/;
const ITEM = /^\s*(?:[-*]|\d+\.)\s+(.*)$/;
/** Where the last inline element of `text` ends (0 without one): the renderer's inline formatting
 * (views/markdown.js, via inline-scan.js) — wiki links, code, bold, links, web addresses, emphasis. An
 * element that ends after the marker's start leaves the line plain text. */
function formattedUntil(text: string): number {
  return inlineMatches(text).at(-1)?.end ?? 0;
}

/** The text of a list item or paragraph line: does it end with answer options? */
function asksIn(text: string): boolean {
  const m = ASK.exec(text);
  if (!m || text[m.index - 1] === "\\" || !text.slice(0, m.index).trim()) return false;
  if (formattedUntil(text) > m.index) return false;
  const options = m[1]!.split("|").map((o) => o.trim());
  return (
    options.length >= ASK_MIN &&
    options.length <= ASK_MAX &&
    options.every((o) => o !== "" && o.length <= OPTION_MAX) &&
    new Set(options).size === options.length
  );
}

/** True when the report text holds at least one question with answer options. */
export function asksOwner(body: string): boolean {
  let fence = false;
  // HTML comments are bookkeeping the reader drops before it reads the lines
  for (const raw of body.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const line = raw.trimEnd();
    if (FENCE.test(line)) fence = !fence;
    else if (!fence && !HEADING.test(line) && asksIn(ITEM.exec(line)?.[1] ?? line)) return true;
  }
  return false;
}

/** The state from the notes alone (the first four rules without the follow-up). */
function notesStatus(notes: readonly StatusNote[]): ReportStatus | null {
  if (notes.some((n) => n.state === "open" && n.handed_at === undefined)) return "in_progress";
  if (notes.some((n) => n.state === "open")) return "handed";
  return notes.length > 0 ? "done" : null;
}

/** The newest follow-up of `report` that still waits for the owner's answer. */
function openQuestion<R extends StatusReport>(
  report: StatusReport,
  reports: readonly R[],
  notesOf: (r: R) => readonly StatusNote[]
): R | undefined {
  return reports
    .filter((r) => r.follow_up_of === report.id && r.id !== report.id && asksOwner(r.body))
    .filter((r) => notesStatus(notesOf(r)) !== "done")
    .sort((a, b) => b.created_at - a.created_at)[0];
}

/** `status` for one report among the reports the caller sees, plus `follow_up` for a question. */
export function reportStatus<R extends StatusReport>(
  report: R,
  reports: readonly R[],
  notesOf: (r: R) => readonly StatusNote[]
): { status: ReportStatus; follow_up?: { id: string; title: string } } {
  const own = notesStatus(notesOf(report));
  if (own === "in_progress" || own === "handed") return { status: own };
  const asked = openQuestion(report, reports, notesOf);
  if (asked) return { status: "question", follow_up: { id: asked.id, title: asked.title } };
  if (own === "done") return { status: own };
  return { status: report.read_at === undefined ? "new" : "read" };
}

/** `follow_up_of` as answers carry it: the report this one asks about, while the caller sees it. */
export function followUpOf(report: StatusReport, reports: readonly StatusReport[]) {
  const target = report.follow_up_of === undefined ? undefined : reports.find((r) => r.id === report.follow_up_of);
  return target ? { follow_up_of: { id: target.id, title: target.title } } : {};
}
