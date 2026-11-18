/** Task reports: an agent's final report for the owner, filed after larger or
 * autonomous work instead of a long chat answer. The owner reads it in the
 * Tasks area of the Recall UI, marks it read or unread there by hand (reading
 * the body never changes that state, neither for the UI nor for an agent) and
 * deletes it when done (undone within RESTORE_WINDOW_MS). While reading, the owner can leave notes on single
 * places of a report (heading, paragraph, list item, table row); they live in
 * the report's record and go with it on delete. A note is the owner's draft
 * until the owner hands the report's drafts over to the agents in one click;
 * only then does an agent see it (session start names the handed-over open
 * ones, read and list show nothing else) and mark it done with a short reply.
 * Not bound to a task
 * run (executor reports are, see task-app-api.ts) and no action authority.
 * One app record next to the task snapshot; visibility follows the task
 * domain rule (every owner domain must belong to the caller). */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { redactSecrets, scrubInjectedBlocks } from "@bastra-recall/core/scrub";
import { readAppRecord, writeAppRecord } from "./app-record-store.js";
import { withPathLock } from "./path-lock.js";
import { authenticateTask, type TaskPrincipal } from "./task-auth.js";
import { cleanText } from "./task-store.js";
import { MAX_BODY_BYTES } from "./http-util.js";

/** Nothing piles up silently: past this the agent is told, nothing is dropped. */
export const TASK_REPORT_LIMIT = 200;
const STORE_MAX_BYTES = 16 * 1024 * 1024;
const NAMESPACE = "task-reports";

const line = (max: number) => z.string().max(max).regex(/\S/);
export const taskReportSaveInput = z.strictObject({
  title: line(200),
  body: line(MAX_BODY_BYTES),
  project: line(120).optional(),
  origin: z.strictObject({ client: line(120), session: line(200).optional() }),
});
const idInput = z.strictObject({ id: z.string().uuid() });
/** Words to find in title, project and text (#1597); every word must occur. */
const listInput = z.strictObject({ query: z.string().max(200).optional() });
const markInput = z.strictObject({ id: z.string().uuid(), read: z.boolean() });
/** A note is the owner's own text (external input): bounded, never shortened. */
export const NOTE_MAX_CHARS = 4000;
const REPLY_MAX_CHARS = 1000;
/** The block kinds the reading view lets the owner annotate. */
const NOTE_KINDS = ["heading", "paragraph", "item", "row"] as const;
/** Where a note sits: the block's kind, its running number among the annotatable
 * blocks of the rendered report (1-based) and a short excerpt, so an agent finds
 * the place without the UI. */
const anchorInput = z.strictObject({
  kind: z.enum(NOTE_KINDS),
  index: z.number().int().min(1).max(100_000),
  excerpt: line(300),
});
const noteRef = { id: z.string().uuid(), note_id: z.string().uuid() };
const noteAddInput = z.strictObject({ id: z.string().uuid(), anchor: anchorInput, text: line(NOTE_MAX_CHARS) });
const noteEditInput = z.strictObject({ ...noteRef, text: line(NOTE_MAX_CHARS) });
const noteDeleteInput = z.strictObject(noteRef);
const noteDoneInput = z.strictObject({ ...noteRef, reply: line(REPLY_MAX_CHARS).optional() });
export const TASK_REPORT_INPUTS = {
  task_report_save: taskReportSaveInput,
  task_report_list: listInput,
  task_report_read: idInput,
  task_report_mark: markInput,
  task_report_delete: idInput,
  task_report_restore: idInput,
  task_report_note_add: noteAddInput,
  task_report_note_edit: noteEditInput,
  task_report_note_delete: noteDeleteInput,
  task_report_note_done: noteDoneInput,
  task_report_notes_hand: idInput,
};
export type TaskReportOperation = keyof typeof TASK_REPORT_INPUTS;

// The stored records tolerate fields a later version adds (#1611): such a field is kept as it
// is on every write (looseObject), so going back one version neither locks the store nor drops
// the field, and it never leaves through an answer (the strip-mode shapes below project it away).
const anchorShape = { kind: z.enum(NOTE_KINDS), index: z.number().int().min(1), excerpt: z.string() };
const noteShape = {
  id: z.string().uuid(),
  text: z.string(),
  actor: z.string(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative().optional(),
  state: z.enum(["open", "done"]),
  /** When the owner handed the note over to the agents; absent = still the owner's draft
   * (notes from before the hand-over existed count as drafts too). */
  handed_at: z.number().int().nonnegative().optional(),
  done_at: z.number().int().nonnegative().optional(),
  reply: z.string().optional(),
  done_by: z.string().optional(),
};
const noteSchema = z.looseObject({ ...noteShape, anchor: z.looseObject(anchorShape) });
type ReportNote = z.infer<typeof noteSchema>;
/** A note as answers carry it: the known fields only. */
const noteOut = z.object({ ...noteShape, anchor: z.object(anchorShape) });
const shownNote = (n: ReportNote) => noteOut.parse(n);

const reportSchema = z.looseObject({
  id: z.string().uuid(),
  title: z.string(),
  body: z.string(),
  project: z.string().optional(),
  origin: z.looseObject({ client: z.string(), session: z.string().optional() }),
  actor: z.string(),
  owner_domains: z.array(z.string()).min(1),
  created_at: z.number().int().nonnegative(),
  read_at: z.number().int().nonnegative().optional(),
  /** Optional: reports from before notes existed have none. */
  notes: z.array(noteSchema).optional(),
});
type TaskReport = z.infer<typeof reportSchema>;
const storeSchema = z.looseObject({ version: z.literal(1), reports: z.array(reportSchema) });
type ReportStore = z.infer<typeof storeSchema>;

export interface ReportContext {
  path: string;
  authPath: string;
  now?: () => number;
  /** Set only by the owner's UI session route (task-ui-session.ts), never from request data. */
  ownerUi?: boolean;
}

/** Note texts reach later sessions as the user's own instructions, so only the
 * owner's UI writes them and hands them over. The UI holds the same agent credential
 * an agent has; the route, not the credential, is the proof. Agents read handed-over
 * notes and mark them done. */
export const OWNER_UI_REPORT_OPERATIONS: readonly TaskReportOperation[] = [
  "task_report_note_add",
  "task_report_note_edit",
  "task_report_note_delete",
  "task_report_notes_hand",
];

const storePath = (ctx: ReportContext) => join(dirname(ctx.path), "task-reports.json");
const visible = (r: TaskReport, p: TaskPrincipal) => r.owner_domains.every((d) => p.domains.includes(d));
const notFound = () => Object.assign(new Error("Report absent in authorized domains"), { code: "not_found" });

/** Secrets redacted like task text; line breaks and tabs stay, so Markdown and code keep their shape. */
function cleanBody(value: string): string {
  return redactSecrets(scrubInjectedBlocks(value).text, homedir()).text.replace(/[\p{Cc}\p{Cf}]/gu, (c) =>
    c === "\n" || c === "\t" ? c : ""
  );
}

function readStore(path: string): ReportStore {
  let text: string;
  try {
    text = readAppRecord(NAMESPACE, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, reports: [] };
    throw error;
  }
  const parsed = storeSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw Object.assign(new Error("Task report store unreadable"), { code: "corrupt" });
  return parsed.data;
}
const readReports = (path: string) => readStore(path).reports;
const storeFull = () => Object.assign(new Error("Task report store full"), { code: "capacity" });

/** Read-modify-write under a cross-process lock: MCP clients and the daemon may write at once.
 * Fields of the store a later version added are written back as they were. `written` runs once
 * the store is on disk, still under the lock. */
function changeReports<T>(path: string, change: (reports: TaskReport[]) => T, written?: () => void): Promise<T> {
  return withPathLock(
    path,
    async () => {
      const store = readStore(path);
      const result = change(store.reports);
      const payload = JSON.stringify(store);
      if (Buffer.byteLength(payload) > STORE_MAX_BYTES) throw storeFull();
      writeAppRecord(NAMESPACE, path, payload);
      written?.();
      return result;
    },
    { crossProcess: true, requireLock: true }
  );
}

// ── Undo for delete (#1559): a deleted report waits in a record of its own for RESTORE_WINDOW_MS,
// then restore puts it back with text, read state and notes. Apart from the report store, so an
// older daemon still reads that store; never listed or read. Expired entries leave the disk on the
// next list, delete or restore (#1614). Written only under the report store's lock.
export const RESTORE_WINDOW_MS = 10 * 60 * 1000;
const TRASH_NAMESPACE = "task-report-trash";
/** The latest deletes that can be undone; older ones are gone for good. */
const TRASH_MAX = 20;
const trashSchema = z.looseObject({
  version: z.literal(1),
  deleted: z.array(z.looseObject({ deleted_at: z.number().int().nonnegative(), report: reportSchema })),
});
type Deleted = z.infer<typeof trashSchema>["deleted"][number];
const trashPath = (ctx: ReportContext) => join(dirname(ctx.path), "task-report-trash.json");

/** Every entry as stored, expired ones included. */
function readTrashRecord(path: string): Deleted[] {
  let text: string;
  try {
    text = readAppRecord(TRASH_NAMESPACE, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = trashSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw Object.assign(new Error("Task report trash unreadable"), { code: "corrupt" });
  return parsed.data.deleted;
}

const live = (d: Deleted, now: number) => d.deleted_at + RESTORE_WINDOW_MS > now;

/** The deletes still in their window. */
const readTrash = (path: string, now: number) => readTrashRecord(path).filter((d) => live(d, now));

/** True when the trash holds an entry past its window; an unreadable trash counts as nothing to drop. */
function hasExpired(path: string, now: number): boolean {
  try {
    return readTrashRecord(path).some((d) => !live(d, now));
  } catch {
    return false;
  }
}

/** #1614: an expired entry (report text, notes) leaves the disk instead of waiting for the next
 * delete. Checked without the lock, rewritten under the store's lock only when something expired.
 * Cleanup never fails the call it runs in; an unreadable trash stays untouched. */
async function pruneTrash(ctx: ReportContext, now: number): Promise<void> {
  const path = trashPath(ctx);
  if (!hasExpired(path, now)) return;
  try {
    await withPathLock(
      storePath(ctx),
      async () => {
        if (hasExpired(path, now)) writeTrash(path, readTrash(path, now));
      },
      { crossProcess: true, requireLock: true }
    );
  } catch {
    /* the next list, delete or restore tries again */
  }
}

/** Keep the latest deletes. A byte-capacity failure leaves earlier undo entries intact. */
function writeTrash(path: string, deleted: Deleted[]) {
  const payload = JSON.stringify({ version: 1, deleted: deleted.slice(-TRASH_MAX) });
  if (Buffer.byteLength(payload) > STORE_MAX_BYTES) throw storeFull();
  writeAppRecord(TRASH_NAMESPACE, path, payload);
}

/** Keeps a deleted report for undo. An unreadable trash stays untouched and does
 * not block deletion, but exceeding the byte limit leaves the report active. */
function keepDeleted(path: string, report: TaskReport, now: number): boolean {
  try {
    writeTrash(path, [...readTrash(path, now), { deleted_at: now, report }]);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "capacity") throw error;
    return false;
  }
}

/** A draft is the owner's alone: an agent neither sees it nor counts it nor closes it. */
const isDraft = (n: ReportNote) => n.state === "open" && n.handed_at === undefined;
/** The notes this caller sees: the owner's UI all of them, an agent the handed-over and done ones. */
const notesFor = (r: TaskReport, owner: boolean) => (r.notes ?? []).filter((n) => owner || !isDraft(n)).map(shownNote);
const handedOpen = (r: TaskReport) => (r.notes ?? []).filter((n) => n.state === "open" && !isDraft(n));
const isOwner = (ctx: ReportContext) => ctx.ownerUi === true;

/** notes_open: open notes the caller sees; notes_draft (owner's UI only): those not handed over yet. */
function meta(r: TaskReport, owner: boolean) {
  const notes = notesFor(r, owner);
  const open = notes.filter((n) => n.state === "open").length;
  const drafts = notes.filter(isDraft).length;
  return {
    id: r.id,
    title: r.title,
    ...(r.project === undefined ? {} : { project: r.project }),
    origin: {
      client: r.origin.client,
      ...(r.origin.session === undefined ? {} : { session: r.origin.session }),
    },
    actor: r.actor,
    created_at: r.created_at,
    ...(r.read_at === undefined ? {} : { read_at: r.read_at }),
    bytes: Buffer.byteLength(r.body),
    ...(open === 0 ? {} : { notes_open: open }),
    ...(drafts === 0 ? {} : { notes_draft: drafts }),
  };
}

/** Unread first, newest first within each group. */
const order = (a: TaskReport, b: TaskReport) =>
  Number(a.read_at !== undefined) - Number(b.read_at !== undefined) || b.created_at - a.created_at;

function saveReport(ctx: ReportContext, principal: TaskPrincipal, raw: unknown) {
  const input = taskReportSaveInput.parse(raw);
  const report: TaskReport = {
    id: randomUUID(),
    title: cleanText(input.title).replace(/\s+/g, " ").trim(),
    body: cleanBody(input.body),
    ...(input.project === undefined ? {} : { project: cleanText(input.project).trim() }),
    origin: {
      client: cleanText(input.origin.client),
      ...(input.origin.session === undefined ? {} : { session: cleanText(input.origin.session) }),
    },
    actor: principal.actor_id,
    owner_domains: [...principal.domains],
    created_at: (ctx.now ?? Date.now)(),
  };
  return changeReports(storePath(ctx), (reports) => {
    if (reports.length >= TASK_REPORT_LIMIT)
      throw Object.assign(new Error("Task report limit reached"), { code: "capacity" });
    reports.push(report);
    return meta(report, isOwner(ctx));
  });
}

/** Reading is side-effect free: an agent opening a report must not mark it read for the owner. */
function readReport(ctx: ReportContext, principal: TaskPrincipal, id: string) {
  const report = readReports(storePath(ctx)).find((r) => r.id === id && visible(r, principal));
  if (!report) throw notFound();
  const owner = isOwner(ctx);
  return { ...meta(report, owner), body: report.body, notes: notesFor(report, owner) };
}

/** Idempotent: read=true keeps the first read time, read=false puts the report back to unread. */
function markReport(ctx: ReportContext, principal: TaskPrincipal, id: string, read: boolean) {
  return changeReports(storePath(ctx), (reports) => {
    const report = reports.find((r) => r.id === id && visible(r, principal));
    if (!report) throw notFound();
    if (read) report.read_at ??= (ctx.now ?? Date.now)();
    else delete report.read_at;
    return meta(report, isOwner(ctx));
  });
}

/** restorable_until: until when task_report_restore brings the report back (absent: no undo). */
function deleteReport(ctx: ReportContext, principal: TaskPrincipal, id: string) {
  const now = (ctx.now ?? Date.now)();
  return changeReports(storePath(ctx), (reports) => {
    const index = reports.findIndex((r) => r.id === id && visible(r, principal));
    if (index < 0) throw notFound();
    const [gone] = reports.splice(index, 1);
    const kept = keepDeleted(trashPath(ctx), gone!, now);
    return { deleted: true, id, ...(kept ? { restorable_until: now + RESTORE_WINDOW_MS } : {}) };
  });
}

/** Undo a delete within its window: the report returns as it was. The report limit holds here
 * too. The trash entry leaves only once the report is back in the store. */
async function restoreReport(ctx: ReportContext, principal: TaskPrincipal, raw: unknown) {
  const { id } = idInput.parse(raw);
  const now = (ctx.now ?? Date.now)();
  const path = trashPath(ctx);
  const trash = () => readTrash(path, now);
  // An expired entry is refused below; its data leaves the disk first (#1614).
  await pruneTrash(ctx, now);
  return changeReports(
    storePath(ctx),
    (reports) => {
      const entry = trash().find((d) => d.report.id === id && visible(d.report, principal));
      if (!entry) throw notFound();
      if (!reports.some((r) => r.id === id)) {
        if (reports.length >= TASK_REPORT_LIMIT)
          throw Object.assign(new Error("Task report limit reached"), { code: "capacity" });
        reports.push(entry.report);
      }
      return meta(entry.report, isOwner(ctx));
    },
    () => {
      // The report is back either way; a stale entry is dropped by the next restore or delete.
      try {
        writeTrash(
          path,
          trash().filter((d) => d.report.id !== id)
        );
      } catch {
        /* see above */
      }
    }
  );
}

/** One open note on a block of the report. Adding a note leaves the read state alone. */
function addNote(ctx: ReportContext, principal: TaskPrincipal, raw: unknown) {
  const input = noteAddInput.parse(raw);
  const note: ReportNote = {
    id: randomUUID(),
    anchor: {
      kind: input.anchor.kind,
      index: input.anchor.index,
      excerpt: cleanText(input.anchor.excerpt).replace(/\s+/g, " ").trim(),
    },
    text: cleanBody(input.text),
    actor: principal.actor_id,
    created_at: (ctx.now ?? Date.now)(),
    state: "open",
  };
  return changeReport(ctx, principal, input.id, (report) => {
    (report.notes ??= []).push(note);
    return { report: meta(report, true), note };
  });
}

/** The owner rewrites a note. A changed note is a new instruction: it opens again as a draft
 * and reaches an agent only once it is handed over again. */
function editNote(ctx: ReportContext, principal: TaskPrincipal, raw: unknown) {
  const input = noteEditInput.parse(raw);
  return changeNote(ctx, principal, input, (note) => {
    note.text = cleanBody(input.text);
    note.updated_at = (ctx.now ?? Date.now)();
    note.state = "open";
    delete note.handed_at;
    delete note.done_at;
    delete note.reply;
    delete note.done_by;
  });
}

/** An agent finished what the note asked for; the short reply shows under the note.
 * A draft is not there for an agent, so it cannot be closed either. */
function finishNote(ctx: ReportContext, principal: TaskPrincipal, raw: unknown) {
  const input = noteDoneInput.parse(raw);
  return changeNote(ctx, principal, input, (note) => {
    if (isDraft(note)) throw noteNotFound();
    note.state = "done";
    note.done_at = (ctx.now ?? Date.now)();
    note.done_by = principal.actor_id;
    if (input.reply === undefined) delete note.reply;
    else note.reply = cleanBody(input.reply);
  });
}

function deleteNote(ctx: ReportContext, principal: TaskPrincipal, raw: unknown) {
  const input = noteDeleteInput.parse(raw);
  return changeReport(ctx, principal, input.id, (report) => {
    const at = (report.notes ?? []).findIndex((n) => n.id === input.note_id);
    if (at < 0) throw noteNotFound();
    report.notes!.splice(at, 1);
    if (report.notes!.length === 0) delete report.notes;
    return { deleted: true, id: input.note_id, report: meta(report, true) };
  });
}

/** "Hand over to agent": every draft of one report reaches the agents at once (the owner's
 * click is the go-ahead; nothing further is asked). Returns all notes for the UI. */
function handNotes(ctx: ReportContext, principal: TaskPrincipal, raw: unknown) {
  const { id } = idInput.parse(raw);
  const at = (ctx.now ?? Date.now)();
  return changeReport(ctx, principal, id, (report) => {
    const drafts = (report.notes ?? []).filter(isDraft);
    for (const note of drafts) note.handed_at = at;
    return { handed: drafts.length, report: meta(report, true), notes: (report.notes ?? []).map(shownNote) };
  });
}

const noteNotFound = () => Object.assign(new Error("Report note absent"), { code: "not_found" });

function changeReport<T>(ctx: ReportContext, principal: TaskPrincipal, id: string, change: (r: TaskReport) => T) {
  return changeReports(storePath(ctx), (reports) => {
    const report = reports.find((r) => r.id === id && visible(r, principal));
    if (!report) throw notFound();
    return change(report);
  });
}

function changeNote(
  ctx: ReportContext,
  principal: TaskPrincipal,
  ref: { id: string; note_id: string },
  change: (note: ReportNote) => void
) {
  return changeReport(ctx, principal, ref.id, (report) => {
    const note = report.notes?.find((n) => n.id === ref.note_id);
    if (!note) throw noteNotFound();
    change(note);
    return { report: meta(report, isOwner(ctx)), note: shownNote(note) };
  });
}

/** Reports in the caller's domains with open notes the owner handed over, latest hand-over
 * first (session start: what the owner gave an agent to do). Drafts are never named. */
export function reportsWithHandedNotes(ctx: ReportContext, principal: TaskPrincipal) {
  const latest = (r: TaskReport) => Math.max(...handedOpen(r).map((n) => n.handed_at!));
  return readReports(storePath(ctx))
    .filter((r) => visible(r, principal) && handedOpen(r).length > 0)
    .sort((a, b) => latest(b) - latest(a))
    .map((r) => ({
      id: r.id,
      title: r.title,
      ...(r.project === undefined ? {} : { project: r.project }),
      open: handedOpen(r).length,
    }));
}

/** Case and Unicode form never decide a match (as in the UI's list search). */
const fold = (s: string) => s.normalize("NFKC").toLowerCase();
/** Every word of the query occurs in title, project or text; an empty query matches all. */
function matches(r: TaskReport, query: string | undefined) {
  const words = fold(query ?? "")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return true;
  const hay = fold(`${r.title}\n${r.project ?? ""}\n${r.body}`);
  return words.every((w) => hay.includes(w));
}

async function listReports(ctx: ReportContext, principal: TaskPrincipal, raw: unknown) {
  const { query } = listInput.parse(raw);
  await pruneTrash(ctx, (ctx.now ?? Date.now)());
  const reports = readReports(storePath(ctx))
    .filter((r) => visible(r, principal) && matches(r, query))
    .sort(order);
  const owner = isOwner(ctx);
  return { reports: reports.map((r) => meta(r, owner)), unread: reports.filter((r) => r.read_at === undefined).length };
}

const HANDLERS: Record<TaskReportOperation, (ctx: ReportContext, principal: TaskPrincipal, raw: unknown) => unknown> = {
  task_report_save: saveReport,
  task_report_list: listReports,
  task_report_read: (ctx, p, raw) => readReport(ctx, p, idInput.parse(raw).id),
  task_report_mark: (ctx, p, raw) => {
    const input = markInput.parse(raw);
    return markReport(ctx, p, input.id, input.read);
  },
  task_report_delete: (ctx, p, raw) => deleteReport(ctx, p, idInput.parse(raw).id),
  task_report_restore: restoreReport,
  task_report_note_add: addNote,
  task_report_note_edit: editNote,
  task_report_note_delete: deleteNote,
  task_report_note_done: finishNote,
  task_report_notes_hand: handNotes,
};

export async function callTaskReport(
  ctx: ReportContext,
  authorization: string | undefined,
  operation: TaskReportOperation,
  raw: unknown
): Promise<unknown> {
  const principal = await authenticateTask(authorization, ctx.authPath);
  if (OWNER_UI_REPORT_OPERATIONS.includes(operation) && ctx.ownerUi !== true)
    throw Object.assign(new Error("Report notes are written in the owner's UI only"), { code: "forbidden" });
  return HANDLERS[operation](ctx, principal, raw);
}

export const isTaskReportOperation = (name: string): name is TaskReportOperation =>
  Object.hasOwn(TASK_REPORT_INPUTS, name);
