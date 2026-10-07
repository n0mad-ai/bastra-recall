/**
 * Save-notice lane, daemon-side: after one of Recall's own write tools
 * returned, tell the user in one line what was saved or edited.
 *
 * Claude Code shows the call collapsed ("Called bastra-recall"); the line is
 * the hook's `systemMessage`, which it prints right under it. Codex also
 * accepts this field; it defaults to a plain product prefix there. The wording
 * lives in save-notice.ts.
 *
 * Transport: no client of its own. The registration reuses the post-tool
 * client (`bastra-hook bash-fail` / bash-fail-hook.js), which POSTs any
 * payload to /hook/bash-fail unread; the route hands a Recall write tool here
 * and everything else to the Bash lane. A new subcommand would have needed a
 * new compiled stub on every host for a lane with no client-side logic (#344).
 *
 * What the line is built from:
 *   - the tool's RESULT decides whether anything is announced. A refused call
 *     has no result object with an id (the forwarder answers `isError` with
 *     the message as plain text), so it produces no line — Claude Code already
 *     shows the failed call, and the error text is the agent's to act on.
 *     Two results succeed as calls but wrote no new memory, and say so:
 *     the claim gate (#360) and the conflict diversion (#205).
 *   - title and type come from the vault entry the result names, the tool
 *     input being the fallback — an edit carries neither.
 *
 * Discipline: no I/O beyond the settings read and one telemetry line, `{}` on
 * every failure path, never throws.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { envFirst, envOff, isOnValue } from "./env.js";
import { defaultLogDir } from "./telemetry.js";
import { getPrimaryLanguage } from "./settings.js";
import { hookAgent, hookClientEvidence, type HookAgent, type HookClientEvidence } from "./hook-surface.js";
import { dimensionsFrom } from "./telemetry-dimensions.js";
import { coveredByDetail, cueDetail, editDetail, formatSaveNotice, type SaveNotice, type SaveNoticeAction } from "./save-notice.js";

const HOOK_VERSION = "0.1.0";

/** The tools that write to the vault. Reading tools never get a line. */
const WRITE_TOOLS = ["save_memory", "edit_memory", "save_document", "save_product_doc"] as const;
type WriteTool = (typeof WRITE_TOOLS)[number];

/**
 * Claude Code names an MCP tool `mcp__<server>__<tool>`, and
 * `mcp__plugin_<plugin>_<server>__<tool>` when a plugin bundles the server.
 * Codex canonicalizes the server separator to `bastra_recall` (0.160.0).
 * A matcher with a character outside `[A-Za-z0-9_\-, |]` is a regular
 * expression. Claude keeps its original registration; the lane also accepts
 * Codex's spelling.
 */
export const SAVE_NOTICE_MATCHER = `^mcp__(plugin_.+_)?bastra-recall__(${WRITE_TOOLS.join("|")})$`;
export const CODEX_SAVE_NOTICE_MATCHER = SAVE_NOTICE_MATCHER.replace("bastra-recall", "bastra[-_]recall");
const TOOL_NAME = new RegExp(CODEX_SAVE_NOTICE_MATCHER);

/** The Recall write tool a hook payload is about, or null. */
export function recallWriteTool(toolName: unknown): WriteTool | null {
  if (typeof toolName !== "string") return null;
  return (TOOL_NAME.exec(toolName)?.[2] as WriteTool | undefined) ?? null;
}

export interface SaveNoticePayload {
  bastra_client?: "claude-code" | "codex";
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  agent_id?: string;
}

/** Title and type of the vault entry with this id, if it is indexed. */
export type EntryLookup = (id: string) => { title?: unknown; type?: unknown } | undefined;

/**
 * Run the lane; return the exact stdout document for the thin client — `{}`
 * or `{"systemMessage": …}`.
 */
export async function runSaveNoticeLane(
  payload: SaveNoticePayload,
  lookup: EntryLookup,
  opts: { language?: () => Promise<string | undefined>; telemetry?: (payload: SaveNoticeTelemetry) => Promise<void> } = {},
): Promise<string> {
  const startedAt = Date.now();
  let tool: WriteTool | null = null;
  let action: SaveNoticeAction | null = null;
  let stdout = "{}";
  try {
    if (payload.hook_event_name !== "PostToolUse") return "{}";
    tool = recallWriteTool(payload.tool_name);
    if (tool === null) return "{}";
    if (envOff("BASTRA_SAVE_NOTICE")) return "{}";

    const language = await (opts.language ?? getPrimaryLanguage)().catch(() => undefined);
    const notice = describeWrite(tool, payload.tool_input ?? {}, readToolResult(payload.tool_response), lookup, language);
    if (notice !== null) {
      action = notice.action;
      const colour = hookClientEvidence(payload) !== "codex" || isOnValue(envFirst("BASTRA_SAVE_NOTICE_COLOR"));
      stdout = JSON.stringify({ systemMessage: formatSaveNotice(notice, language, colour) });
    }
  } catch {
    stdout = "{}";
  }
  if (tool !== null) {
    // Observability cannot consume the client deadline and discard a valid line.
    void Promise.resolve().then(() => (opts.telemetry ?? writeTelemetry)({
      session_id: typeof payload.session_id === "string" ? payload.session_id : null,
      client: hookClientEvidence(payload),
      agent: hookAgent(payload),
      tool,
      action,
      shown: stdout !== "{}",
      latency_ms_total: Date.now() - startedAt,
    })).catch(() => undefined);
  }
  return stdout;
}

/**
 * The tool's result object out of `tool_response`. Claude Code hands an MCP
 * result over as its content blocks; the forwarder puts the result there as
 * JSON text. `null` for anything that is not a result with an id — which is
 * what a refused call looks like.
 */
export function readToolResult(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return readToolResult(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const block of value) {
      const text = (block as { text?: unknown } | null)?.text;
      const result = typeof text === "string" ? readToolResult(text) : null;
      if (result) return result;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.isError === true || record.error !== undefined) return null;
  if (typeof record.id === "string" && record.id.trim().length > 0) return record;
  if (Array.isArray(record.content)) return readToolResult(record.content);
  return null;
}

/** What the call did, as the line states it; `null` when nothing is to be said. */
export function describeWrite(
  tool: WriteTool,
  input: Record<string, unknown>,
  result: Record<string, unknown> | null,
  lookup: EntryLookup,
  language: string | undefined,
): SaveNotice | null {
  if (result === null) return null;
  // An id alone is not a write acknowledgement. Use each tool's result contract.
  if (tool === "save_document") {
    if (typeof result.sidecar_path !== "string" || !result.sidecar_path.trim() || typeof result.reindexed !== "boolean") return null;
  } else if (typeof result.created !== "boolean" || (tool === "edit_memory" && result.created !== false)) {
    return null;
  }
  const id = result.id as string;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
  const entry = lookup(id);
  const type = str(entry?.type) ?? str(input.type);

  // #360: held at the claim gate — nothing was written under `id`, so the
  // title is the one the save carried.
  if (result.claim_gate !== undefined) {
    const claimed = (result.claim_gate as { claimed?: Array<{ id?: unknown }> } | null)?.claimed;
    if (result.created !== false || !Array.isArray(claimed) || claimed.length === 0 || !claimed.every((c) => str(c?.id))) return null;
    const covering = str(claimed[0]?.id);
    return {
      action: "held",
      title: str(input.title) ?? id,
      type: str(input.type),
      detail: covering ? coveredByDetail(str(lookup(covering)?.title) ?? covering, language) : undefined,
    };
  }
  // #205: `id` names the EXISTING memory the conflict was marked on.
  if (result.conflict_marked === true) {
    if (result.created !== false) return null;
    return { action: "conflict", title: str(entry?.title) ?? id, type: str(entry?.type) };
  }

  const title = str(entry?.title) ?? str(input.title) ?? id;
  if (tool === "edit_memory") {
    const frontmatter = input.frontmatter;
    const detail = editDetail(
      {
        strReplace: input.str_replace !== undefined,
        append: input.append !== undefined,
        fields: frontmatter && typeof frontmatter === "object" ? Object.keys(frontmatter) : [],
      },
      language,
    );
    return { action: "edited", title, type, detail };
  }
  // save_document reports no `created`; a document that is filed is "saved".
  const action: SaveNoticeAction = result.created === false ? "updated" : "created";
  const cue = Array.isArray(input.recall_when) ? str(input.recall_when[0]) : undefined;
  return { action, title, type, detail: cue ? cueDetail(cue, language) : undefined };
}

interface SaveNoticeTelemetry {
  session_id: string | null;
  client: HookClientEvidence;
  agent: HookAgent | null;
  tool: WriteTool;
  /** What the line said; `null` when the call had no result to announce. */
  action: SaveNoticeAction | null;
  shown: boolean;
  latency_ms_total: number;
}

async function writeTelemetry(payload: SaveNoticeTelemetry): Promise<void> {
  if (envOff("BASTRA_TELEMETRY", "NEXUS_TELEMETRY")) return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const { session_id: payloadSessionId, client, agent, ...rest } = payload;
    const event = {
      kind: "save_notice_call",
      ts,
      session_id: payloadSessionId ?? randomUUID(),
      hook_version: HOOK_VERSION,
      ...rest,
      dimensions: dimensionsFrom({ client, hook_source: "save-notice", session_id: payloadSessionId, agent }),
    };
    const file = join(logDir, `events-${ts.slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the lane.
  }
}
