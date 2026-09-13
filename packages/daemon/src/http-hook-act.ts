/** Loopback-only `/hook/act`: closes loaded-memory episodes after Bash. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { fireAndForget, type Telemetry } from "./telemetry.js";
import { MAX_BODY_BYTES, readJsonBody, sendJson } from "./http-util.js";

export function handleHookAct(req: IncomingMessage, res: ServerResponse, telemetry: Telemetry): void {
  readJsonBody(req, MAX_BODY_BYTES)
    .then(async (body) => {
      const excerpt = typeof body.tool_input_excerpt === "string"
        ? body.tool_input_excerpt.slice(0, 4096)
        : "";
      if (!excerpt) {
        sendJson(res, 400, { error: "tool_input_excerpt is required" });
        return;
      }
      const toolName = typeof body.tool_name === "string" ? body.tool_name : null;
      const sessionId = typeof body.session_id === "string" ? body.session_id : null;
      const exitCode = typeof body.exit_code === "number" ? body.exit_code : null;
      const episodes = telemetry.matchLoadedMemories({
        tool_name: toolName,
        tool_input_excerpt: excerpt,
        session_id: sessionId,
        closeOnMiss: false,
      });
      for (const episode of episodes) fireAndForget(telemetry.logRecallEpisode(episode));
      fireAndForget(telemetry.logHookAct({
        tool_name: toolName,
        excerpt_chars: excerpt.length,
        matched_episodes: episodes.length,
        exit_code: exitCode,
        ...(sessionId ? { session_id: sessionId } : {}),
        client: body.client,
        hook_source: body.hook_source,
      }));
      sendJson(res, 200, { matched: episodes.length });
    })
    .catch(() => sendJson(res, 400, { error: "invalid JSON body" }));
}
