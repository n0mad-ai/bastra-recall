import { createHash } from "node:crypto";
import tseslint from "typescript-eslint";

const functionTypes = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "StaticBlock",
  "PropertyDefinition",
]);

function label(node, source) {
  if (!node) return "anonymous";
  return node.name ?? JSON.stringify(node.value) ?? source.slice(...node.range).replace(/\s+/g, "");
}

function calleeName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression")
    return `${calleeName(node.object)}.${node.property.name ?? node.property.value ?? "computed"}`;
  if (node.type === "CallExpression") return `${calleeName(node.callee)}()`;
  if (node.type === "ChainExpression") return calleeName(node.expression);
  return node.type;
}

function anonymousPosition(node, parent) {
  if (["CallExpression", "NewExpression"].includes(parent?.type)) return `argument:${parent.arguments.indexOf(node)}`;
  if (parent?.type === "ArrayExpression") return `element:${parent.elements.indexOf(node)}`;
  if (parent?.type === "ConditionalExpression") return parent.consequent === node ? "then" : "else";
  if (parent?.type === "LogicalExpression") return parent.left === node ? "left" : "right";
  return node.type;
}

function segment(node, parent, source) {
  if (node.type === "VariableDeclarator") return `variable:${label(node.id, source)}`;
  if (["ClassDeclaration", "ClassExpression"].includes(node.type)) return `class:${label(node.id, source)}`;
  if (["Property", "MethodDefinition", "PropertyDefinition"].includes(node.type))
    return `${node.static ? "static-" : ""}property:${label(node.key, source)}`;
  if (["CallExpression", "NewExpression"].includes(node.type)) {
    const anchor = typeof node.arguments[0]?.value === "string" ? JSON.stringify(node.arguments[0].value) : "";
    return `call:${calleeName(node.callee)}:${anchor}`;
  }
  if (node.type === "BlockStatement" && !functionTypes.has(parent?.type)) return "block";
  if (functionTypes.has(node.type)) return `function:${node.id?.name ?? anonymousPosition(node, parent)}`;
  return null;
}

function ordinalSegment(node, part, path, ordinals) {
  const key = JSON.stringify([path, part]);
  const count = (ordinals.get(key) ?? 0) + 1;
  ordinals.set(key, count);
  // Calls and unnamed scopes may repeat. Named lexical owners must remain unique.
  if (
    ["CallExpression", "NewExpression", "BlockStatement", "StaticBlock", "ClassExpression"].includes(node.type) ||
    (["ArrowFunctionExpression", "FunctionExpression"].includes(node.type) && !node.id)
  )
    return `${part}#${count}`;
  return part;
}

export function analyzeFunctions(source) {
  const { ast, visitorKeys } = tseslint.parser.parseForESLint(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    range: true,
    loc: true,
    tokens: true,
  });
  const functions = [];
  const ordinals = new Map();
  const identities = new Set();
  function visit(node, parent, path) {
    const part = segment(node, parent, source);
    const next = part ? [...path, ordinalSegment(node, part, path, ordinals)] : path;
    if (functionTypes.has(node.type)) {
      const owner = ["MethodDefinition", "Property", "VariableDeclarator"].includes(parent?.type) ? parent : node;
      const identity = JSON.stringify(next);
      if (identities.has(identity))
        throw new Error(`Ambiguous function identity ${identity}; cannot share a lint budget.`);
      identities.add(identity);
      functions.push({ identity, range: owner.range });
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const children = Array.isArray(node[key]) ? node[key] : [node[key]];
      for (const child of children) {
        if (child?.type) visit(child, node, next);
      }
    }
  }
  visit(ast, null, []);
  return { functions, tokens: ast.tokens };
}

export function functionAt(message, source, parsed) {
  const lines = source.split("\n");
  const offset = lines.slice(0, message.line - 1).reduce((sum, line) => sum + line.length + 1, 0);
  const position = offset + message.column - 1;
  return (
    parsed.functions
      .filter(({ range: [start, end] }) => start <= position && position < end)
      .sort((a, b) => a.range[1] - a.range[0] - (b.range[1] - b.range[0]))[0] ?? {
      identity: "module",
      range: [0, source.length],
    }
  );
}

export function legacyFingerprint(message, owner, parsed) {
  const tokens = parsed.tokens
    .filter((token) => token.range[0] >= owner.range[0] && token.range[1] <= owner.range[1])
    .map((token) => [token.type, token.value]);
  return createHash("sha256")
    .update(JSON.stringify([message.message, tokens]))
    .digest("hex");
}
