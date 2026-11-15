import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";

const baselinePath = new URL("../eslint-structure-baseline.json", import.meta.url);
const structuralRules = new Set(["complexity", "max-depth"]);
const functionTypes = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "StaticBlock",
  "PropertyDefinition",
]);

function functionRanges(source) {
  const { ast, visitorKeys } = tseslint.parser.parseForESLint(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    range: true,
    loc: true,
    tokens: true,
  });
  const ranges = [];
  function visit(node, parent) {
    if (functionTypes.has(node.type)) {
      const owner = ["MethodDefinition", "Property", "VariableDeclarator"].includes(parent?.type) ? parent : node;
      ranges.push(owner.range);
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const children = Array.isArray(node[key]) ? node[key] : [node[key]];
      for (const child of children) {
        if (child?.type) visit(child, node);
      }
    }
  }
  visit(ast, null);
  return { ranges, tokens: ast.tokens };
}

function fingerprint(message, source, parsed) {
  const lines = source.split("\n");
  const offset = lines.slice(0, message.line - 1).reduce((sum, line) => sum + line.length + 1, 0);
  const position = offset + message.column - 1;
  const range = parsed.ranges
    .filter(([start, end]) => start <= position && position < end)
    .sort((a, b) => a[1] - a[0] - (b[1] - b[0]))[0] ?? [0, source.length];
  const tokens = parsed.tokens
    .filter((token) => token.range[0] >= range[0] && token.range[1] <= range[1])
    .map((token) => [token.type, token.value]);
  return createHash("sha256")
    .update(JSON.stringify([message.message, tokens]))
    .digest("hex");
}

export async function inspectStructure(paths = ["packages", "scripts", "tools"]) {
  // Read raw findings: native file/rule counters cannot freeze individual functions.
  const eslint = new ESLint({ applySuppressions: false, allowInlineConfig: false });
  const results = await eslint.lintFiles(paths);
  const findings = {};
  for (const result of results) {
    const messages = result.messages.filter((message) => structuralRules.has(message.ruleId));
    if (!messages.length) continue;
    const source = result.source ?? readFileSync(result.filePath, "utf8");
    const parsed = functionRanges(source);
    const file = relative(process.cwd(), result.filePath).split("\\").join("/");
    for (const message of messages) {
      const key = `${file}:${message.ruleId}:${fingerprint(message, source, parsed)}`;
      findings[key] = (findings[key] ?? 0) + 1;
      message.baselineKey = key;
    }
  }
  return { eslint, results, findings: Object.fromEntries(Object.entries(findings).sort()) };
}

function compareBaseline(baseline, findings) {
  const added = Object.keys(findings).filter((key) => findings[key] > (baseline[key] ?? 0));
  const removed = Object.keys(baseline).filter((key) => baseline[key] > (findings[key] ?? 0));
  return { added, removed };
}

async function main() {
  const prune = process.argv.includes("--prune");
  const paths = process.argv.slice(2).filter((argument) => argument !== "--prune");
  if (prune && paths.length) throw new Error("Prune requires the complete project; omit file arguments.");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const { eslint, results, findings } = await inspectStructure(paths.length ? paths : undefined);
  const { added, removed } = compareBaseline(baseline, findings);
  const allowed = new Set(Object.keys(baseline).filter((key) => !added.includes(key)));
  const visible = results.map((result) => {
    const messages = result.messages.filter((message) => !allowed.has(message.baselineKey));
    return {
      ...result,
      messages,
      errorCount: messages.filter((message) => message.severity === 2).length,
      warningCount: messages.filter((message) => message.severity === 1).length,
    };
  });
  const formatter = await eslint.loadFormatter("stylish");
  process.stdout.write(formatter.format(visible));
  if (added.length) {
    console.error(
      "Structure limit exceeded: complexity <=15, nesting <=4. Split responsibilities using existing modules; preserve useful module interfaces. Changed functions must meet the limits. Do not add suppressions or expand the baseline."
    );
  }
  if (prune && !added.length) {
    writeFileSync(baselinePath, JSON.stringify(findings, null, 2) + "\n");
    console.log(`Structure baseline lowered: ${removed.length} obsolete entries removed.`);
  } else if (removed.length && !paths.length) {
    console.error(
      `Structure baseline has ${removed.length} obsolete entries. Run npm run lint:prune after the cleanup and commit the smaller baseline.`
    );
  }
  const errors = visible.reduce((sum, result) => sum + result.errorCount, 0);
  process.exitCode = errors || (!prune && !paths.length && removed.length) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
