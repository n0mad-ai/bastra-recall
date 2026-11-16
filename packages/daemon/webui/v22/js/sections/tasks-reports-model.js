// Task reports — pure model (no DOM, no imports): validates the daemon's list
// answer, orders it, counts unread reports and splits Markdown into prose and
// pipe tables. Tested in __tests__/v22-task-reports-model.test.ts.

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
