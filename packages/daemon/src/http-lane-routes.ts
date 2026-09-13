/**
 * Route dispatch for the three hook lanes that moved daemon-side in #369:
 * POST /hook/stop, /hook/session, /hook/todo. Loopback-only — the host gate in
 * http.ts runs before this dispatcher. Returns true when the request was
 * handled. Split out of http.ts (file-size convention).
 *
 * Same contract as /hook/prompt, /hook/write and the bash lanes (#343): the
 * client POSTs `{payload}` and writes the response body to stdout VERBATIM, so
 * these endpoints return the exact document Claude Code expects — `{}` or the
 * hookSpecificOutput envelope — and fail open to `{}` with 200. A client must
 * never see an error it would only translate back into `{}` anyway.
 *
 * The four older lane routes stayed in http.ts on purpose: moving them would
 * churn a shipped, tested route block for cosmetics. New lanes land here.
 *
 * The lanes take the server's own address for their loopback self-calls
 * (/hook/recall, /hook/floors, /hook/drift, …) — read off the socket, not the
 * environment, so a daemon on a non-default port calls itself correctly.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { runStopLane, type ClaudeStopPayload } from "./stop-lane.js";
import { runSessionLane, type SessionPayload } from "./session-lane.js";
import { runTodoLane, type ClaudeHookPayload as TodoPayload } from "./todo-lane.js";
import { MAX_BODY_BYTES, readJsonBody } from "./http-util.js";
import type { WarmupCoordinator } from "./embedding-warmup.js";

/** The one shape all three share: read `{payload}`, run the lane, answer with
 *  its stdout document; `{}` + 200 on any failure. */
function runLane<P>(
  req: IncomingMessage,
  res: ServerResponse,
  run: (payload: P, self: string) => Promise<string>,
): void {
  const answer = (body: string): void => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
  };
  readJsonBody(req, MAX_BODY_BYTES)
    .then(async (body) => {
      const self = `http://127.0.0.1:${req.socket.localPort ?? 6723}`;
      answer(await run((body.payload ?? {}) as P, self));
    })
    .catch(() => answer("{}"));
}

export function dispatchLaneRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: string,
  /** #490: the shared embedding warm-up, so the session lane can ask it for
   *  residency and start the load BESIDE its recall instead of inside it.
   *  Same route-level injection as the prompt lane's prewarmer (#361, in
   *  http.ts). Absent = no embedding provider, and the lane behaves exactly
   *  as it did before #490. */
  warmupEmbedding?: WarmupCoordinator,
): boolean {
  if (method !== "POST") return false;

  // Stop (#35/#48/#67): the highest-frequency lane — one call at the end of
  // every answer. Always answers `{}`; the suggestions go to the pending file.
  if (url === "/hook/stop") {
    runLane<ClaudeStopPayload>(req, res, runStopLane);
    return true;
  }
  // SessionStart: the recall + floors + taxonomy + care/import/update block.
  if (url === "/hook/session") {
    runLane<SessionPayload>(req, res, (payload, self) =>
      runSessionLane(payload, self, warmupEmbedding),
    );
    return true;
  }
  // PreToolUse TodoWrite (#36): topology recall for a fresh multi-step plan.
  if (url === "/hook/todo") {
    runLane<TodoPayload>(req, res, runTodoLane);
    return true;
  }
  return false;
}
