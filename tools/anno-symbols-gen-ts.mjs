#!/usr/bin/env node
/**
 * anno-symbols-gen-ts — builds the anno-check symbol table for a TypeScript
 * repo, from the compiler instead of a code-graph engine.
 *
 * The reference producer (zzallirog's `anno-symbols-gen.py`) reads his
 * `codebase-memory-mcp` graph. That engine is his, the format is not: the
 * checker consumes exactly `symbols` and `_head` and nothing else, so a second
 * producer is all it takes for any TS repo to use the same gate.
 *
 *   node tools/anno-symbols-gen-ts.mjs [repo-root]
 *   → <root>/.codebase-memory/anno-symbols.json.gz
 *
 * Shape (fixed by the reference implementation):
 *
 *   {"_project": "<name>", "_head": "<git HEAD sha>",
 *    "symbols": {"<bareName>": ["<repo-rel-posix-path>", ...]}}
 *
 * The three rulings he measured against the real bastra table, applied here:
 *
 *   1. Name collisions enumerate EVERY defining file — the value is a list so a
 *      dep annotation can check its path hint against the full set. Never
 *      first-wins.
 *   2. Generics key on the bare identifier: `Foo`, never `Foo<T>`. His `@dep`
 *      parser is `([A-Za-z_$][\w$]*)`, which cannot hold a `<`. Overloads
 *      collapse onto one name.
 *   3. Re-exports resolve to the definition only. `export { Vault } from
 *      "./vault"` does NOT make index.ts a location — a re-export is an edge in
 *      the graph, not a node. Measured on his side across 237 bindings / 168
 *      symbols, zero of which recorded the re-export site.
 *
 * Verified against the bundle's example repo: the map this produces is
 * identical to the one his engine produced there (see __tests__/anno-symbols.test.ts).
 *
 * One deliberate widening: class members (methods, properties, accessors) are
 * emitted as symbols too. A `@dep vault.ts:handleAddOrChange` is exactly the
 * kind of coupling the gate exists for, and a table without it would report a
 * real annotation as broken. Interface and type-literal members stay out — they
 * are shape, not definition, and would flood the table with `id` / `title`.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";

const ts = createRequire(import.meta.url)("typescript");

const root = resolve(process.argv[2] ? String(process.argv[2]) : process.cwd());
const OUT_REL = join(".codebase-memory", "anno-symbols.json.gz");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", ".codebase-memory"]);

/** Every .ts/.tsx/.mts/.cts in the tree, minus build output and vendored code. */
function sources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") && entry !== ".codebase-memory") {
      if (entry !== ".") continue;
    }
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) sources(full, out);
    else if (/\.(m|c)?tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Declaration name as a bare identifier, or null if it cannot be one. */
function bareName(node) {
  const name = node.name;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text.replace(/^#/, "");
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null; // computed member — no identifier to anchor on
}

/** Names bound by a destructuring pattern, so `const {a, b} = x` yields a and b. */
function patternNames(binding, out) {
  if (ts.isIdentifier(binding)) {
    out.push(binding.text);
    return;
  }
  if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
    for (const el of binding.elements) {
      if (ts.isBindingElement(el)) patternNames(el.name, out);
    }
  }
}

function collect(sourceFile, add) {
  const visitTop = (node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      const n = bareName(node);
      if (n) add(n);
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        const names = [];
        patternNames(decl.name, names);
        names.forEach(add);
      }
    }
    // enum members are addressable definitions
    if (ts.isEnumDeclaration(node)) {
      for (const m of node.members) {
        const n = bareName(m);
        if (n) add(n);
      }
    }
    // class members: methods, properties, accessors — see the header note
    if (ts.isClassDeclaration(node)) {
      for (const m of node.members) {
        if (
          ts.isMethodDeclaration(m) ||
          ts.isPropertyDeclaration(m) ||
          ts.isGetAccessorDeclaration(m) ||
          ts.isSetAccessorDeclaration(m)
        ) {
          const n = bareName(m);
          if (n) add(n);
        }
      }
    }
    // a namespace/module body holds top-level declarations of its own
    if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
      const n = bareName(node);
      if (n) add(n);
      node.body.statements.forEach(visitTop);
    }
  };
  sourceFile.statements.forEach(visitTop);
  // NOTE: imports, export-from bindings and call sites are never visited —
  // ruling 3. Only declarations reach `add`.
}

const files = sources(root);
if (files.length === 0) {
  console.error(`anno-symbols-gen-ts: no TypeScript sources under ${root}`);
  process.exit(2);
}

/** name -> Set(paths) */
const symbols = new Map();
for (const file of files) {
  const rel = relative(root, file).split(sep).join("/");
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  collect(sf, (name) => {
    if (!symbols.has(name)) symbols.set(name, new Set());
    symbols.get(name).add(rel);
  });
}

let head = null;
try {
  head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  console.error("anno-symbols-gen-ts: not a git repo — the checker needs _head to match live HEAD");
  process.exit(2);
}

const payload = {
  _project: basename(root),
  _head: head,
  symbols: Object.fromEntries([...symbols.entries()].map(([name, paths]) => [name, [...paths].sort()])),
};

const dest = join(root, OUT_REL);
mkdirSync(join(root, ".codebase-memory"), { recursive: true });
writeFileSync(dest, gzipSync(Buffer.from(JSON.stringify(payload), "utf8")));

const count = Object.keys(payload.symbols).length;
console.log(
  `anno-symbols-gen-ts: ${count} symbols from ${files.length} files → ${OUT_REL} ` +
    `(project ${payload._project}, head ${head.slice(0, 8)})`
);
if (!existsSync(dest)) process.exit(1);
