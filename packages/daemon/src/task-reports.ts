/** Task reports: an agent's final report for the owner, filed after larger or
 * autonomous work instead of a long chat answer. The owner reads it in the
 * Tasks area of the Recall UI, marks it read or unread there by hand (reading
 * the body never changes that state, neither for the UI nor for an agent) and
 * deletes it when done. Not bound to a task
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
export const TASK_REPORT_INPUTS = {
  task_report_save: taskReportSaveInput,
  task_report_list: z.strictObject({}),
  task_report_read: idInput,
  task_report_mark: markInput,
  task_report_delete: idInput,
};
export type TaskReportOperation = keyof typeof TASK_REPORT_INPUTS;

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
});
type TaskReport = z.infer<typeof reportSchema>;
const storeSchema = z.strictObject({ version: z.literal(1), reports: z.array(reportSchema) });

interface ReportContext {
  path: string;
  authPath: string;
  now?: () => number;
}

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

function meta(r: TaskReport) {
  return {
    id: r.id,
    title: r.title,
    ...(r.project === undefined ? {} : { project: r.project }),
    origin: r.origin,
    actor: r.actor,
    created_at: r.created_at,
    ...(r.read_at === undefined ? {} : { read_at: r.read_at }),
    bytes: Buffer.byteLength(r.body),
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
  return { ...meta(report), body: report.body };
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

export async function callTaskReport(
  ctx: ReportContext,
  authorization: string | undefined,
  operation: TaskReportOperation,
  raw: unknown
): Promise<unknown> {
  const principal = await authenticateTask(authorization, ctx.authPath);
  if (operation === "task_report_save") return saveReport(ctx, principal, raw);
  if (operation === "task_report_read") return readReport(ctx, principal, idInput.parse(raw).id);
  if (operation === "task_report_mark") {
    const input = markInput.parse(raw);
    return markReport(ctx, principal, input.id, input.read);
  }
  if (operation === "task_report_delete") return deleteReport(ctx, principal, idInput.parse(raw).id);
  TASK_REPORT_INPUTS.task_report_list.parse(raw);
  const reports = readReports(storePath(ctx))
    .filter((r) => visible(r, principal))
    .sort(order);
  return { reports: reports.map(meta), unread: reports.filter((r) => r.read_at === undefined).length };
}

export const isTaskReportOperation = (name: string): name is TaskReportOperation =>
  Object.hasOwn(TASK_REPORT_INPUTS, name);
