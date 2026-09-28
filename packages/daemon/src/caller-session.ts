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
