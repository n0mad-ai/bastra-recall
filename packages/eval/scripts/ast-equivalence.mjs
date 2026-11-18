#!/usr/bin/env node
/**
 * Proof that the one-time Prettier commit changed layout, not code (#1536).
 *
 * `registrations/fingerprint-map-1536.json` maps the source fingerprints that
 * 0f9f0604 changed and calls the change behaviour-neutral. This script is the
 * evidence behind that word: for every file a formatter case of the mapping
 * hashes, it parses the file as it was before and after the commit with the
 * TypeScript parser and compares the syntax trees. Comments and whitespace are
 * not part of a tree; quote style, number spelling and redundant parentheses
 * are compared by what they mean (the string value, the numeric value, the
 * grouping the tree already encodes, regex flags in sorted order, `||`/`&&`/`??`
 * chains as one flat chain), so only a real change shows up. Directive
 * prologues ("use strict") are kept by their raw text before any of that: a
 * parenthesised or escaped string there is no directive and reads differently.
 *
 *   node packages/eval/scripts/ast-equivalence.mjs               # formatter cases, JSON to stdout
 *   node packages/eval/scripts/ast-equivalence.mjs --out <file>  # same, written to <file>
 *   node packages/eval/scripts/ast-equivalence.mjs --all         # every JS/TS file the commit touched
 *
 * Exit 0 when every compared tree is equal, 1 when any file differs or does
 * not parse, 2 on a usage error. Read-only towards git (`git show`,
 * `git diff-tree`, `git rev-parse`). The output carries no timestamp, so a
 * rerun at the same commit is byte-identical.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { FORMATTER_COMMIT, RECIPES } from "./fingerprint-history.mjs";

const MAP_PATH = join(import.meta.dirname, "..", "registrations", "fingerprint-map-1536.json");
const KINDS = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
};
/** Node flags that change meaning: let/const/using, namespace form, `?.` chains. */
const MEANINGFUL_FLAGS =
  ts.NodeFlags.BlockScoped |
  ts.NodeFlags.Namespace |
  ts.NodeFlags.NestedNamespace |
  ts.NodeFlags.GlobalAugmentation |
  ts.NodeFlags.OptionalChain;

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const git = (args) =>
  execFileSync("git", args, { encoding: "buffer", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "ignore"] });

/** The leaf value a node stands for, independent of how it is spelled. */
function leafValue(node) {
  switch (node.kind) {
    case ts.SyntaxKind.RegularExpressionLiteral: {
      // Flag order carries no meaning; Prettier sorts the flags.
      const cut = node.text.lastIndexOf("/");
      return node.text.slice(0, cut + 1) + [...node.text.slice(cut + 1)].sort().join("");
    }
    case ts.SyntaxKind.Identifier:
    case ts.SyntaxKind.PrivateIdentifier:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.JsxText:
      return node.text;
    case ts.SyntaxKind.StringLiteral:
      return JSON.stringify(node.text);
    case ts.SyntaxKind.NumericLiteral:
      return String(Number(node.text));
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateHead:
    case ts.SyntaxKind.TemplateMiddle:
    case ts.SyntaxKind.TemplateTail:
      // The raw text, because String.raw and tagged templates see it.
      return JSON.stringify(node.rawText ?? node.text);
    default:
      return null;
  }
}

/**
 * `||`, `&&` and `??` are associative in value and in evaluation order, so
 * `a || (b || c)` and `a || b || c` are one chain. Prettier drops such
 * parentheses, which re-nests the tree; the chain is compared flat.
 */
const CHAIN_OPERATORS = new Set([
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

const unwrap = (node) => (node.kind === ts.SyntaxKind.ParenthesizedExpression ? unwrap(node.expression) : node);

function chainOperands(node, op) {
  const n = unwrap(node);
  if (n.kind === ts.SyntaxKind.BinaryExpression && n.operatorToken.kind === op)
    return [...chainOperands(n.left, op), ...chainOperands(n.right, op)];
  return [n];
}

/**
 * The directive statements of the file and of every function body: the leading
 * statements that are a bare string literal. A parenthesised string is an
 * ordinary expression there, and the parser leaves it a ParenthesizedExpression.
 */
function directives(sf) {
  const found = new Set();
  const prologue = (statements) => {
    for (const s of statements) {
      if (!ts.isExpressionStatement(s) || !ts.isStringLiteral(s.expression)) break;
      found.add(s);
    }
  };
  const walk = (node) => {
    if (ts.isSourceFile(node)) prologue(node.statements);
    else if (ts.isFunctionLike(node) && node.body && ts.isBlock(node.body)) prologue(node.body.statements);
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return found;
}

/** The tree as one line per node, parentheses unwrapped (the tree keeps the grouping). */
export function serializeTree(source, fileName) {
  const kind = KINDS[extname(fileName)];
  if (kind === undefined) throw new Error(`not a JS/TS file: ${fileName}`);
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind);
  const prologue = directives(sf);
  const lines = [];
  const visit = (node, depth) => {
    if (prologue.has(node)) {
      // A directive means what its raw text says ("use strict" only unescaped); the quotes are layout.
      const literal = node.expression;
      lines.push(`${depth} Directive ${JSON.stringify(sf.text.slice(literal.getStart(sf) + 1, literal.end - 1))}`);
      return;
    }
    if (node.kind === ts.SyntaxKind.ParenthesizedExpression || node.kind === ts.SyntaxKind.ParenthesizedType) {
      visit(node.expression ?? node.type, depth);
      return;
    }
    if (node.kind === ts.SyntaxKind.BinaryExpression && CHAIN_OPERATORS.has(node.operatorToken.kind)) {
      const op = node.operatorToken.kind;
      lines.push(`${depth} LogicalChain ${ts.SyntaxKind[op]}`);
      for (const operand of chainOperands(node, op)) visit(operand, depth + 1);
      return;
    }
    const flags = node.flags & MEANINGFUL_FLAGS;
    const value = leafValue(node);
    lines.push(`${depth} ${ts.SyntaxKind[node.kind]}${flags ? ` f${flags}` : ""}${value === null ? "" : ` ${value}`}`);
    ts.forEachChild(node, (child) => visit(child, depth + 1));
  };
  visit(sf, 0);
  return { text: lines.join("\n"), parseErrors: sf.parseDiagnostics?.length ?? 0 };
}

/** First differing line of two serialisations, for the report. */
function firstDifference(a, b) {
  const x = a.split("\n");
  const y = b.split("\n");
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if (x[i] !== y[i]) return { node: i, before: x[i] ?? null, after: y[i] ?? null };
  return null;
}

/** Compare one file across `parent` → `commit`. */
export function compareFile(file, parent, commit) {
  const before = git(["show", `${parent}:${file}`]);
  const after = git(["show", `${commit}:${file}`]);
  const row = { file, before_sha256: sha256(before), after_sha256: sha256(after) };
  const a = serializeTree(before.toString("utf8"), file);
  const b = serializeTree(after.toString("utf8"), file);
  if (a.parseErrors || b.parseErrors)
    return { ...row, equal: false, reason: `parse errors before ${a.parseErrors}, after ${b.parseErrors}` };
  const diff = firstDifference(a.text, b.text);
  return {
    ...row,
    byte_identical: row.before_sha256 === row.after_sha256,
    ast_sha256: sha256(b.text),
    equal: diff === null,
    ...(diff ? { first_difference: diff } : {}),
  };
}

/** The files the formatter cases of the mapping hash, in mapping order, deduplicated. */
export function formatterCaseFiles(map = JSON.parse(readFileSync(MAP_PATH, "utf8"))) {
  const files = map.formatter_breaks.flatMap((e) => {
    const recipe = RECIPES[e.recipe];
    if (!recipe) throw new Error(`mapping names an unknown recipe: ${e.recipe}`);
    return recipe.files;
  });
  return [...new Set(files)];
}

/** Every JS/TS file the commit changed. */
function changedFiles(commit) {
  return git(["diff-tree", "--no-commit-id", "--name-only", "-r", "--diff-filter=M", commit])
    .toString("utf8")
    .split("\n")
    .filter((f) => f && KINDS[extname(f)] !== undefined);
}

export function run({ all = false } = {}) {
  const commit = git(["rev-parse", `${FORMATTER_COMMIT}^{commit}`])
    .toString("utf8")
    .trim();
  const parent = git(["rev-parse", `${commit}^`])
    .toString("utf8")
    .trim();
  const files = all ? changedFiles(commit) : formatterCaseFiles();
  const rows = files.map((f) => compareFile(f, parent, commit));
  const differing = rows.filter((r) => !r.equal).map((r) => r.file);
  return {
    schema_version: 1,
    issue: 1536,
    purpose: "AST equivalence of the one-time Prettier commit for the files its fingerprint breaks hash",
    command: `node packages/eval/scripts/ast-equivalence.mjs${all ? " --all" : ""}`,
    scope: all
      ? "every modified JS/TS file of the commit"
      : "files of the formatter_breaks in fingerprint-map-1536.json",
    formatter_commit: commit,
    parent_commit: parent,
    parser: `typescript ${ts.version}`,
    method:
      "TypeScript parse tree without trivia (comments, whitespace); string and template literals by value " +
      "(templates by raw text), numbers by numeric value, regex flags sorted, parentheses unwrapped, " +
      "||/&&/?? chains flattened, let/const/namespace/optional-chain flags kept, directive prologues by raw text",
    script_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    summary: { files: rows.length, equal: rows.length - differing.length, differing },
    files: rows,
  };
}

function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const outAt = args.indexOf("--out");
  const out = outAt >= 0 ? args[outAt + 1] : null;
  const known = args.filter((a, i) => a === "--all" || i === outAt || (outAt >= 0 && i === outAt + 1));
  if ((outAt >= 0 && !out) || known.length !== args.length) {
    console.error("usage: ast-equivalence.mjs [--all] [--out <file>]");
    process.exit(2);
  }
  const result = run({ all });
  const body = JSON.stringify(result, null, 2) + "\n";
  if (out) writeFileSync(out, body);
  else process.stdout.write(body);
  const { files, equal, differing } = result.summary;
  console.error(
    `[ast-equivalence] ${equal}/${files} equal${differing.length ? `; differing: ${differing.join(", ")}` : ""}`
  );
  process.exit(differing.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
