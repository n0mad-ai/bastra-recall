import { TASK_CRUD_OPERATIONS } from "../src/task-service.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_TOOL_DEFS } from "../src/tool-defs.js";
import ts from "typescript";

/**
 * Drift gate: every tool must exist on BOTH MCP surfaces (#576).
 *
 * The daemon serves tools two ways, from two separate lists:
 *
 *   - `ALL_TOOL_DEFS` (tool-defs.ts) — what `GET /tools` returns, and what the
 *     forwarder falls back to.
 *   - the `ListToolsRequestSchema` handler in `boot-stdio.ts` (moved out of
 *     `index.ts` in #1039) — the embedded stdio server, which spreads its
 *     own set of arrays.
 *
 * A tool added to only the first one works through the forwarder and simply
 * does not exist over stdio: no error, no warning, just absent for every client
 * on that transport. That happened while building `find_code` and was caught by
 * review rather than by a test, which is the wrong way round for a mistake this
 * silent and this easy to repeat.
 *
 * So this reads the handler's source and checks that the two agree. Reading
 * source rather than booting an MCP server is deliberate: the failure being
 * guarded against is a MISSING REGISTRATION, which is visible in the source and
 * would cost a full server start to observe at runtime. The CLI drift gates in
 * this suite (`cli-help`, `cli-completion`, `cli-flag-validation`) parse
 * `cli.ts` the same way, for the same reason.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STDIO_TS = join(HERE, "..", "src", "boot-stdio.ts");

function descendants(root: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  function visit(node: ts.Node): void {
    nodes.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return nodes;
}

/** Locate the actual registration call, excluding imports and comments. */
function requestHandler(source: string, schema: string): ts.Node {
  const file = ts.createSourceFile(STDIO_TS, source, ts.ScriptTarget.Latest, true);
  const calls = descendants(file)
    .filter(ts.isCallExpression)
    .filter(
      (node) =>
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "setRequestHandler" &&
        ts.isIdentifier(node.arguments[0]!) &&
        node.arguments[0].text === schema
    );
  assert.equal(calls.length, 1, `expected exactly one ${schema} handler`);
  const handler = calls[0]!.arguments[1];
  assert.ok(handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)));
  return handler.body;
}

/** Only the value branches of a spread register groups, never its condition. */
function spreadGroups(expression: ts.Expression): string[] {
  if (ts.isParenthesizedExpression(expression)) return spreadGroups(expression.expression);
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isConditionalExpression(expression)) {
    return [...spreadGroups(expression.whenTrue), ...spreadGroups(expression.whenFalse)];
  }
  return [];
}

async function stdioToolArrays(source?: string): Promise<string[]> {
  source ??= await readFile(STDIO_TS, "utf8");
  return descendants(requestHandler(source, "ListToolsRequestSchema"))
    .filter(ts.isPropertyAssignment)
    .filter((node) => node.name.getText() === "tools" && ts.isArrayLiteralExpression(node.initializer))
    .flatMap((node) => (node.initializer as ts.ArrayLiteralExpression).elements)
    .filter(ts.isSpreadElement)
    .flatMap((node) => spreadGroups(node.expression));
}

function isToolName(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === "name";
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "name" &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "params" &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "req"
  );
}

function directToolNames(condition: ts.Node): string[] {
  return descendants(condition)
    .filter(ts.isBinaryExpression)
    .filter((node) => node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken)
    .filter((node) => isToolName(node.left) && ts.isStringLiteral(node.right))
    .map((node) => (node.right as ts.StringLiteral).text);
}

/** Task calls must be returned by the isTaskTool branch, not merely mentioned. */
function dispatchesTasks(branch: ts.IfStatement): boolean {
  const condition = branch.expression;
  if (
    !ts.isCallExpression(condition) ||
    !ts.isIdentifier(condition.expression) ||
    condition.expression.text !== "isTaskTool" ||
    !condition.arguments[0] ||
    !isToolName(condition.arguments[0])
  )
    return false;
  return descendants(branch.thenStatement)
    .filter(ts.isReturnStatement)
    .some((node) => {
      const call = node.expression;
      return (
        call &&
        ts.isCallExpression(call) &&
        ts.isIdentifier(call.expression) &&
        call.expression.text === "callTaskMcp" &&
        call.arguments[0] &&
        isToolName(call.arguments[0])
      );
    });
}

function isNamed(node: ts.Node | undefined, name: string): boolean {
  return node !== undefined && ts.isIdentifier(node) && node.text === name;
}

function answerToolKeys(source: ts.SourceFile): string[] {
  const map = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((node) => [...node.declarationList.declarations])
    .find((node) => isNamed(node.name, "answerToolHandlers"))?.initializer;
  if (!map || !ts.isNewExpression(map) || !isNamed(map.expression, "Map")) return [];
  const entries = map.arguments?.[0];
  if (!entries || !ts.isArrayLiteralExpression(entries)) return [];
  return entries.elements.filter(ts.isArrayLiteralExpression).flatMap(({ elements: [key, handler] }) => {
    return key && ts.isStringLiteral(key) && handler && ts.isIdentifier(handler) ? [key.text] : [];
  });
}

function isAnswerToolLookup(node: ts.Statement): boolean {
  if (!ts.isVariableStatement(node)) return false;
  const lookup = node.declarationList.declarations.find((decl) => isNamed(decl.name, "answerTool"))?.initializer;
  return (
    lookup !== undefined &&
    ts.isCallExpression(lookup) &&
    ts.isPropertyAccessExpression(lookup.expression) &&
    isNamed(lookup.expression.expression, "answerToolHandlers") &&
    lookup.expression.name.text === "get" &&
    lookup.arguments[0] !== undefined &&
    isToolName(lookup.arguments[0])
  );
}

function objectProperty(expression: ts.Expression | undefined, name: string): ts.Expression | undefined {
  if (!expression || !ts.isObjectLiteralExpression(expression)) return undefined;
  return expression.properties.filter(ts.isPropertyAssignment).find((prop) => isNamed(prop.name, name))?.initializer;
}

function serializesAnswerTool(result: ts.Expression | undefined): boolean {
  const content = objectProperty(result, "content");
  if (!content || !ts.isArrayLiteralExpression(content)) return false;
  const text = objectProperty(content.elements[0], "text");
  if (!text || !ts.isCallExpression(text) || !ts.isPropertyAccessExpression(text.expression)) return false;
  if (!isNamed(text.expression.expression, "JSON") || text.expression.name.text !== "stringify") return false;
  const value = text.arguments[0];
  if (!value || !ts.isAwaitExpression(value) || !ts.isCallExpression(value.expression)) return false;
  return isNamed(value.expression.expression, "answerTool");
}

/** A map entry only counts when the tool name is looked up and its result is returned. */
function returnsAnswerTool(branch: ts.Statement | undefined): boolean {
  if (!branch || !ts.isIfStatement(branch) || !isNamed(branch.expression, "answerTool")) return false;
  if (!ts.isBlock(branch.thenStatement)) return false;
  return branch.thenStatement.statements
    .filter(ts.isTryStatement)
    .flatMap(({ tryBlock }) => tryBlock.statements.filter(ts.isReturnStatement))
    .some(({ expression }) => serializesAnswerTool(expression));
}

function dispatchedTools(source: string): string[] {
  const handler = requestHandler(source, "CallToolRequestSchema");
  const nodes = descendants(handler);
  const branches = nodes.filter(ts.isIfStatement);
  const dispatchesAnswers = nodes
    .filter(ts.isBlock)
    .some(({ statements }) =>
      statements.some((statement, index) => isAnswerToolLookup(statement) && returnsAnswerTool(statements[index + 1]))
    );
  return [
    ...branches.flatMap((node) => directToolNames(node.expression)),
    ...(branches.some(dispatchesTasks) ? TASK_CRUD_OPERATIONS : []),
    ...(dispatchesAnswers ? answerToolKeys(handler.getSourceFile()) : []),
  ];
}

/** The spread array names inside ALL_TOOL_DEFS. */
async function canonicalToolArrays(): Promise<string[]> {
  const source = await readFile(join(HERE, "..", "src", "tool-defs.ts"), "utf8");
  const start = source.indexOf("export const ALL_TOOL_DEFS");
  assert.notEqual(start, -1);
  const end = source.indexOf("];", start);
  const block = source.slice(start, end);
  return [...block.matchAll(/\.\.\.(\w+)/g)].map((m) => m[1]!);
}

test("every tool group in ALL_TOOL_DEFS is also served over stdio", async () => {
  const canonical = await canonicalToolArrays();
  const stdio = await stdioToolArrays();

  assert.ok(canonical.length > 0, "ALL_TOOL_DEFS should spread at least one group");

  const missing = canonical.filter((name) => !stdio.includes(name));
  assert.deepEqual(
    missing,
    [],
    `these tool groups are in ALL_TOOL_DEFS but not in the stdio ListTools handler, ` +
      `so they are invisible to stdio clients: ${missing.join(", ")}. ` +
      `Add them to the handler in boot-stdio.ts.`
  );
});

test("code awareness is registered on both surfaces", async () => {
  // The concrete case the gate was written for.
  const stdio = await stdioToolArrays();
  const canonical = await canonicalToolArrays();
  assert.ok(canonical.includes("codeTools"), "codeTools missing from ALL_TOOL_DEFS");
  assert.ok(stdio.includes("codeTools"), "codeTools missing from the stdio ListTools handler");
});

test("every tool in ALL_TOOL_DEFS has a CallTool branch in the stdio server", async () => {
  // ListTools advertising a tool the CallTool chain cannot dispatch is the
  // other half of the same mistake: the client sees it and every call fails.
  const source = await readFile(STDIO_TS, "utf8");
  const dispatched = dispatchedTools(source);
  const undispatched = (ALL_TOOL_DEFS as Array<{ name: string }>)
    .map((def) => def.name)
    .filter((name) => !dispatched.includes(name));

  assert.deepEqual(undispatched, [], `advertised over stdio but never dispatched there: ${undispatched.join(", ")}`);
});

test("registration and dispatch gates ignore imports, comments and formatting", async () => {
  const source = await readFile(STDIO_TS, "utf8");
  const file = ts.createSourceFile(STDIO_TS, source, ts.ScriptTarget.Latest, true);
  const printed = ts.createPrinter().printFile(file);
  assert.deepEqual(await stdioToolArrays(printed), await stdioToolArrays(source));
  assert.deepEqual(dispatchedTools(printed), dispatchedTools(source));
  const missingGroup = source.replace("...codeTools,", "...[] /* codeTools */, ");
  assert.notEqual(missingGroup, source);
  assert.ok(!(await stdioToolArrays(missingGroup)).includes("codeTools"));
  const taskBranch = descendants(requestHandler(source, "CallToolRequestSchema"))
    .filter(ts.isIfStatement)
    .find(dispatchesTasks);
  assert.ok(taskBranch);
  const body = taskBranch.thenStatement;
  const missingDispatch =
    source.slice(0, body.getStart()) + "return undefined; /* callTaskMcp(name, rawArgs) */" + source.slice(body.end);
  assert.ok(!dispatchedTools(missingDispatch).includes("task_create"));
  const call = requestHandler(source, "CallToolRequestSchema").parent.parent as ts.CallExpression;
  const schema = call.arguments[0]!;
  const missingHandler = source.slice(0, schema.getStart()) + "OtherRequestSchema" + source.slice(schema.end);
  assert.throws(() => dispatchedTools(missingHandler), /exactly one CallToolRequestSchema handler/);
});

test("answer handlers need both a map key and the returned dispatch through that map", async () => {
  const source = await readFile(STDIO_TS, "utf8");
  assert.ok(dispatchedTools(source).includes("onboarding_answer"));
  const missingKey = source.replace('["onboarding_answer", onboardingAnswerHandler],', "");
  assert.ok(!dispatchedTools(missingKey).includes("onboarding_answer"));
  assert.ok(dispatchedTools(missingKey).includes("review_draft"));
  const missingLookup = source.replace("answerToolHandlers.get(name)", 'answerToolHandlers.get("name")');
  assert.ok(!dispatchedTools(missingLookup).includes("onboarding_answer"));
  const missingReturn = source.replace("await answerTool(toolDeps, args ?? {})", "null /* await answerTool(...) */");
  assert.ok(!dispatchedTools(missingReturn).includes("onboarding_answer"));
});
