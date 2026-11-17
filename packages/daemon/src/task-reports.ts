/** Task reports: an agent's final report for the owner, filed after larger or
 * autonomous work instead of a long chat answer. The owner reads it in the
 * Tasks area of the Recall UI, marks it read or unread there by hand (reading
 * the body never changes that state, neither for the UI nor for an agent) and
 * deletes it when done. While reading, the owner can leave notes on single
 * places of a report (heading, paragraph, list item, table row); they live in
 * the report's record, go with it on delete, and an agent marks them done with
 * a short reply (session start names the open ones). Not bound to a task
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
  task_report_list: z.strictObject({}),
  task_report_read: idInput,
  task_report_mark: markInput,
  task_report_delete: idInput,
  task_report_note_add: noteAddInput,
  task_report_note_edit: noteEditInput,
  task_report_note_delete: noteDeleteInput,
  task_report_note_done: noteDoneInput,
};
export type TaskReportOperation = keyof typeof TASK_REPORT_INPUTS;

const noteSchema = z.strictObject({
  id: z.string().uuid(),
  anchor: z.strictObject({ kind: z.enum(NOTE_KINDS), index: z.number().int().min(1), excerpt: z.string() }),
  text: z.string(),
  actor: z.string(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative().optional(),
  state: z.enum(["open", "done"]),
  done_at: z.number().int().nonnegative().optional(),
  reply: z.string().optional(),
  done_by: z.string().optional(),
});
type ReportNote = z.infer<typeof noteSchema>;

const reportSchema = z.strictObject({
  id: z.string().uuid(),
  title: z.string(),
  body: z.string(),
  project: z.string().optional(),
  origin: z.strictObject({ client: z.string(), session: z.string().optional() }),
  actor: z.string(),
  owner_domains: z.array(z.string()).min(1),
  created_at: z.number().int().nonnegative(),
  read_at: z.number().int().nonnegative().optional(),
  /** Optional: reports from before notes existed have none. */
  notes: z.array(noteSchema).optional(),
});
type TaskReport = z.infer<typeof reportSchema>;
const storeSchema = z.strictObject({ version: z.literal(1), reports: z.array(reportSchema) });

export interface ReportContext {
  path: string;
  authPath: string;
  now?: () => number;
  /** Set only by the owner's UI session route (task-ui-session.ts), never from request data. */
  ownerUi?: boolean;
}

/** Note texts reach later sessions as the user's own instructions, so only the
 * owner's UI writes them. The UI holds the same agent credential an agent has;
 * the route, not the credential, is the proof. Agents read notes and mark them done. */
export const OWNER_UI_REPORT_OPERATIONS: readonly TaskReportOperation[] = [
  "task_report_note_add",
  "task_report_note_edit",
  "task_report_note_delete",
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

function readReports(path: string): TaskReport[] {
  let text: string;
  try {
    text = readAppRecord(NAMESPACE, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = storeSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw Object.assign(new Error("Task report store unreadable"), { code: "corrupt" });
  return parsed.data.reports;
}

/** Read-modify-write under a cross-process lock: MCP clients and the daemon may write at once. */
function changeReports<T>(path: string, change: (reports: TaskReport[]) => T): Promise<T> {
  return withPathLock(
    path,
    async () => {
      const reports = readReports(path);
      const result = change(reports);
      const payload = JSON.stringify({ version: 1, reports });
      if (Buffer.byteLength(payload) > STORE_MAX_BYTES)
        throw Object.assign(new Error("Task report store full"), { code: "capacity" });
      writeAppRecord(NAMESPACE, path, payload);
      return result;
    },
    { crossProcess: true, requireLock: true }
  );
}

const openNotes = (r: TaskReport) => (r.notes ?? []).filter((n) => n.state === "open").length;

function meta(r: TaskReport) {
  const open = openNotes(r);
  return {
    id: r.id,
    title: r.title,
    ...(r.project === undefined ? {} : { project: r.project }),
    origin: r.origin,
    actor: r.actor,
    created_at: r.created_at,
    ...(r.read_at === undefined ? {} : { read_at: r.read_at }),
    bytes: Buffer.byteLength(r.body),
    ...(open === 0 ? {} : { notes_open: open }),
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
    return meta(report);
  });
}

/** Reading is side-effect free: an agent opening a report must not mark it read for the owner. */
function readReport(ctx: ReportContext, principal: TaskPrincipal, id: string) {
  const report = readReports(storePath(ctx)).find((r) => r.id === id && visible(r, principal));
  if (!report) throw notFound();
  return { ...meta(report), body: report.body, notes: report.notes ?? [] };
}

/** Idempotent: read=true keeps the first read time, read=false puts the report back to unread. */
function markReport(ctx: ReportContext, principal: TaskPrincipal, id: string, read: boolean) {
  return changeReports(storePath(ctx), (reports) => {
    const report = reports.find((r) => r.id === id && visible(r, principal));
    if (!report) throw notFound();
    if (read) report.read_at ??= (ctx.now ?? Date.now)();
    else delete report.read_at;
    return meta(report);
  });
}

function deleteReport(ctx: ReportContext, principal: TaskPrincipal, id: string) {
  return changeReports(storePath(ctx), (reports) => {
    const index = reports.findIndex((r) => r.id === id && visible(r, principal));
    if (index < 0) throw notFound();
    reports.splice(index, 1);
    return { deleted: true, id };
  });
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
    return { report: meta(report), note };
  });
}

/** The owner rewrites a note. A changed note is a new instruction: it opens again. */
function editNote(ctx: ReportContext, principal: TaskPrincipal, raw: unknown) {
  const input = noteEditInput.parse(raw);
  return changeNote(ctx, principal, input, (note) => {
    note.text = cleanBody(input.text);
    note.updated_at = (ctx.now ?? Date.now)();
    note.state = "open";
    delete note.done_at;
    delete note.reply;
    delete note.done_by;
  });
}

/** An agent finished what the note asked for; the short reply shows under the note. */
function finishNote(ctx: ReportContext, principal: TaskPrincipal, raw: unknown) {
  const input = noteDoneInput.parse(raw);
  return changeNote(ctx, principal, input, (note) => {
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
    return { deleted: true, id: input.note_id, report: meta(report) };
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
    return { report: meta(report), note };
  });
}

/** Reports in the caller's domains that carry open notes, newest open note first
 * (session start: what the owner left for an agent). */
export function reportsWithOpenNotes(ctx: ReportContext, principal: TaskPrincipal) {
  const newest = (r: TaskReport) =>
    Math.max(...(r.notes ?? []).filter((n) => n.state === "open").map((n) => n.updated_at ?? n.created_at));
  return readReports(storePath(ctx))
    .filter((r) => visible(r, principal) && openNotes(r) > 0)
    .sort((a, b) => newest(b) - newest(a))
    .map((r) => ({
      id: r.id,
      title: r.title,
      ...(r.project === undefined ? {} : { project: r.project }),
      open: openNotes(r),
    }));
}

function listReports(ctx: ReportContext, principal: TaskPrincipal, raw: unknown) {
  TASK_REPORT_INPUTS.task_report_list.parse(raw);
  const reports = readReports(storePath(ctx))
    .filter((r) => visible(r, principal))
    .sort(order);
  return { reports: reports.map(meta), unread: reports.filter((r) => r.read_at === undefined).length };
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
  task_report_note_add: addNote,
  task_report_note_edit: editNote,
  task_report_note_delete: deleteNote,
  task_report_note_done: finishNote,
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
