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
import { randomUUID } from "node:crypto";
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
// The PRODUCT's whole tool list, not just the code half (#582 review). The
// instructions tell an agent to `recall` first; an arm that is told that and
// then offered no `recall` is not the product's surface, and the missing tool
// is itself a reason to distrust the rest of the paragraph. Memory and
// document tools are served as STUBS over an empty vault: same names, same
// schemas, an honest "nothing here" — the scenarios carry no memories, so an
// empty vault is the truthful answer, not a crippled one.
const { ALL_TOOL_DEFS, toolSurfaceDenial } = await import(
  new URL("../../../daemon/dist/tool-defs.js", import.meta.url).pathname
);
// The PRODUCT's server instructions, not a stand-in. Claude Code loads these
// into the model's context at session start, so an arm served without them
// measures a weaker surface than any real user is given (#582).
const { serverInstructions } = await import(
  new URL("../../../daemon/dist/mcp-instructions.js", import.meta.url).pathname
);

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

const CODE_TOOLS = new Set([...codeTools, ...affectedTools].map((t) => t.name));
const TOOLS = ALL_TOOL_DEFS;

/**
 * What the memory and document half answers — the PRODUCT's own shapes, taken
 * field for field from the handlers, not invented here (#582 review).
 *
 * The first version of these stubs answered `{ status: "ok", hits: [], note:
 * "No memories in this vault yet." }`. No product response carries `status` or
 * `note` at all, so an agent that had ever seen bastra-recall could tell it was
 * not talking to it — and the first thing an agent does with a surface it
 * distrusts is stop using the rest of it, which is exactly the observation arm
 * B exists to make.
 *
 * READ tools answer as a real, empty vault does: `recall` with the four fields
 * `/hook/recall` emits (`weak_result` needs hits, so an empty vault never sets
 * it), `find_document` with `docs_indexed: 0` — the field the tool description
 * tells the agent to read — and a lookup by id with the handler's own
 * `memory not found: <id>` / `document not found: <id>`.
 *
 * WRITE tools answer with the product's own `toolSurfaceDenial` for the
 * `search` surface. Three candidates were weighed, on one criterion: which one
 * makes an agent behave least differently?
 *   - A faked success would have to invent an id, a file_path and an audit_id
 *     for a memory no vault holds; a follow-up `load_memory` would then
 *     contradict it, which is a worse surface than any refusal.
 *   - A "not available in this measurement" note is honest but tells the agent
 *     it is being measured, and that is the one thing an arm must not learn.
 *   - The surface denial is an ORDINARY product condition: `search` is a real
 *     tool surface on which every write tool is denied in exactly these words
 *     and on which `find_affected_files` is explicitly allowed (tool-defs.ts).
 *     It names its own cause, says not to retry, and casts no doubt on the
 *     code tools. That is the one chosen.
 *
 * The tool LIST is unchanged — arm B is still offered `ALL_TOOL_DEFS`, as the
 * frozen surface requires; only what a write call answers changed.
 */
const EMPTY_VAULT_SURFACE = "search";

function emptyVaultAnswer(name, args) {
  const id = typeof args?.id === "string" ? args.id : "";
  switch (name) {
    case "recall":
      return {
        hits: [],
        vault_size: 0,
        latency_ms: 0,
        recall_id: randomUUID(),
      };
    case "find_document":
      return { query: String(args?.query ?? ""), docs_indexed: 0, hits: [] };
    case "load_memory":
      return { error: `memory not found: ${id}` };
    case "read_document":
    case "open_document":
      return { error: `document not found: ${id}` };
    default:
      return { error: toolSurfaceDenial(name, EMPTY_VAULT_SURFACE) };
  }
}
const server = new Server(
  { name: "code", version: "1.0.0" },
  // Code awareness IS on for an arm that is served a graph, so the arm gets
  // exactly the instructions such a user gets — including the code paragraph.
  { capabilities: { tools: {} }, instructions: serverInstructions(true) },
);
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
  if (TOOLS.some((t) => t.name === req.params.name) && !CODE_TOOLS.has(req.params.name)) {
    const answer = emptyVaultAnswer(req.params.name, args);
    // An error travels as an error, the way the product's own would: a
    // "not found" delivered as a successful result reads as a different
    // outcome than the tool really has.
    return answer.error !== undefined ? fail(answer.error) : ok(answer);
  }
  return fail(`unknown tool ${req.params.name}`);
});
await server.connect(new StdioServerTransport());
