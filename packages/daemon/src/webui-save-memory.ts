/**
 * "Save as memory" under an answer in the web UI agent window (#1445).
 *
 * The user turns a useful answer into a vault memory by hand: one click, an
 * editable preview (title, type, scope, text), one confirmation. This route
 * only feeds the normal save_memory path (`saveMemoryHandler`) — no second
 * write logic — with `write_origin: user-directed`, because the user directed
 * the save. Validation, claim gate, audit and indexing stay where they are.
 *
 * Held or refused saves are not swallowed: an existing memory under the same
 * id, or one that already declares the same situation (claim gate, #360),
 * comes back as 409 with that memory's id and title. Nothing is written then.
 * A memory the caller may not read is never named: a collision with it fails
 * like the public save_memory does (#464), without a code or a name.
 *
 * Sensitivity: the default of the normal save (team). When one of the
 * answer's sources is private, the new memory is private too — it is never
 * less protected than its most private source.
 *
 * Loopback-only and gated on ui.enabled like the rest of /ui; the local POST
 * gate (http.ts gateLocalPost) applies before this handler.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isPathSafeComponent, resolveMemoryTarget } from "@bastra-recall/core";
import { getUiEnabled } from "./settings.js";
import { MAX_BODY_BYTES, readJsonBody } from "./http-util.js";
import { sendJsonPlain } from "./webui.js";
import { saveMemoryHandler } from "./save-memory-handler.js";
import { vaultLocator } from "./vault-locator.js";
import type { ToolDeps } from "./tool-deps.js";
import { hiddenFromCaller, TRUSTED_LOCAL_APP, type PrivateAccess } from "./private-access.js";
import { USER_SAVE_TYPES, userDirectedSaveInput } from "./user-save-input.js";
import { IMPORT_WEBUI_WRITER, writeCallerStore } from "./caller-session.js";
import { storedConversationId } from "./chat-history.js";

export { summaryFrom } from "./user-save-input.js";

/** Authored types: the preview offers the same ones as `bastra save`. */
export const UI_SAVE_TYPES = USER_SAVE_TYPES;

export const SAVE_TITLE_MAX = 200;
const SCOPE_MAX = 80;
const SOURCES_MAX = 20;

interface UiSaveDraft {
  title: string;
  type: (typeof UI_SAVE_TYPES)[number];
  scope: string;
  body: string;
  sources: string[];
  conversationId?: string;
}

class UiSaveError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

function textField(raw: unknown, name: string): string {
  if (typeof raw !== "string") throw new UiSaveError(400, `${name} required`);
  return raw;
}

function parseTitle(raw: unknown): string {
  const title = textField(raw, "title").replace(/\s+/g, " ").trim();
  if (!title) throw new UiSaveError(400, "title required");
  if (title.length > SAVE_TITLE_MAX) throw new UiSaveError(400, `title too long (max ${SAVE_TITLE_MAX})`);
  return title;
}

function parseScope(raw: unknown): string {
  const scope = textField(raw, "scope").trim();
  if (!scope) throw new UiSaveError(400, "scope required");
  if (scope.length > SCOPE_MAX || !isPathSafeComponent(scope) || /\s{2,}|[\u0000-\u001f]/.test(scope))
    throw new UiSaveError(400, "scope must be a plain area name");
  return scope;
}

function parseSources(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > SOURCES_MAX || raw.some((s) => typeof s !== "string" || s.length > 200))
    throw new UiSaveError(400, `sources must be up to ${SOURCES_MAX} memory ids`);
  return raw as string[];
}

function parseDraft(raw: Record<string, unknown>): UiSaveDraft {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new UiSaveError(400, "invalid JSON body");
  const type = raw.type;
  if (typeof type !== "string" || !(UI_SAVE_TYPES as readonly string[]).includes(type))
    throw new UiSaveError(400, `type must be one of ${UI_SAVE_TYPES.join(", ")}`);
  const body = textField(raw.body, "body").replace(/\r\n?/g, "\n").trim();
  if (!body) throw new UiSaveError(400, "body required");
  return {
    title: parseTitle(raw.title),
    type: type as UiSaveDraft["type"],
    scope: parseScope(raw.scope),
    body,
    sources: parseSources(raw.sources),
    conversationId: typeof raw.conversation_id === "string" ? raw.conversation_id : undefined,
  };
}

async function readDraft(req: IncomingMessage): Promise<UiSaveDraft> {
  let raw: Record<string, unknown>;
  try {
    raw = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (err) {
    const msg = (err as Error).message;
    throw new UiSaveError(msg.startsWith("body too large") ? 413 : 400, msg);
  }
  return parseDraft(raw);
}

const named = (deps: ToolDeps, ids: string[], access?: PrivateAccess) =>
  ids
    .filter((id) => !hiddenFromCaller(access, deps.vault.get(id)?.fm))
    .map((id) => ({ id, title: deps.vault.get(id)?.fm.title ?? id }));

/** The one save: the normal handler with the user's draft. */
async function saveDraft(deps: ToolDeps, draft: UiSaveDraft, access?: PrivateAccess): Promise<Record<string, unknown>> {
  const privateSources = draft.sources.filter((id) => deps.vault.get(id)?.fm.sensitivity === "private");
  const input = {
    ...userDirectedSaveInput(draft),
    ...(privateSources.length ? { sensitivity: "private" as const } : {}),
  };
  // Same target resolution the save uses: an existing memory under this id is
  // named to the user instead of surfacing as a thrown "already exists".
  // A memory this caller may not read is not named: the save path below
  // refuses it exactly as it refuses a public save_memory caller (#464), so
  // this route says no more about it than the public API already does.
  const target = resolveMemoryTarget(deps.vaultPath, input, vaultLocator(deps.vault)).id,
    existing = deps.vault.get(target);
  if (existing && !hiddenFromCaller(access, existing.fm))
    throw new UiSaveError(409, "a memory with this title already exists", {
      code: "exists",
      existing: named(deps, [target], access),
    });
  const result = await saveMemoryHandler(deps, input, access);
  if ("claim_gate" in result)
    throw new UiSaveError(409, "another memory already covers this situation", {
      code: "held",
      existing: named(
        deps,
        result.claim_gate.claimed.map((c) => c.id),
        access
      ),
    });
  const fm = deps.vault.get(result.id)?.fm;
  return {
    id: result.id,
    title: fm?.title ?? draft.title,
    type: draft.type,
    scope: fm?.scope ?? draft.scope,
    // The stored sensitivity always inherits the strongest source. Only a
    // proven account may learn which source IDs are private from this reply.
    ...(access?.trustedPrivate
      ? { sensitivity: input.sensitivity ?? "team", private_sources: privateSources.length }
      : {}),
  };
}

/** POST /ui/save-memory {title, type, scope, body, sources?, conversation_id?} → the saved
 *  memory {id, title, type, scope, sensitivity, private_sources}. 400/413 on
 *  invalid input, 409 {code: exists|held, existing: [{id, title}]} when the
 *  save path held or refused it, 404 while the UI is disabled. */
export async function handleUiSaveMemory(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ToolDeps,
  settingsPath?: string,
  /** Set by the UI dispatcher after the same peer check as /ui/graph. */
  privateGraph = false
): Promise<void> {
  if (!(await getUiEnabled(settingsPath))) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  try {
    const draft = await readDraft(req);
    const writer = { ...IMPORT_WEBUI_WRITER, session: storedConversationId(draft.conversationId) };
    const result = await writeCallerStore.run(writer, () =>
      saveDraft(deps, draft, privateGraph ? TRUSTED_LOCAL_APP : undefined)
    );
    sendJsonPlain(res, 200, result);
  } catch (err) {
    if (err instanceof UiSaveError) sendJsonPlain(res, err.status, { error: err.message, ...err.extra });
    else sendJsonPlain(res, 500, { error: `save failed: ${(err as Error).message}` });
  }
}
