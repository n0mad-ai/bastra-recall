/**
 * #1446 — edit a memory directly in the web UI's memory browser.
 *
 * No second write path: every write goes through the handlers the agent tools
 * use — `editMemoryHandler` (edit_memory: body str_replace / append and the
 * frontmatter whitelist, under the id claim, revision-checked, audited,
 * reindexed), `archiveMemoryHandler` (archive_memory: soft, into the vault
 * trash) and `auditedRestore` (the Mac app's restore from that trash). This
 * module only validates the browser's request strictly and maps the result.
 *
 * - `expected_revision` is required: the browser always edits a known state,
 *   and a concurrent change answers 409 instead of being overwritten.
 * - Title, type, sensitivity and recall mode (#1558) are the user's own
 *   fields: they ride the same edit as `userFields` (not part of the
 *   edit_memory tool), the file stays where it is. Documents and bookmarks
 *   keep their type (their own tools file them). The area is not changed
 *   here: the browser's area follows the folder, so it would mean moving
 *   the file (owner decision open). Any other field is refused loudly by
 *   `.strict()`.
 * - Nothing is shortened silently: an over-long summary is refused (the edit
 *   path would clamp it), the request body has the general /ui size limit.
 * - Private memories: the same visibility as GET /ui/graph — only when the
 *   peer account was proven (`privateGraph`), never via a request field.
 * - Rules: the transport-attributed user declaration binds directly in the
 *   edit path (#1385), without accepting unrelated pending proposal fields
 *   (Owner decision 04.11.2026: a rule the user asks for is a rule).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { z } from "zod";
import {
  AuditLog,
  MemoryTypeEnum,
  RulebookSchema,
  SUMMARY_MAX,
  auditedRestore,
  latestTrashPathFor,
  type Memory,
} from "@bastra-recall/core";
import { editMemoryHandler, splitAuthoredBody, type EditMemoryArgs, type UserFields } from "./edit-memory-handler.js";
import { archiveMemoryHandler } from "./tool-handlers.js";
import { catalogDeclaration } from "./rulebook-catalog.js";
import { TRUSTED_LOCAL_APP, hiddenFromCaller, hiddenOnDisk, type PrivateAccess } from "./private-access.js";
import type { AuditOrigin } from "./audit-trail.js";
import type { ToolDeps } from "./tool-deps.js";
import { getUiEnabled } from "./settings.js";
import { MAX_BODY_BYTES, readJsonBody } from "./http-util.js";
import { sendJsonPlain } from "./webui.js";
import type { HttpServerContext } from "./http-context.js";

/** What the routes need from the UI dispatcher's context. */
export interface MemoryEditCtx {
  toolDeps: ToolDeps;
  /** Set by http.ts only after a proven peer-account check (as /ui/graph). */
  privateGraph?: boolean;
  /** The semantic layouts and their builds, dropped when sensitivity changes (#1558). */
  server?: Pick<HttpServerContext, "semanticCache" | "uiSemanticCache" | "semanticInflight" | "uiSemanticInflight">;
}

/** The audit trail names the user and the surface, not the MCP tool. */
const UI_ORIGIN: AuditOrigin = { actor: "user", actorDetail: "ui:memory-browser" };

const access = (ctx: MemoryEditCtx): PrivateAccess | undefined => (ctx.privateGraph ? TRUSTED_LOCAL_APP : undefined);

// ── rule state, shown in the reader (GET /ui/graph/node) and after a save ──
export interface RuleInfo {
  state: "rule" | "proposal" | "note" | "inactive";
  rulebook?: "always" | "on-demand";
  /** The declared text; absent when the catalog derives it from the summary. */
  applies_when?: string;
  /** A private rule is bound but not delivered to sessions (#1393). */
  delivered?: boolean;
  /** A pending proposal to archive the memory — accepting it needs archive. */
  archive?: boolean;
  /** Whether the memory is a rule under each "type recall_mode" pair. Present
   *  only when changing those two fields in the editor would change that (a
   *  rule without its own declaration), so the editor can warn before a save. */
  by_type_mode?: Record<string, boolean>;
}

const RECALL_MODES = ["deliberate", "reflex"] as const;

/** The rule membership per type × recall mode, or undefined when it is the
 *  same for every pair (a declared rule, an agent's note). */
function ruleByTypeMode(fm: Memory["fm"]): Record<string, boolean> | undefined {
  const out: Record<string, boolean> = {};
  for (const type of MemoryTypeEnum.options)
    for (const recall_mode of RECALL_MODES)
      out[`${type} ${recall_mode}`] = !!catalogDeclaration({ ...fm, type, recall_mode });
  return new Set(Object.values(out)).size > 1 ? out : undefined;
}

export function ruleInfo(fm: Memory["fm"]): RuleInfo {
  if (fm.obsolete || fm.superseded_by) return { state: "inactive" };
  const declaration = catalogDeclaration(fm);
  const byTypeMode = ruleByTypeMode(fm);
  const follows = byTypeMode ? { by_type_mode: byTypeMode } : {};
  if (declaration)
    return {
      state: "rule",
      rulebook: declaration.rulebook,
      ...(fm.applies_when !== undefined ? { applies_when: fm.applies_when } : {}),
      delivered: fm.sensitivity !== "private",
      ...follows,
    };
  const proposed = fm.rulebook_proposed;
  if (proposed)
    return {
      state: "proposal",
      rulebook: proposed.rulebook,
      applies_when: proposed.applies_when,
      ...(proposed.archive ? { archive: true } : {}),
      ...follows,
    };
  return { state: "note", ...follows };
}

/** The node detail's edit fields: the revision the shown body belongs to
 *  (the index pairs both, #1334) and the rule state. */
export function memoryEditInfo(mem: Memory): { revision: string | null; rule: RuleInfo } {
  return { revision: mem.revision ?? null, rule: ruleInfo(mem.fm) };
}

// ── request validation ─────────────────────────────────────────────────────
const Revision = z.string().regex(/^sha256:[0-9a-f]{16}$/, "expected_revision must be a revision from the reader");
const Id = z.string().min(1).max(512);

export const UiEditRequest = z
  .object({
    id: Id,
    expected_revision: Revision,
    /** The complete authored text (the auto-related block stays untouched). */
    body: z.string().optional(),
    summary: z.string().optional(),
    tags: z.array(z.string()).max(100).optional(),
    rule: z.object({ rulebook: RulebookSchema, applies_when: z.string() }).strict().optional(),
    rule_decision: z.enum(["accept", "reject"]).optional(),
    // #1558: the user's own fields (see userFieldsOf)
    title: z.string().optional(),
    type: MemoryTypeEnum.optional(),
    sensitivity: z.enum(["public", "team", "private"]).optional(),
    recall_mode: z.enum(["reflex", "deliberate"]).optional(),
  })
  .strict();
export type UiEditRequest = z.infer<typeof UiEditRequest>;

const UiArchiveRequest = z.object({ id: Id, expected_revision: Revision }).strict();
const UiRestoreRequest = z.object({ id: Id }).strict();

class UiEditError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly conflict = false
  ) {
    super(message);
  }
}

async function readRequest<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (err) {
    const msg = (err as Error).message;
    throw new UiEditError(msg.startsWith("body too large") ? 413 : 400, msg);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new UiEditError(
      400,
      parsed.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join(", ")
    );
  return parsed.data;
}

/** The memory as this caller may see it, at the revision the reader showed. */
function current(ctx: MemoryEditCtx, id: string, revision: string): Memory {
  const mem = ctx.toolDeps.vault.get(id);
  if (!mem || hiddenFromCaller(access(ctx), mem.fm)) throw new UiEditError(404, `memory not found: ${id}`);
  // The index pairs body and revision; a newer one means the reader is stale.
  if (mem.revision !== revision)
    throw new UiEditError(409, `'${id}' changed since it was loaded — nothing was written.`, true);
  return mem;
}

const normalize = (text: string) => text.replace(/\r\n?/g, "\n").trim();

/** The body operation that turns the authored text into `next`, or none. */
function bodyOp(mem: Memory, next: string): Pick<EditMemoryArgs, "str_replace" | "append"> {
  const { head } = splitAuthoredBody(mem.body);
  const text = normalize(next);
  if (text === head.trim()) return {};
  // The whole authored head is replaced: it occurs exactly once in itself,
  // and the revision check guarantees it is the text on disk.
  if (head) return { str_replace: { old_str: head, new_str: `${/^\s*/.exec(head)![0]}${text}${text ? "\n" : ""}` } };
  return text ? { append: text } : {};
}

function tagsOf(list: string[]): string[] {
  const tags = list.map((t) => t.trim());
  if (tags.length === 0 || tags.some((t) => !t)) throw new UiEditError(400, "tags: at least one, none empty");
  return tags;
}

function summaryOf(text: string): string {
  const summary = normalize(text);
  if (!summary) throw new UiEditError(400, "summary: must not be empty");
  if (summary.length > SUMMARY_MAX)
    throw new UiEditError(400, `summary: at most ${SUMMARY_MAX} characters (it is ${summary.length})`);
  return summary;
}

// Documents and bookmarks are filed by their own tools; a memory does not become one here.
const OWN_TOOL_TYPES = new Set(["doc", "bookmark"]);

function titleOf(text: string): string {
  const title = text.trim();
  if (!title) throw new UiEditError(400, "title: must not be empty");
  if (/[\r\n]/.test(title)) throw new UiEditError(400, "title: one line");
  return title;
}

function typeOf(mem: Memory, type: Memory["fm"]["type"]): Memory["fm"]["type"] {
  if (type !== mem.fm.type && (OWN_TOOL_TYPES.has(type) || OWN_TOOL_TYPES.has(mem.fm.type)))
    throw new UiEditError(400, "type: documents and bookmarks keep their type");
  return type;
}

/** #1558: the user's own fields that differ from the memory, or none. */
export function userFieldsOf(mem: Memory, r: UiEditRequest): UserFields | undefined {
  const next: UserFields = {
    ...(r.title !== undefined ? { title: titleOf(r.title) } : {}),
    ...(r.type !== undefined ? { type: typeOf(mem, r.type) } : {}),
    ...(r.sensitivity !== undefined ? { sensitivity: r.sensitivity } : {}),
    ...(r.recall_mode !== undefined ? { recall_mode: r.recall_mode } : {}),
  };
  const fm = mem.fm as Record<string, unknown>;
  const changed = Object.entries(next).filter(([k, v]) => fm[k] !== v);
  return changed.length ? Object.fromEntries(changed) : undefined;
}

type Patch = NonNullable<EditMemoryArgs["frontmatter"]>;

function frontmatterPatch(mem: Memory, r: UiEditRequest): Patch | undefined {
  const patch: Patch = {};
  if (r.summary !== undefined && summaryOf(r.summary) !== mem.fm.summary) patch.summary = summaryOf(r.summary);
  if (r.tags !== undefined && JSON.stringify(tagsOf(r.tags)) !== JSON.stringify(mem.fm.tags))
    patch.tags = tagsOf(r.tags);
  if (r.rule) {
    const applies_when = normalize(r.rule.applies_when);
    if (!applies_when) throw new UiEditError(400, "rule.applies_when: say when the rule applies");
    Object.assign(patch, { rulebook: r.rule.rulebook, applies_when });
  }
  return Object.keys(patch).length ? patch : undefined;
}

const USER_FIELDS = ["title", "type", "sensitivity", "recall_mode"] as const;

/** The edit_memory arguments for one browser save (with the user's own
 *  fields apart, #1558), or 400 when nothing changes. */
export function editArgs(mem: Memory, r: UiEditRequest): { args: EditMemoryArgs; fields?: UserFields } {
  const base = { id: mem.fm.id, expected_revision: r.expected_revision };
  if (r.rule_decision) {
    if (
      r.body !== undefined ||
      r.summary !== undefined ||
      r.tags !== undefined ||
      r.rule ||
      USER_FIELDS.some((k) => r[k] !== undefined)
    )
      throw new UiEditError(400, "rule_decision stands alone");
    return { args: { ...base, rulebook_decision: { decision: r.rule_decision, write_origin: "user-directed" } } };
  }
  const frontmatter = frontmatterPatch(mem, r);
  const fields = userFieldsOf(mem, r);
  const args = {
    ...base,
    ...(r.body !== undefined ? bodyOp(mem, r.body) : {}),
    // edit_memory needs one operation; the user's fields alone are an empty patch
    ...(frontmatter || fields ? { frontmatter: frontmatter ?? {} } : {}),
  };
  if (!args.str_replace && args.append === undefined && !args.frontmatter)
    throw new UiEditError(400, "nothing to change");
  return { args, ...(fields ? { fields } : {}) };
}

/** A thrown edit/archive error → status. Refused preconditions are conflicts. */
function failure(err: unknown): UiEditError {
  if (err instanceof UiEditError) return err;
  const e = err as Error;
  const msg = e?.message ?? "edit failed";
  if (e?.name === "EditPreconditionError" || /changed while|does not hold memory|cannot archive/.test(msg))
    return new UiEditError(409, msg, true);
  if (/^(memory not found|unknown memory)/.test(msg)) return new UiEditError(404, msg);
  if (/^(invalid edit_memory args|rulebook edits require|no pending rulebook|archive proposal)/.test(msg))
    return new UiEditError(400, msg);
  return new UiEditError(500, msg);
}

async function respond(res: ServerResponse, run: () => Promise<unknown>): Promise<void> {
  if (!(await getUiEnabled())) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  try {
    sendJsonPlain(res, 200, await run());
  } catch (err) {
    const e = failure(err);
    sendJsonPlain(res, e.status, { error: e.message, ...(e.conflict ? { conflict: true } : {}) });
  }
}

async function edit(ctx: MemoryEditCtx, r: UiEditRequest) {
  const deps = ctx.toolDeps;
  const mem = current(ctx, r.id, r.expected_revision);
  const { args, fields } = editArgs(mem, r);
  const result = await editMemoryHandler(deps, args, access(ctx), UI_ORIGIN, fields);
  // A memory that became private must leave the cached layouts at once (#1558).
  if (fields?.sensitivity && ctx.server) {
    ctx.server.semanticCache = ctx.server.uiSemanticCache = null;
    ctx.server.semanticInflight = ctx.server.uiSemanticInflight = null;
  }
  if (!("revision" in result)) throw new UiEditError(409, "the edit was held by the trigger check — nothing written");
  const { revision, warning } = result;
  const after = deps.vault.get(r.id);
  return { id: r.id, revision, rule: after ? ruleInfo(after.fm) : null, ...(warning ? { warning } : {}) };
}

async function archive(ctx: MemoryEditCtx, r: z.infer<typeof UiArchiveRequest>) {
  current(ctx, r.id, r.expected_revision);
  const out = await archiveMemoryHandler(ctx.toolDeps, { id: r.id }, access(ctx), UI_ORIGIN, r.expected_revision);
  return { id: r.id, archived_to: relative(ctx.toolDeps.vaultPath, out.archived_to).split(sep).join("/") };
}

async function restore(ctx: MemoryEditCtx, r: z.infer<typeof UiRestoreRequest>) {
  const { vault, vaultPath } = ctx.toolDeps;
  const trashed = await latestTrashPathFor(vaultPath, r.id);
  const raw = trashed ? await readFile(trashed, "utf8").catch(() => null) : null;
  // A trashed private memory stays as invisible as it was in the vault.
  if (raw === null || hiddenOnDisk(access(ctx), raw)) throw new UiEditError(404, `nothing to restore: ${r.id}`);
  const out = await auditedRestore({
    auditLog: new AuditLog(vaultPath),
    vaultRoot: vaultPath,
    memoryID: r.id,
    vault,
    context: { actor: "user", actor_detail: "ui:memory-browser" },
  }).catch((err: Error) => {
    throw new UiEditError(409, err.message, true);
  });
  await vault.reindexFile(out.restoredTo);
  return { id: r.id };
}

/** POST /ui/memory/edit {id, expected_revision, body?, summary?, tags?, rule?, title?, type?,
 *  sensitivity?, recall_mode? | rule_decision}
 *  → {id, revision, rule}; 409 {conflict} when the memory moved on. */
export async function handleUiMemoryEdit(req: IncomingMessage, res: ServerResponse, ctx: MemoryEditCtx) {
  await respond(res, async () => edit(ctx, await readRequest(req, UiEditRequest)));
}

/** POST /ui/memory/archive {id, expected_revision} → {id, archived_to} (vault trash). */
export async function handleUiMemoryArchive(req: IncomingMessage, res: ServerResponse, ctx: MemoryEditCtx) {
  await respond(res, async () => archive(ctx, await readRequest(req, UiArchiveRequest)));
}

/** POST /ui/memory/restore {id} → {id}: the archive's undo. */
export async function handleUiMemoryRestore(req: IncomingMessage, res: ServerResponse, ctx: MemoryEditCtx) {
  await respond(res, async () => restore(ctx, await readRequest(req, UiRestoreRequest)));
}
