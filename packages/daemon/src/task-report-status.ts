/** The one state a task report shows in the owner's list (Daniel 18.11.2026), derived from data the
 * store already holds plus the follow-up link (`follow_up_of`) a report may carry:
 * - in_progress: the owner has notes not handed over yet (drafts);
 * - handed: every note is handed over, but an agent has not closed all of them yet;
 * - question: the report itself asks the owner something ([? … | …] answer options) and is
 *   not done. A standalone report keeps its note state or New until it is read;
 * - done: there are notes and an agent closed every one (task_report_note_done);
 * - new: unread, no notes; read: read, no notes;
 * - outdated (#1678): marked outdated by the owner or an agent; wins over every other state, and an
 *   outdated follow-up asks nothing any more.
 * Only the notes the caller may see count, so an agent never learns of the owner's drafts.
 * Independently of the state, `follow_up` names an open question below the report (#1657).
 * The walk visits every report once, so even a circle in a damaged store ends. A live descendant
 * can still ask through an outdated follow-up. Questions are recognised by the fixed syntax only. */

// One scanner for the reader and this status (#1656): the web reader's own module, which the daemon
// finds next to its code as it finds the rest of the web UI (webui.ts).
import { inlineMatches } from "../webui/app/js/views/inline-scan.js";
import { codeLines } from "../webui/app/js/views/code-lines.js";
import { OPTION_MAX, askOf, reportBlocks } from "../webui/app/js/sections/tasks-reports-model.js";

export type ReportStatus = "new" | "read" | "in_progress" | "handed" | "question" | "done" | "outdated";

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
  outdated_at?: number;
  follow_up_of?: string;
}

// The marker the UI shows as answer buttons (tasks-reports-model.js askOf, tasks-report-notes.js
// takeAsk): 2 to 6 distinct options after a question, at the end of a list item or paragraph line
// or after the question's prose block. One contract with the reader (#1656): the lines are taken apart
// as its renderer (webui views/markdown.js markdown()) does, so a marker in code (fenced or indented,
// the reader's own rule in code-lines.js), in a heading, behind a backslash (#1652) or with formatting
// inside it stays text here as well.
const HEADING = /^#{1,6}\s/;
const ITEM = /^\s*(?:[-*]|\d+\.)\s+(.*)$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}$/;
/** Where the last inline element of `text` ends (0 without one): the renderer's inline formatting
 * (views/markdown.js, via inline-scan.js) — wiki links, code, bold, links, web addresses, emphasis. An
 * element that ends after the marker's start leaves the line plain text. */
function formattedUntil(text: string): number {
  return inlineMatches(text).at(-1)?.end ?? 0;
}

/** `text` as the reader shows it (textContent of its inline rendering): elements give their inner text.
 * The separator before a marker counts where the owner sees it, also inside bold, code or a link (#1729).
 * A [[wiki link]] shows its memory's title in the reader, which is not known here: its trimmed id stands
 * in. Space inside a link target never separates (#1738): the reader shows the title, or the trimmed id. */
function renderedText(text: string): string {
  let out = "",
    last = 0;
  for (const { index, end, groups: g } of inlineMatches(text)) {
    const start = index + (g[9] === undefined ? 0 : (g[8]?.length ?? 0));
    out += text.slice(last, start) + (g[2] ?? g[1]?.trim() ?? g[3] ?? g[4] ?? g[5] ?? g[7] ?? g[9] ?? "");
    last = end;
  }
  return out + text.slice(last);
}

/** The lines of one markdown() call outside code and whether the reader shows answer options. */
function* proseQuestions(md: string) {
  // HTML comments are bookkeeping the reader drops before it reads the lines
  const lines = md.replace(/<!--[\s\S]*?-->/g, "").split("\n"),
    code = codeLines(lines);
  let previous = "";
  for (const [i, raw] of lines.entries()) {
    const line = raw.trimEnd();
    if (code[i] || HEADING.test(line) || ((!i || !lines[i - 1]?.trim()) && RULE.test(line))) {
      previous = "";
      if (!code[i]) yield { line, asks: false, before: line };
    } else if (line.trim()) {
      const text = ITEM.exec(line)?.[1] ?? line;
      const shown = renderedText(text),
        ask = askOf(shown, previous);
      // the marker stands in the last text node: no element ends after where it starts
      const at = ask === null ? -1 : text.length - (shown.length - ask.at),
        asks = ask !== null && formattedUntil(text) <= at;
      // `before`: the text in front of the shown marker, where another "[?" is still plain text (#1718)
      yield { line, asks, before: asks ? text.slice(0, at) : line };
      previous = shown;
    }
  }
}

/** True when the report text holds at least one question with answer options. The reader renders
 *  the prose between pipe tables piece by piece (tasks-reports.js bodyNodes), so a line right under
 *  a table starts a new piece there; this status reads the same pieces (#1665). */
export function asksOwner(body: string): boolean {
  for (const b of reportBlocks(body)) {
    if (b.kind !== "md") continue;
    for (const q of proseQuestions(b.text)) if (q.asks) return true;
  }
  return false;
}

// An opening marker outside inline code and not escaped: the agent meant answer options here.
const OPENS = /(?<!\\)\[\?/;
const INLINE_CODE = /`[^`]*`/g;

/** What task_report_save tells the agent about a report's questions (Daniel 25.11.2026): `asks`
 *  counts the questions the reader shows with answer buttons; `unread` lists the lines that open a
 *  marker "[?" but are not read as answer options, so the owner would see them as plain text — also
 *  a line whose last marker shows buttons while an earlier one on it stays text (#1718). */
export function questionCheck(body: string): { asks: number; unread: string[] } {
  let asks = 0;
  const unread: string[] = [];
  for (const b of reportBlocks(body)) {
    const lines =
      b.kind === "md"
        ? proseQuestions(b.text)
        : [b.head, ...b.rows].map((cells) => ({ line: cells.join(" | "), asks: false, before: cells.join(" | ") }));
    for (const { line, asks: shown, before } of lines) {
      if (shown) asks++;
      if (OPENS.test(before.replace(INLINE_CODE, ""))) unread.push(line.trim());
    }
  }
  return { asks, unread };
}

export { OPTION_MAX };

/** The state from the notes alone. */
function notesStatus(notes: readonly StatusNote[]): ReportStatus | null {
  if (notes.some((n) => n.state === "open" && n.handed_at === undefined)) return "in_progress";
  if (notes.some((n) => n.state === "open")) return "handed";
  return notes.length > 0 ? "done" : null;
}

/** One parse per report object: a list asks for every report, and a chain is walked once per report. */
const asksCache = new WeakMap<StatusReport, boolean>();
function asks(report: StatusReport): boolean {
  let value = asksCache.get(report);
  if (value === undefined) asksCache.set(report, (value = asksOwner(report.body)));
  return value;
}

function hasOpenQuestion(report: StatusReport, noteStatus: ReportStatus | null): boolean {
  return report.outdated_at === undefined && noteStatus !== "done" && asks(report);
}

function ownStatus(report: StatusReport, notes: readonly StatusNote[]): ReportStatus {
  if (report.outdated_at !== undefined) return "outdated";
  const own = notesStatus(notes);
  if (report.follow_up_of !== undefined && report.follow_up_of !== report.id && hasOpenQuestion(report, own))
    return "question";
  if (own !== null) return own;
  if (report.read_at === undefined) return "new";
  return asks(report) ? "question" : "read";
}

/** The follow-up below `report` that still waits for the owner's answer (#1657): the newest direct
 * one first, otherwise the first found further down the chain, newest branch first. */
function openQuestion<R extends StatusReport>(
  report: StatusReport,
  reports: readonly R[],
  notesOf: (r: R) => readonly StatusNote[],
  seen = new Set([report.id])
): R | undefined {
  const next = reports
    .filter((r) => r.follow_up_of === report.id && !seen.has(r.id))
    .sort((a, b) => b.created_at - a.created_at);
  for (const r of next) seen.add(r.id);
  const open = next.find((r) => hasOpenQuestion(r, notesStatus(notesOf(r))));
  if (open) return open;
  for (const r of next) {
    const deeper = openQuestion(r, reports, notesOf, seen);
    if (deeper) return deeper;
  }
  return undefined;
}

/** The report's own status and the link to an open question in its visible follow-ups. */
export function reportStatus<R extends StatusReport>(
  report: R,
  reports: readonly R[],
  notesOf: (r: R) => readonly StatusNote[]
): { status: ReportStatus; follow_up?: { id: string; title: string } } {
  const status = ownStatus(report, notesOf(report));
  const asked = openQuestion(report, reports, notesOf);
  return asked ? { status, follow_up: { id: asked.id, title: asked.title } } : { status };
}

/** `follow_up_of` as answers carry it: the report this one asks about, while the caller sees it. */
export function followUpOf(report: StatusReport, reports: readonly StatusReport[]) {
  const target = report.follow_up_of === undefined ? undefined : reports.find((r) => r.id === report.follow_up_of);
  return target ? { follow_up_of: { id: target.id, title: target.title } } : {};
}
