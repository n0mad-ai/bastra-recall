/**
 * Which lines of a Markdown text are code, one rule for every reader: the renderer (markdown.js), the
 * report blocks that keep tables out of code (sections/tasks-reports-model.js) and the daemon's
 * question status (task-report-status.ts), so a marker in code asks in none of them (#1656, #1662,
 * #1665). Types for it in code-lines.d.ts.
 *
 * - Fenced code: a line starting with ``` after any indentation opens a fence, the next such line
 *   closes it, an unclosed fence runs to the end. The lines between are code as written, less up to as
 *   many leading spaces as the opening fence is indented by.
 * - Indented code (as in CommonMark): lines indented by four spaces or a tab, after a blank line (or
 *   at the start) and outside a list. It cannot interrupt a paragraph, and an indented line inside a
 *   list (after an item, up to the next line at column 0) stays list text. Blank lines between
 *   indented lines belong to the code; the indentation is taken off. Inside it ``` is plain code.
 */

/** @typedef {{ fence: "open" | "close" } | { code: string } | null} CodeLine
 *  fence: an opening or closing fence line; code: a line of code as the reader shows it; null: no code. */

const FENCE = /^\s*```/;
const INDENT = /^(?: {4}| {0,3}\t)/;
// a list item as the renderer sees one (markdown.js)
const ITEM = /^\s*(?:[-*]|\d+\.)\s+/;
const blank = (line) => !line.trim();

/** The indented run starting at `start`: its lines into `out`, returns the index after its last line
 *  (blank lines after the last indented line are not part of it). */
function indentedRun(lines, start, out) {
  let end = start;
  for (let j = start; j < lines.length; j++) {
    if (!blank(lines[j])) {
      if (!INDENT.test(lines[j])) break;
      end = j;
    }
  }
  for (let j = start; j <= end; j++) out.push({ code: blank(lines[j]) ? "" : lines[j].replace(INDENT, "") });
  return end + 1;
}

/** One entry per line of `lines`. */
/** @returns {CodeLine[]} */
export function codeLines(lines) {
  const out = [];
  let fence = null,
    inList = false;
  for (let i = 0; i < lines.length;) {
    const line = lines[i++];
    if (fence) {
      fence = FENCE.test(line) ? null : fence;
      out.push(fence ? { code: line.replace(fence, "") } : { fence: "close" });
      continue;
    }
    if (!inList && INDENT.test(line) && !blank(line) && (i === 1 || blank(lines[i - 2]))) {
      i = indentedRun(lines, i - 1, out);
      continue;
    }
    // an indented fence takes its own indentation off its lines (as in CommonMark)
    fence = FENCE.test(line) ? new RegExp(`^ {0,${/^ */.exec(line)[0].length}}`) : null;
    out.push(fence ? { fence: "open" } : null);
    // a list goes on over blank and indented lines; any other line at column 0 ends it
    if (ITEM.test(line)) inList = true;
    else if (/^\S/.test(line)) inList = false;
  }
  return out;
}
