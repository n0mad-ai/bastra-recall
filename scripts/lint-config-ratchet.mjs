import ts from "typescript";
import { digest } from "./lint-knip-findings.mjs";
import { knipPackageAllowed } from "./lint-knip-contract.mjs";

const exclusions = new Set(["ignore", "ignorePattern", "ignores", "exclude"]);
const limits = new Set(["max", "max-depth", "minLines", "minTokens", "threshold"]);

function children(node) {
  const result = [];
  ts.forEachChild(node, (child) => {
    result.push(child);
  });
  return result;
}

/** What a node holds itself, outside its child nodes: identifier and literal
 *  text (strings, template head/middle/tail, regular expressions) and a unary
 *  operator. Anything lost here would pass as unchanged (#1646). */
function own(node) {
  if (ts.isNumericLiteral(node)) return [node.kind, Number(node.text)];
  if (ts.isIdentifier(node) || ts.isLiteralKind(node.kind) || ts.isTemplateLiteralKind(node.kind))
    return [node.kind, node.text];
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) return [node.kind, node.operator];
  return [node.kind];
}

function canonical(node) {
  return [...own(node), children(node).map(canonical)];
}

function same(before, after) {
  return JSON.stringify(canonical(before)) === JSON.stringify(canonical(after));
}

function name(property) {
  return property.name?.text ?? JSON.stringify(canonical(property));
}

function widerGlob(before, after) {
  if (!ts.isStringLiteralLike(before) || !ts.isStringLiteralLike(after)) return false;
  // Replacing a lower-case letter by its explicit case pair only adds matches.
  return (
    before.text ===
    after.text.replace(/\[([a-z])([A-Z])\]/g, (pair, lower, upper) => (lower.toUpperCase() === upper ? lower : pair))
  );
}

function arrayAllowed(before, after, key) {
  if (exclusions.has(key)) return after.elements.every((entry) => before.elements.some((old) => same(old, entry)));
  if (key === "files") {
    if (after.elements.some((entry) => !ts.isStringLiteralLike(entry) || entry.text.startsWith("!"))) return false;
    return before.elements.every((old) => after.elements.some((entry) => same(old, entry) || widerGlob(old, entry)));
  }
  return (
    before.elements.length === after.elements.length &&
    before.elements.every((entry, index) => allowed(entry, after.elements[index], key))
  );
}

function objectAllowed(before, after) {
  const previous = new Map(before.properties.map((property) => [name(property), property]));
  const candidate = new Map(after.properties.map((property) => [name(property), property]));
  if (previous.size !== before.properties.length || candidate.size !== after.properties.length) return false;
  if ([...candidate.keys()].some((key) => !previous.has(key))) return false;
  const retained = [...previous.keys()].filter((key) => candidate.has(key));
  if (JSON.stringify(retained) !== JSON.stringify([...candidate.keys()])) return false;
  return [...previous].every(([key, property]) => {
    const next = candidate.get(key);
    if (!next) return exclusions.has(key);
    return allowed(property, next, key);
  });
}

function allowed(before, after, key = "") {
  if (same(before, after)) return true;
  if (before.kind !== after.kind) return false;
  if (ts.isNumericLiteral(before) && limits.has(key)) return Number(after.text) <= Number(before.text);
  if (ts.isPropertyAssignment(before))
    return same(before.name, after.name) && allowed(before.initializer, after.initializer, name(before));
  if (ts.isObjectLiteralExpression(before)) return objectAllowed(before, after);
  if (ts.isArrayLiteralExpression(before)) return arrayAllowed(before, after, key);
  const previous = children(before);
  const candidate = children(after);
  if (!previous.length || JSON.stringify(own(before)) !== JSON.stringify(own(after))) return false;
  return previous.length === candidate.length && previous.every((node, index) => allowed(node, candidate[index], key));
}

function parse(source, file) {
  const text = file.endsWith(".json") ? `const config = (${source});` : source;
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (tree.parseDiagnostics.length) throw new Error(`${file}: invalid lint configuration syntax`);
  return tree;
}

function lintScripts(source) {
  const scripts = JSON.parse(source).scripts ?? {};
  return Object.fromEntries(Object.entries(scripts).filter(([key]) => key === "lint" || key.startsWith("lint:")));
}

function scopeValues(source) {
  const values = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ["codeIgnores", "CODE_PATTERN"].includes(node.name.text)
    ) {
      values.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source, "lint-scope.mjs"));
  return values;
}

function scopeAllowed(before, after) {
  const previous = scopeValues(before);
  const candidate = scopeValues(after);
  return ["codeIgnores", "CODE_PATTERN"].every((key) => {
    const old = previous.get(key);
    const next = candidate.get(key);
    if (!old || !next) return false;
    return key === "CODE_PATTERN" ? same(old, next) || widerGlob(old, next) : allowed(old, next, "ignores");
  });
}

// This is a deliberately narrow contract: unknown operational rewrites need review.
// It accepts proven lower limits/removals rather than freezing file hashes.
export function lintConfigurationAllowed(file, before, after) {
  if (file === "knip.json") return digest(JSON.parse(before)) === digest(JSON.parse(after));
  if (file === "package.json") {
    if (JSON.parse(before).devDependencies?.knip && !knipPackageAllowed(before, after)) return false;
    const previous = lintScripts(before);
    const candidate = lintScripts(after);
    return Object.entries(previous).every(([key, value]) => candidate[key] === value);
  }
  if (file === "scripts/lint-scope.mjs") return scopeAllowed(before, after);
  return allowed(parse(before, file), parse(after, file));
}
