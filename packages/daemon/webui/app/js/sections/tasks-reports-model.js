// Task reports — pure model (no DOM; its one import is the reader's pure code-line rule): validates
// the daemon's list answer, orders it, counts unread reports, filters it by a search, splits Markdown
// into prose and pipe tables and validates the notes the owner left on a report. Tested in
// __tests__/webui-task-reports-model.test.ts.
import { codeLines } from "../views/code-lines.js";

const str = (v) => typeof v === "string" && v.trim() !== "";
const num = (v) => Number.isFinite(v) && v >= 0;
/** A positive whole count, else 0. */
const count = (v) => (Number.isInteger(v) && v > 0 ? v : 0);

/** One list row from the daemon, or null when its shape is off (external input). */
function row(x) {
  if (!x || typeof x !== "object" || !str(x.id) || !str(x.title) || !num(x.created_at)) return null;
  const open = count(x.notes_open);
  return {
    id: x.id,
    title: x.title,
    project: str(x.project) ? x.project : "",
    client: str(x.origin?.client) ? x.origin.client : "",
    session: str(x.origin?.session) ? x.origin.session : "",
    createdAt: x.created_at,
    readAt: num(x.read_at) ? x.read_at : null,
    // marked outdated (#1678): no longer waits to be read, listed last
    outdatedAt: num(x.outdated_at) ? x.outdated_at : null,
    notesOpen: open,
    // drafts: open notes not handed over to the agents yet (part of notesOpen)
    notesDraft: Math.min(count(x.notes_draft), open),
    ...stateFields(x),
  };
}

/** Waits to be read: unread and not outdated (#1678). */
export const isUnread = (r) => r.readAt === null && r.outdatedAt === null;
const group = (r) => (r.outdatedAt !== null ? 2 : r.readAt === null ? 0 : 1);
/** Unread first, then read, then outdated; newest first within each group. */
export const byUnread = (a, b) => group(a) - group(b) || b.createdAt - a.createdAt;

/** task_report_list answer → ordered rows; a broken answer yields an empty list. */
export function reportRows(answer) {
  const list = Array.isArray(answer?.reports) ? answer.reports : [];
  return list.map(row).filter(Boolean).sort(byUnread);
}

/** The deletes that can still be undone (task_report_list `deleted`, owner's UI only) as list rows
 *  with `until`, the end of their undo; a Recall without them or a broken entry gives none. */
export function deletedRows(answer) {
  const list = Array.isArray(answer?.deleted) ? answer.deleted : [];
  return list
    .map((x) => {
      const r = row(x);
      return r && num(x?.restorable_until) ? { ...r, until: x.restorable_until } : null;
    })
    .filter(Boolean);
}

/** The undo time left, split for the countdown in the list. */
export function leftParts(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return { d: Math.floor(s / 86400), h: Math.floor(s / 3600) % 24, m: Math.floor(s / 60) % 60, s: s % 60 };
}

/** The states with open business: notes with the owner or the agents, or a question waiting (Daniel
 *  18.11.2026). Their rows carry the status stripe on the left (css/tasks-reports.css). */
export const inWork = (r) => ["in_progress", "handed", "question"].includes(stateOf(r));

/** The projects in the list, by name, each with its number of reports (the project filter). */
export function projectsOf(rows) {
  const n = new Map();
  for (const r of rows) if (r.project) n.set(r.project, (n.get(r.project) ?? 0) + 1);
  return [...n].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count }));
}

/** The rows of one project; null keeps all. */
export const inProject = (rows, project) => (project === null ? rows : rows.filter((r) => r.project === project));

export const unreadCount = (rows) => rows.filter(isUnread).length;

/** Reports with notes the owner has not handed over yet (rail tooltip). */
export const draftReports = (rows) => rows.filter((r) => r.notesDraft > 0).length;

/** The two note counts of a report: drafts still with the owner, handed-over open ones with the agent. */
export const noteCounts = (notes) => ({
  drafts: notes.filter((n) => n.draft).length,
  handed: notes.filter((n) => !n.done && !n.draft).length,
});

/** "claude-code · s-12" — who filed the report. */
export const originText = (r) => [r.client, r.session].filter(Boolean).join(" · ");

/** Case and Unicode form never decide a match: "ÜBER", "über" and a decomposed "über" are one word. */
const fold = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase();

/** Search over the list (#1597): the rows whose title or project hold every word of the query,
 *  at once and here. The list rows carry no report text: `hits` are the ids the daemon found for
 *  the same query in title, project and text (task_report_list with query), joined in once they
 *  arrived (null: not yet, or a Recall without the text search). */
export function matchReports(rows, query, hits = null) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const hay = fold(`${r.title}\n${r.project}`);
    return words.every((w) => hay.includes(w)) || !!hits?.has(r.id);
  });
}

// ── Markdown blocks: the shared mini renderer has no tables, so pipe tables
// are cut out here and rendered as a text-only table; everything else stays
// one prose block for that renderer. Code (fenced or indented, as the renderer reads it:
// views/code-lines.js) is never searched for tables.
const PIPE = /^\s*\|.*\|\s*$/;
const RULE = /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/;
const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

function takeTable(lines, i) {
  if (!PIPE.test(lines[i]) || !RULE.test(lines[i + 1] ?? "")) return null;
  const head = cells(lines[i]),
    rows = [];
  let j = i + 2;
  while (j < lines.length && PIPE.test(lines[j])) rows.push(cells(lines[j++]));
  return { block: { kind: "table", head, rows }, next: j };
}

/** Markdown → [{ kind: "md", text } | { kind: "table", head, rows }] in order. */
export function reportBlocks(md) {
  const lines = String(md ?? "").split("\n"),
    code = codeLines(lines),
    out = [];
  let prose = [];
  const flush = () => {
    if (prose.length) out.push({ kind: "md", text: prose.join("\n") });
    prose = [];
  };
  for (let i = 0; i < lines.length;) {
    const table = code[i] ? null : takeTable(lines, i);
    if (table) {
      flush();
      out.push(table.block);
      i = table.next;
    } else prose.push(lines[i++]);
  }
  flush();
  return out;
}

// ── Notes on single places of a report (task_report_note_*). The anchor names
// the block: its kind, its 1-based number among the annotatable blocks of the
// rendered report and a short excerpt for an agent reading without the UI.
// A note is the owner's draft until handed over (handed_at); only then an agent sees it.
const NOTE_KINDS = ["heading", "paragraph", "item", "row"];
/** Longest excerpt the page sends; the daemon accepts up to 300 characters. */
const EXCERPT_MAX = 160;

/** Block text → one short line for the anchor. */
export function excerptOf(text) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX - 1)}…` : flat;
}

/** One stored note, or null when its shape is off (external input). */
function note(x) {
  const a = x?.anchor;
  if (!str(x?.id) || !str(x.text) || !num(x.created_at) || !a || !NOTE_KINDS.includes(a.kind)) return null;
  if (!Number.isInteger(a.index) || a.index < 1) return null;
  const done = x.state === "done";
  return {
    id: x.id,
    kind: a.kind,
    index: a.index,
    excerpt: typeof a.excerpt === "string" ? a.excerpt : "",
    text: x.text,
    done,
    draft: !done && !num(x.handed_at),
    at: num(x.updated_at) ? x.updated_at : x.created_at,
    doneAt: num(x.done_at) ? x.done_at : null,
    reply: str(x.reply) ? x.reply : "",
  };
}

/** task_report_read answer → its notes in the order they were left. */
export function noteRows(answer) {
  return (Array.isArray(answer?.notes) ? answer.notes : []).map(note).filter(Boolean);
}

// ── Questions with answer options (Daniel 18.11.2026): an agent ends a list item or a paragraph with
// "[? Option A | Option B]", e.g. "- Ship it now? [? Yes | No]". The marker is fixed syntax, never
// recognised by words, so it works in every language and still reads as plain text without the UI.
// 2 to 6 distinct options, separated by "|"; anything else stays text.
// An option is a button label, a short name such as "A – Build the command" (Daniel 18.11.2026: "not
// the long answers, only a short summary"); the explanation belongs in the question's own text. A
// longer name still becomes a button whose label wraps: a 40-character limit left real questions
// without buttons (Daniel 25.11.2026: "must not happen again"). OPTION_MAX only keeps a whole
// paragraph out of a button. An option is never cut: past the limit the whole line stays plain
// text, and task_report_save names such lines to the agent (task-report-status.ts questionCheck).
// A backslash before the marker ("\[? Yes | No]") makes it text too (#1652); the reader then shows
// it without the backslash. So does a marker joined to the text before it ("Matrix[?a|b]", #1717): it
// needs a space before it or a line of its own. The daemon's question status reads the same options (#1656).
const ASK = /\[\?([^[\]]*)\]\s*$/;
const ASK_MAX = 6;
export const OPTION_MAX = 120;

/** The inside of a marker ("A – Keep | B – Remove") → its options, or null when they do not fit. */
export function optionsOf(inner) {
  const options = String(inner)
    .split("|")
    .map((o) => o.trim());
  const fits = options.length >= 2 && options.length <= ASK_MAX && options.every((o) => o && o.length <= OPTION_MAX);
  return fits && new Set(options).size === options.length ? options : null;
}

/** Block text → { question, options, at } (at: where the marker starts), or null. A marker on its
 * own can use the preceding prose block as its question. A second marker cannot reuse that block. */
export function askOf(text, previous = "") {
  const m = ASK.exec(String(text ?? ""));
  if (!m || (m.index > 0 && !/\s/.test(text[m.index - 1]))) return null;
  const options = optionsOf(m[1]);
  const question = text.slice(0, m.index).trim() || (ASK.test(previous) ? "" : previous.trim());
  return options && question ? { question, options, at: m.index } : null;
}

/** Text ending in an escaped marker "\[? … ]" → the same text without that backslash. */
export const unescapeAsk = (text) => text.replace(/\\(\[\?[^[\]]*\]\s*)$/, "$1");

/** An option as its answer field shows it (Daniel 18.11.2026, draft D): the key in a small frame on
 *  top, the name below. "A – Keep" names its own key (one to three characters, then a dash, the
 *  syntax the agents are told); any other option gets the letter of its place (A, B, …). */
export function optionParts(option, i) {
  const m = /^(\S{1,3})\s+[–—-]\s+(\S[\s\S]*)$/.exec(option);
  return m ? { key: m[1], name: m[2] } : { key: String.fromCharCode(65 + i), name: option };
}

/** The notes left on one block: kind and number name the place, and the stored excerpt must still be
 *  the block's text (#1608). Should the rendering of a report ever change, a note whose block now holds
 *  other text is collected at the end instead of sitting silently at a wrong place. */
export const notesAt = (notes, kind, index, excerpt) =>
  notes.filter((n) => n.kind === kind && n.index === index && n.excerpt === excerpt);

/** What the owner answered on a question, from the notes at its place: `pick` is the latest note
 *  whose text is exactly one of the options or the "needs clarification" text (its option is
 *  `picked`), `own` says whether any other note (an own answer) is there. */
export function answerAt(options, notes, clarify) {
  const pick = notes.findLast((n) => options.includes(n.text) || n.text === clarify) ?? null;
  return { picked: pick?.text ?? null, pick, own: notes.some((n) => !options.includes(n.text) && n.text !== clarify) };
}

/** The jump list's "you are here": the last of the places (in reading order) whose top has passed
 *  `line` (pixels below the top of the reading area); the first one while none has. -1 for none. */
export function hereIndex(tops, line) {
  let at = tops.length ? 0 : -1;
  tops.forEach((top, i) => {
    if (top <= line) at = i;
  });
  return at;
}

// ── The one state a report shows (Daniel 18.11.2026). The daemon derives it (task-report-status.ts);
// the UI only shows it. A Recall from before it sends none: then the state follows the old rule.
const STATES = ["new", "read", "in_progress", "handed", "question", "done", "outdated"];
/** { id, title } of a linked report, or null when the shape is off (external input). */
const linkOf = (x) => (x && typeof x === "object" && str(x.id) && str(x.title) ? { id: x.id, title: x.title } : null);

/** The state fields of one list entry: status, the follow-up a question waits on, the report a
 *  follow-up asks about. */
function stateFields(x) {
  const status = STATES.includes(x.status) ? x.status : null;
  return {
    status,
    followUp: status === "question" ? linkOf(x.follow_up) : null,
    followUpOf: linkOf(x.follow_up_of),
  };
}

/** The state to show: the daemon's, else outdated, open notes → in_progress, unread → new, else read. */
export function stateOf(r) {
  if (r.status) return r.status;
  if (r.outdatedAt !== null) return "outdated";
  if (r.notesOpen > 0) return "in_progress";
  return r.readAt === null ? "new" : "read";
}

// ── The status filter above the list (Daniel 26.11.2026): "by default only those that need my
// attention". Each state is one switch; the list shows the reports whose state is switched on, read,
// done and outdated reports each as a group of their own below the open ones.
/** Every state the filter offers, in its order: first those that wait on the owner, then the rest. */
export const FILTER_STATES = ["new", "question", "in_progress", "handed", "read", "done", "outdated"];
/** On by default. New and Question wait for the owner; In progress holds notes they have not handed over
 *  yet; Handed over is open with an agent and still owes them an answer. Read, done and outdated reports
 *  ask nothing of them. */
export const ATTENTION = ["new", "question", "in_progress", "handed"];
/** The list's groups in their order: the open reports, then one group per filed-away state. */
export const REPORT_GROUPS = ["open", "read", "done", "outdated"];
export const groupOf = (r) => (ATTENTION.includes(stateOf(r)) ? "open" : stateOf(r));

/** How many of `rows` are in each state (the filter's counts). */
export function stateCounts(rows) {
  const n = Object.fromEntries(FILTER_STATES.map((s) => [s, 0]));
  for (const r of rows) n[stateOf(r)] += 1;
  return n;
}

/** The rows whose state is in `on`; a row `keep` names stays whatever its state (the open report). */
export const inStates = (rows, on, keep = () => false) => rows.filter((r) => on.has(stateOf(r)) || keep(r));

/** The rows by group, in REPORT_GROUPS order, each in the order it had; empty groups are left out. */
export const grouped = (rows) =>
  REPORT_GROUPS.map((group) => ({ group, rows: rows.filter((r) => groupOf(r) === group) })).filter(
    (g) => g.rows.length
  );
