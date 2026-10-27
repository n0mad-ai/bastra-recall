/**
 * #1279 Phase 1: MCP over Streamable HTTP at /api/v1/mcp — the remote door
 * for clients that cannot spawn the stdio forwarder (ChatGPT apps/plugins,
 * Claude custom connectors, phones).
 *
 * Lives under /api/v1/ on purpose: the route sits behind the same token gate
 * as the REST tools (http-api-surface.ts), and a tunnel that publishes only
 * /api/v1/ publishes this too — no second ingress rule, no second auth path.
 *
 * Stateless: a fresh Server + transport per POST, no session id. Every call
 * goes through `dispatchApi`, the same dispatcher the forwarder reaches over
 * REST, so the remote door cannot drift from the local one. JSON responses
 * instead of SSE — tunnels and proxies buffer event streams unpredictably,
 * and nothing here streams (no progress notifications over this door yet).
 *
 * Tool surface: `write` (agents save, they do not reorganise), minus the task
 * tools — those need a loopback Host and their own credentials, which a
 * tunnelled caller never has.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ALL_TOOL_DEFS,
  INSTALL_TOOL_SURFACE,
  filterToolDefsForSurface,
  isToolAllowed,
  toolSurfaceDenial,
} from "./tool-defs.js";
import { dispatchApi, type DispatchCtx } from "./http-api-routes.js";
import { serverInstructions } from "./mcp-instructions.js";
import { MAX_BODY_BYTES, readJsonBody, sendJson } from "./http-util.js";
import { DAEMON_VERSION } from "./version.js";

const REMOTE_SURFACE = INSTALL_TOOL_SURFACE;

function remoteAllows(name: string): boolean {
  return !name.startsWith("task_") && isToolAllowed(name, REMOTE_SURFACE);
}

function buildServer(ctx: DispatchCtx): Server {
  const server = new Server(
    { name: "bastra-recall", title: "Bastra Recall", version: DAEMON_VERSION },
    { capabilities: { tools: {} }, instructions: serverInstructions(false) },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: filterToolDefsForSurface(ALL_TOOL_DEFS, REMOTE_SURFACE).filter((t) => remoteAllows(t.name)),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (!remoteAllows(name)) {
      return { isError: true, content: [{ type: "text" as const, text: toolSurfaceDenial(name, REMOTE_SURFACE) }] };
    }
    try {
      const result = await dispatchApi(name, args ?? {}, ctx);
      if (result === undefined) {
        return { isError: true, content: [{ type: "text" as const, text: `unknown tool: ${name}` }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text" as const, text: (err as Error).message }] };
    }
  });

  return server;
}

/** Handles /api/v1/mcp after the auth gate has passed. */
export function handleMcpHttp(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  ctx: DispatchCtx,
): void {
  // Stateless: no standalone SSE stream (GET) and no session to end (DELETE).
  if (method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  readJsonBody(req, MAX_BODY_BYTES)
    .then(async (body) => {
      const server = buildServer(ctx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })
    .catch((err: Error) => {
      if (!res.headersSent) sendJson(res, 400, { error: err.message });
    });
}
