// Task reports — pure model (no DOM, no imports): validates the daemon's list
// answer, orders it, counts unread reports, splits Markdown into prose and
// pipe tables and validates the notes the owner left on a report. Tested in __tests__/v22-task-reports-model.test.ts.

const str = (v) => typeof v === "string" && v.trim() !== "";
const num = (v) => Number.isFinite(v) && v >= 0;

/** One list row from the daemon, or null when its shape is off (external input). */
function row(x) {
  if (!x || typeof x !== "object" || !str(x.id) || !str(x.title) || !num(x.created_at)) return null;
  return {
    id: x.id,
    title: x.title,
    project: str(x.project) ? x.project : "",
    client: str(x.origin?.client) ? x.origin.client : "",
    session: str(x.origin?.session) ? x.origin.session : "",
    createdAt: x.created_at,
    readAt: num(x.read_at) ? x.read_at : null,
    notesOpen: Number.isInteger(x.notes_open) && x.notes_open > 0 ? x.notes_open : 0,
  };
}

/** Unread first, newest first within each group. */
export const byUnread = (a, b) => Number(a.readAt !== null) - Number(b.readAt !== null) || b.createdAt - a.createdAt;

/** task_report_list answer → ordered rows; a broken answer yields an empty list. */
export function reportRows(answer) {
  const list = Array.isArray(answer?.reports) ? answer.reports : [];
  return list.map(row).filter(Boolean).sort(byUnread);
}

export const unreadCount = (rows) => rows.filter((r) => r.readAt === null).length;

/** "claude-code · s-12" — who filed the report. */
export const originText = (r) => [r.client, r.session].filter(Boolean).join(" · ");

// ── Markdown blocks: the shared mini renderer has no tables, so pipe tables
// are cut out here and rendered as a text-only table; everything else stays
// one prose block for that renderer. Fenced code is never searched for tables.
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
    out = [];
  let prose = [],
    fence = false;
  const flush = () => {
    if (prose.length) out.push({ kind: "md", text: prose.join("\n") });
    prose = [];
  };
  for (let i = 0; i < lines.length;) {
    if (/^\s*```/.test(lines[i])) fence = !fence;
    const table = fence ? null : takeTable(lines, i);
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
  return {
    id: x.id,
    kind: a.kind,
    index: a.index,
    excerpt: typeof a.excerpt === "string" ? a.excerpt : "",
    text: x.text,
    done: x.state === "done",
    at: num(x.updated_at) ? x.updated_at : x.created_at,
    doneAt: num(x.done_at) ? x.done_at : null,
    reply: str(x.reply) ? x.reply : "",
  };
}

/** task_report_read answer → its notes in the order they were left. */
export function noteRows(answer) {
  return (Array.isArray(answer?.notes) ? answer.notes : []).map(note).filter(Boolean);
}

/** The notes left on one block. */
export const notesAt = (notes, kind, index) => notes.filter((n) => n.kind === kind && n.index === index);
