/**
 * #708 — the caller's Claude Code session, carried through one forwarded call.
 *
 * Hook events carry the Claude Code session id in `session_id`. MCP tool
 * events carry the daemon's own telemetry id there (a `randomUUID()` per
 * Telemetry instance), so the two could never be joined: none of 1,095 saving
 * session ids appeared in a single hook event, and "sessions with a save
 * suggestion that then saved" read 0 whatever had happened (#662).
 *
 * The forwarder already sends the real id as `x-bastra-cc-session`. Handing it
 * down as an argument reached `load_memory` and the code tools, but the other
 * emitters sit several calls deep (`save_memory` alone has eight hold exits).
 * The dispatcher runs each forwarded call inside this store instead, and the
 * telemetry methods of the MCP tool events read it from here.
 *
 * Three states, kept apart on purpose:
 *   - a string    — the forwarder sent the header;
 *   - `null`      — a forwarded call without the header (Codex, Cursor, an old
 *                   forwarder, a direct REST caller): recorded as `null`, no guess;
 *   - `undefined` — not a forwarded call at all (stdio MCP, the Mac app):
 *                   the field is left off the event.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const callerSessionStore = new AsyncLocalStorage<string | null>();

/** `{ caller_session }` inside a forwarded call, `{}` outside one. Spread it
 *  BEFORE the payload, so an emitter that names its caller explicitly wins. */
export function callerSessionField(): { caller_session?: string | null } {
  const value = callerSessionStore.getStore();
  return value === undefined ? {} : { caller_session: value };
}

/**
 * #1469 — who wrote: transport, client and the client's session, for the
 * audit entry of every write that runs inside a tool call. Set once per call
 * at each transport's boundary (REST dispatcher, remote MCP, stdio server);
 * `recordAudit` reads it, so no write handler has to pass it down. A record
 * for a finding aid, never an access filter: nothing is refused or asked here.
 *
 * Outside a tool call (CLI, background jobs) the store is empty and the audit
 * entry carries `actor`/`actor_detail` only, as before. The exceptions:
 * `bastra import vault|clients` runs inside `cli`, and the map's folder import
 * and the web UI's saves, edits, archives and restores inside `webui` (see
 * `IMPORT_CLI_WRITER` / `IMPORT_WEBUI_WRITER`).
 */
export type WriteTransport = "stdio" | "forwarder" | "http" | "mcp-http" | "cli" | "webui";
export interface WriteCaller {
  transport: WriteTransport;
  /** MCP client (`name/version`) or OAuth client (`name [client_id]`); null = unknown. */
  client: string | null;
  /** The client's own session id when the transport carries one; null = unknown. */
  session: string | null;
}
export const writeCallerStore = new AsyncLocalStorage<WriteCaller>();

/** #1469: the write paths outside a tool call. Neither carries a client
 *  session of its own; an import's run id already sits in `session_id`. The
 *  web UI's own saves, edits, archives and restores (http-ui-routes.ts) use
 *  the same caller identity as the web UI import. */
export const IMPORT_CLI_WRITER: WriteCaller = { transport: "cli", client: "bastra-cli", session: null };
export const IMPORT_WEBUI_WRITER: WriteCaller = { transport: "webui", client: "bastra-web-ui", session: null };

/** Client-supplied labels go into an append-only log: one line, bounded. */
export function clientLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? clean.slice(0, 160) : null;
}

/** `name/version` from an MCP initialize handshake, or null before it. */
export function mcpClientLabel(info: { name?: string; version?: string } | undefined): string | null {
  if (!info?.name) return null;
  return clientLabel(info.version ? `${info.name}/${info.version}` : info.name);
}
