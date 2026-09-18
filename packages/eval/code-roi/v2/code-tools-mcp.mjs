/**
 * The graph arm's MCP server for registration v4 (#582): `find_code` AND
 * `find_affected_files`, over one scenario's graph.
 *
 * Same discipline as `find-code-mcp.mjs`, which it replaces for the new arms:
 * the PRODUCT's tool definitions and handlers from the daemon's build, so the
 * arm measures what a user is offered — description included, since the whole
 * finding of v3 was that the description decides whether the tool is called at
 * all.
 *
 * WHY A SCRATCH ROOT. The scenario tree and its graph live apart on purpose
 * (the runner moves `graphify-out` out of the tree so no agent can read it as
 * a file), but `find_affected_files` needs BOTH: the graph to answer from, and
 * the checkout to read a candidate file's text. So the server assembles a
 * private root of symlinks — the tree's entries plus `graphify-out` — and
 * answers every call against that, whatever `repo` the agent passes. The
 * agent never learns this path, and nothing is written into the tree.
 *
 * Usage: node code-tools-mcp.mjs <treeDir> <graphRoot>
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { scenarioRoot } from "./scenario-root.mjs";

const DIST = new URL("../../../daemon/dist/code-graph/", import.meta.url).pathname;
const { codeTools, findCode, FindCodeArgs } = await import(`${DIST}find-code.js`);
const { affectedTools, findAffectedFiles, FindAffectedFilesArgs } = await import(
  `${DIST}find-affected-files.js`
);
const { CodeGraphCache } = await import(`${DIST}cache.js`);

const [tree, graphRoot] = process.argv.slice(2);
if (!tree || !graphRoot) {
  process.stderr.write("usage: code-tools-mcp.mjs <treeDir> <graphRoot>\n");
  process.exit(2);
}

const repo = scenarioRoot(tree, graphRoot);
const cache = new CodeGraphCache();
await cache.ensureLoaded(repo);
if (cache.get(repo) === null) {
  process.stderr.write(`code-tools-mcp: no usable graph for ${repo}\n`);
  process.exit(1);
}

const TOOLS = [...codeTools, ...affectedTools];
const server = new Server({ name: "code", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const fail = (text) => ({ isError: true, content: [{ type: "text", text }] });
  const ok = (result) => ({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
  const args = req.params.arguments ?? {};
  if (req.params.name === "find_code") {
    const parsed = FindCodeArgs.safeParse(args);
    return parsed.success ? ok(findCode(cache, { ...parsed.data, repo })) : fail(parsed.error.message);
  }
  if (req.params.name === "find_affected_files") {
    const parsed = FindAffectedFilesArgs.safeParse(args);
    return parsed.success
      ? ok(await findAffectedFiles(cache, { ...parsed.data, repo }))
      : fail(parsed.error.message);
  }
  return fail(`unknown tool ${req.params.name}`);
});
await server.connect(new StdioServerTransport());
