/**
 * The treatment arm's only extra tool: `find_code`, served over stdio MCP for
 * one scenario worktree (#588, registration v2).
 *
 * It reuses the PRODUCT's code — the tool definition (name, description,
 * schema) and `findCode()` from the daemon's build, and the same JSON
 * rendering the daemon's MCP handler uses — so the arm measures what a user
 * gets, not a lookalike. What it does NOT reuse is the daemon: the full Recall
 * server would bring memory recall into the arm, and the daemon's shared cache
 * is gated by this machine's enabled list, which a throwaway worktree is not on.
 *
 * The graph lives OUTSIDE the scenario tree (`<graphRoot>/graphify-out`), so
 * neither arm can read it as a file; every call is answered from it whatever
 * `repo` the agent passes, since the tree it works in is the one the graph was
 * built from.
 *
 * The graph is loaded BEFORE the server accepts calls. In the product the
 * first call on a cold daemon can answer "unavailable"; a scenario that lost
 * its only lookup to that would measure the cold start, not the tool.
 *
 * Usage (from the arm runner's --mcp-config): node find-code-mcp.mjs <graphRoot>
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const DIST = new URL("../../../daemon/dist/code-graph/", import.meta.url).pathname;
const { codeTools, findCode, FindCodeArgs } = await import(`${DIST}find-code.js`);
const { CodeGraphCache } = await import(`${DIST}cache.js`);

const repo = process.argv[2];
if (!repo) {
  process.stderr.write("usage: find-code-mcp.mjs <graphRoot>\n");
  process.exit(2);
}

const cache = new CodeGraphCache();
await cache.ensureLoaded(repo);
if (cache.get(repo) === null) {
  process.stderr.write(`find-code-mcp: no usable graph for ${repo}\n`);
  process.exit(1);
}

const server = new Server({ name: "code", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: codeTools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "find_code") {
    return { isError: true, content: [{ type: "text", text: `unknown tool ${req.params.name}` }] };
  }
  const parsed = FindCodeArgs.safeParse(req.params.arguments ?? {});
  if (!parsed.success) return { isError: true, content: [{ type: "text", text: parsed.error.message }] };
  const result = findCode(cache, { ...parsed.data, repo });
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});
await server.connect(new StdioServerTransport());
