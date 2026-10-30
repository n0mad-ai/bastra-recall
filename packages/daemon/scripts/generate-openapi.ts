/** Generate public API contracts without booting a daemon or touching a vault. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import ts from "typescript";
import { actionServerUrl } from "./gpt-action-url.js";
import { z } from "zod";
import { RecallArgs, LoadMemoryArgs, ListRulesArgs, RulebookCheckArgs, SaveMemoryInput, ArchiveMemoryArgs } from "../src/tool-handlers.js";
import { EditMemoryArgs } from "../src/edit-memory-handler.js";
import { FindDocumentArgs, ReadDocumentArgs, OpenDocumentArgs } from "../src/documents-handler.js";
import { SaveDocumentArgs, RecategorizeDocumentArgs, MoveDocumentArgs } from "../src/documents-write-handler.js";
import { SaveProductDocArgs } from "../src/product-doc-handler.js";
import { ReviewDraftArgs } from "../src/draft-review-handler.js";
import { ValidateArtifactArgs } from "../src/validate-artifact-handler.js";
import { FindCodeArgs } from "../src/code-graph/find-code.js";
import { FindAffectedFilesArgs } from "../src/code-graph/find-affected-files.js";
import { TASK_INPUT_SCHEMAS } from "../src/task-service.js";
import { ALL_TOOL_DEFS } from "../src/tool-defs.js";
import { taskTools } from "../src/task-transport.js";
import { TASK_HTTP_ROUTES } from "../src/task-http-routes.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
type Schema = Record<string, unknown>;
type Operation = Record<string, unknown>;
type Paths = Record<string, Record<string, Operation>>;
export interface ApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  security: { bearerAuth: never[] }[];
  paths: Paths;
  components: { securitySchemes: Record<string, unknown>; responses: Record<string, unknown> };
}
function source(relative: string, read = readFileSync): ts.SourceFile {
  return ts.createSourceFile(relative, read(resolve(root, relative), "utf8") as string, ts.ScriptTarget.Latest, true);
}
function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node); node.forEachChild(child => walk(child, visit));
}
/** Discover case labels, not a second list that can forget a new handler. */
export function discoverPostTools(text?: string): Map<string, Schema | undefined> {
  const file = text === undefined ? source("packages/daemon/src/http-api-routes.ts")
    : ts.createSourceFile("routes.ts", text, ts.ScriptTarget.Latest, true);
  const names = new Map<string, Schema | undefined>();
  walk(file, node => {
    if (!ts.isSwitchStatement(node) || node.expression.getText(file) !== "tool") return;
    for (const clause of node.caseBlock.clauses) {
      if (!ts.isCaseClause(clause) || !ts.isStringLiteral(clause.expression)) continue;
      const name = clause.expression.text;
      if (names.has(name)) throw new Error(`Duplicate HTTP tool: ${name}`);
      // Floors use inline string coercions rather than an MCP definition.
      // Derive their accepted body fields directly from those handler branches.
      const properties: Schema = {};
      if (name === "floors" || name.startsWith("floors/")) walk(clause, child => {
        if (ts.isPropertyAccessExpression(child) && child.expression.getText(file) === "body") {
          properties[child.name.text] = { type: "string" };
        }
      });
      names.set(name, Object.keys(properties).length ? { type: "object", properties } : undefined);
    }
  });
  if (names.size === 0) throw new Error("No HTTP dispatcher case labels found");
  return names;
}
/** These GET handlers all live under the surface's method === GET guard. */
export function discoverGetRoutes(text?: string): Map<string, string[]> {
  const file = text === undefined ? source("packages/daemon/src/http-api-surface.ts")
    : ts.createSourceFile("surface.ts", text, ts.ScriptTarget.Latest, true);
  const routes = new Map<string, string[]>();
  walk(file, node => {
    // Fail closed when route syntax changes: otherwise one new guard could be
    // skipped while the remaining known routes still make generation succeed.
    if (ts.isPropertyAccessExpression(node) && node.getText(file) === "u.pathname") {
      const comparison = node.parent;
      if (!ts.isBinaryExpression(comparison) || comparison.left !== node ||
          comparison.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
          !ts.isStringLiteral(comparison.right) || !ts.isIfStatement(comparison.parent) ||
          comparison.parent.expression !== comparison) {
        throw new Error(`Unsupported HTTP GET pathname guard: ${comparison.getText(file)}`);
      }
    }
    if (!ts.isIfStatement(node) || !ts.isBinaryExpression(node.expression)) return;
    const condition = node.expression;
    if (condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
        condition.left.getText(file) !== "u.pathname" || !ts.isStringLiteral(condition.right)) return;
    const path = condition.right.text;
    if (!path.startsWith("/api/v1/")) throw new Error(`Unexpected API path: ${path}`);
    const queries = new Set<string>();
    walk(node.thenStatement, child => {
      if (ts.isCallExpression(child) && child.expression.getText(file) === "u.searchParams.get" &&
          child.arguments[0] && ts.isStringLiteral(child.arguments[0])) queries.add(child.arguments[0].text);
    });
    routes.set(path.slice("/api/v1".length), [...queries].sort());
  });
  if (routes.size === 0) throw new Error("No HTTP GET routes found");
  return routes;
}
// Reuse the very validators called by the handlers, rather than their less
// precise MCP descriptions. Unknown new handlers fail closed below.
const inputValidators: Record<string, z.ZodType> = {
  recall: RecallArgs, load_memory: LoadMemoryArgs, list_rules: ListRulesArgs, rulebook_check: RulebookCheckArgs, save_memory: SaveMemoryInput,
  edit_memory: EditMemoryArgs, archive_memory: ArchiveMemoryArgs,
  find_document: FindDocumentArgs, read_document: ReadDocumentArgs, open_document: OpenDocumentArgs,
  save_document: SaveDocumentArgs, recategorize_document: RecategorizeDocumentArgs, move_document: MoveDocumentArgs,
  save_product_doc: SaveProductDocArgs, review_draft: ReviewDraftArgs, validate_artifact: ValidateArtifactArgs,
  find_code: FindCodeArgs, find_affected_files: FindAffectedFilesArgs,
  ...TASK_INPUT_SCHEMAS,
};
function inputSchema(name: string): Schema | undefined {
  const validator = inputValidators[name];
  return validator ? z.toJSONSchema(validator, { target: "openapi-3.0", io: "input" }) as Schema : undefined;
}
const errorDescriptions: Record<string, string> = {
  "400": "Invalid JSON, invalid arguments, or handler rejection.",
  "401": "Missing or invalid bearer credential.",
  "403": "Origin or credential not permitted.",
  "404": "Unknown resource or disabled preview.",
  "405": "Method not allowed.",
  "409": "Task revision, approval, or execution conflict.",
  "500": "Internal operation failed.",
  "503": "Required service unavailable.",
};
function operation(id: string, description: string, schema?: Schema): Operation {
  return {
    operationId: id,
    summary: id.replaceAll("_", " ").slice(0, 120),
    description: description.length > 290 ? `${description.slice(0, 287)}...` : description,
    ...(schema ? { requestBody: { required: true, content: { "application/json": { schema } } } } : {}),
    responses: {
      "200": { description: "Successful JSON result; fields depend on the operation.", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      ...Object.fromEntries(Object.keys(errorDescriptions).map(status => [status, { $ref: `#/components/responses/Error${status}` }])),
    },
  };
}
export function generateDocuments(options: { postSource?: string; getSource?: string } = {}): { api: ApiDocument; action: ApiDocument } {
  const definitions = new Map([...ALL_TOOL_DEFS, ...taskTools].map(tool => [tool.name, tool]));
  const paths: Paths = {};
  for (const [name, fallbackSchema] of discoverPostTools(options.postSource)) {
    const def = definitions.get(name);
    const schema = inputSchema(name) ?? fallbackSchema;
    if (!schema) throw new Error(`HTTP tool ${name} has no input schema`);
    paths[`/${name}`] = { post: operation(name.replaceAll("/", "_"), def?.description ?? `Floor registry operation: ${name}. Required governance fields are validated by the handler.`, schema) };
  }
  for (const [path, queries] of discoverGetRoutes(options.getSource)) {
    paths[path] ??= {};
    paths[path]!.get = { ...operation(`get_${path.slice(1).replaceAll("/", "_")}`, `Read ${path.slice(1)} from the daemon.`),
      ...(queries.length ? { parameters: queries.map(name => ({ name, in: "query", required: false, schema: { type: "string" } })) } : {}) };
  }
  // Task aliases are the SAME table that dispatchTaskHttp matches. Tool-style
  // task endpoints derive from taskTools, including the disabled-by-default preview.
  const taskRoutes = [
    ...taskTools.map(tool => ({ path: `/${tool.name}`, method: "POST", operation: tool.name })),
    ...TASK_HTTP_ROUTES,
  ];
  for (const route of taskRoutes) {
    const def = definitions.get(route.operation);
    if (!def) throw new Error(`Task route ${route.path} has no schema`);
    const schema = inputSchema(route.operation);
    if (!schema) throw new Error(`Task route ${route.path} has no input validator`);
    const parameters: Schema[] = [];
    if (route.path.includes("{id}")) {
      parameters.push({ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^[a-z0-9._:-]+$" } });
      delete (schema.properties as Schema).id;
      if (Array.isArray(schema.required)) schema.required = schema.required.filter(name => name !== "id");
    }
    paths[route.path] ??= {};
    paths[route.path]![route.method.toLowerCase()] = {
      ...operation(`local_${route.method.toLowerCase()}_${route.path.slice(1).replaceAll(/[/{}/]/g, "_")}`, `Local-only tasks preview (BASTRA_TASKS=1). Requires a mapped task credential and a loopback Host; a tunnel cannot access this route. ${def.description}`, route.method === "GET" ? undefined : schema),
      "x-local-only": true,
      security: [{ taskCredential: [] }],
      ...(parameters.length ? { parameters } : {}),
    };
  }
  const api: ApiDocument = {
    openapi: "3.0.3",
    info: { title: "Bastra.Recall REST API", version: JSON.parse(readFileSync(resolve(root, "packages/daemon/package.json"), "utf8")).version,
      description: "Generated from HTTP dispatchers and shared input schemas. JSON syntax is valid YAML 1.2. Result bodies are intentionally open objects: handlers have no shared response schemas. Public clients require an HTTPS tunnel and BASTRA_API_TOKEN. Task routes are local-only and disabled by default." },
    servers: [{ url: "http://127.0.0.1:6723/api/v1" }], security: [{ bearerAuth: [] }],
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b, "en"))),
    components: {
      responses: Object.fromEntries(Object.entries(errorDescriptions).map(([status, description]) => [`Error${status}`, {
        description, content: { "application/json": { schema: {
          type: "object", properties: { error: { type: "string" } }, required: ["error"], additionalProperties: true,
        } } },
      }])),
      securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
      taskCredential: { type: "http", scheme: "bearer", description: "Mapped task credential, distinct from BASTRA_API_TOKEN. Loopback Host required." },
    } },
  };
  const action = structuredClone(api);
  action.info.title = "Bastra.Recall GPT Action";
  action.info.description = "Set the server URL to your HTTPS tunnel ending in /api/v1 and configure bearer authentication with BASTRA_API_TOKEN. Task routes are local-only and excluded. Document writes require BASTRA_DOCUMENT_WRITE=1. Response objects have operation-specific fields.";
  action.servers = [{ url: "https://YOUR-TUNNEL.example.com/api/v1" }];
  action.paths = Object.fromEntries(Object.entries(action.paths).map(([path, methods]) => [path,
    Object.fromEntries(Object.entries(methods).filter(([, op]) => !op["x-local-only"]))]).filter(([, methods]) => Object.keys(methods).length));
  delete action.components.securitySchemes.taskCredential;
  return { api, action };
}
export function generatedArtifacts(): Record<string, string> {
  const { api, action } = generateDocuments();
  return {
    "docs/openapi.yaml": `# Generated by npm run openapi:generate. Do not edit.\n${JSON.stringify(api, null, 2)}\n`,
    "docs/gpt-action.json": `${JSON.stringify(action, null, 2)}\n`,
  };
}
export function checkArtifacts(artifacts: Record<string, string>, read: (path: string) => string = path => readFileSync(resolve(root, path), "utf8")): string[] {
  return Object.entries(artifacts).filter(([path, expected]) => {
    try { return read(path) !== expected; } catch { return true; }
  }).map(([path]) => path);
}
export function personalizedAction(serverUrl: string): ApiDocument {
  const action = generateDocuments().action;
  action.servers = [{ url: actionServerUrl(serverUrl) }];
  return action;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const flags = new Map<string, string>();
    let check = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--check") { check = true; continue; }
      if ((arg !== "--server-url" && arg !== "--output") || !args[i + 1] || args[i + 1]!.startsWith("--")) {
        throw new Error("Usage: openapi:generate [--check | --server-url PUBLIC_HTTPS_URL [--output FILE]]");
      }
      if (flags.has(arg)) throw new Error(`Duplicate option ${arg}`);
      flags.set(arg, args[++i]!);
    }
    const serverUrl = flags.get("--server-url");
    const output = flags.get("--output");
    if (serverUrl) {
      if (check) throw new Error("--check verifies deterministic repository defaults; use --server-url separately.");
      const content = `${JSON.stringify(personalizedAction(serverUrl), null, 2)}\n`;
      if (output) {
        const target = resolve(output);
        if (["docs/openapi.yaml", "docs/gpt-action.json"].some(path => target === resolve(root, path))) {
          throw new Error("Choose a separate output file; repository defaults must remain deterministic.");
        }
        writeFileSync(target, content);
      } else process.stdout.write(content);
    } else {
      if (output) throw new Error("--output requires --server-url.");
      const artifacts = generatedArtifacts();
      if (check) {
        const stale = checkArtifacts(artifacts);
        if (stale.length) { console.error(`OpenAPI drift: ${stale.join(", ")}. Run npm run openapi:generate.`); process.exitCode = 1; }
      } else for (const [path, content] of Object.entries(artifacts)) writeFileSync(resolve(root, path), content);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "OpenAPI generation failed.");
    process.exitCode = 1;
  }
}
