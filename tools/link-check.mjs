/**
 * #523 — the local-link check.
 *
 * `docs/architecture.md` linked to `./docs/survival.md` from inside `docs/`,
 * which resolves to `docs/docs/survival.md` and does not exist. Nothing in the
 * repository noticed: relative paths are only ever followed by a reader, and a
 * reader who hits a 404 on GitHub rarely files an issue about it.
 *
 * Two failure shapes, both found in the release-gate review, both covered here:
 *
 *  1. an INLINE link `[text](./path)` whose target file is not on disk;
 *  2. a REFERENCE-style link `[text][label]`, `[label][]` or a `## [label]`
 *     heading whose `[label]: …` definition is missing — CHANGELOG.md carried
 *     linked headings for 0.9.1 and 0.9.2 while the definitions stopped at
 *     0.9.0, so both newest headings rendered as literal bracket text.
 *
 * Deliberately NOT checked: anything with a scheme (`https:`, `mailto:`), and
 * pure `#anchor` fragments. Remote links need the network and would make the
 * check flaky; anchors need a heading model this does not need to own.
 *
 * Used by `tools/__tests__/local-links.test.mjs`, so it runs in `npm test` and
 * therefore in CI, on every platform — it reads files and nothing else.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Directories that carry no documentation contract of their own. */
const SKIP_DIRS = new Set([
  ".git",
  ".claude",
  "node_modules",
  "dist",
  "coverage",
  ".venv",
]);

/** Collect every `*.md` file under `root`, depth-first and in a stable order. */
export function markdownFiles(root = REPO_ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name.startsWith(".") && entry.name !== ".github") {
        if (!SKIP_DIRS.has(entry.name)) continue;
      }
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Strip inline code spans: `[a-z][a-z_-]*` in prose is a regex, not a link. */
function withoutCodeSpans(text) {
  return text.replace(/`+[^`\n]*`+/g, " ");
}

/** Strip fenced code blocks, so a sample link inside ``` is not a claim. */
function withoutCodeFences(text) {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return "";
      }
      return inFence ? "" : line;
    })
    .join("\n");
}

const INLINE = /\[[^\]\n]*\]\(([^()\s]+(?:\([^()\s]*\)[^()\s]*)*)\)/g;
const DEFINITION = /^\[([^\]\n]+)\]:/gm;
const FULL_REFERENCE = /\[[^\]\n]*\]\[([^\]\n]+)\]/g;
const COLLAPSED_REFERENCE = /\[([^\]\n]+)\]\[\]/g;
const HEADING_REFERENCE = /^#{1,6}\s+\[([^\]\n]+)\]\s*(?:—|-|–|$)/gm;

function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

/**
 * Every broken local link in one markdown file.
 * @returns {Array<{file: string, kind: "inline"|"reference", target: string}>}
 */
export function checkFile(file, root = REPO_ROOT) {
  const raw = readFileSync(file, "utf8");
  const text = withoutCodeSpans(withoutCodeFences(raw));
  const problems = [];
  const rel = relative(root, file);

  for (const match of text.matchAll(INLINE)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    // A title after the URL (`(./x.md "T")`) cannot reach here: the pattern
    // stops at the first whitespace, so `target` is the URL alone.
    if (!target || isExternal(target) || target.startsWith("#")) continue;
    const path = decodeURI(target.split("#")[0].split("?")[0]);
    if (!path) continue;
    // A root-relative link is a site path, not a repository path.
    if (path.startsWith("/")) continue;
    const resolved = resolve(dirname(file), path);
    // `../../wiki/Page` from the repository root is a GitHub Wiki link: it
    // resolves on github.com and deliberately points outside the checkout.
    if (relative(root, resolved).startsWith("..")) continue;
    let ok = false;
    try {
      statSync(resolved);
      ok = true;
    } catch {
      ok = false;
    }
    if (!ok) problems.push({ file: rel, kind: "inline", target });
  }

  const defined = new Set(
    [...text.matchAll(DEFINITION)].map((m) => m[1].trim().toLowerCase()),
  );
  const used = new Set();
  for (const match of text.matchAll(FULL_REFERENCE)) used.add(match[1].trim().toLowerCase());
  for (const match of text.matchAll(COLLAPSED_REFERENCE)) used.add(match[1].trim().toLowerCase());
  // A heading of the shape `## [0.9.2] — date` is a shortcut reference; the
  // generic shortcut form is not scanned, because ordinary prose in brackets
  // would be indistinguishable from it.
  for (const match of text.matchAll(HEADING_REFERENCE)) used.add(match[1].trim().toLowerCase());
  for (const label of used) {
    if (!defined.has(label)) problems.push({ file: rel, kind: "reference", target: `[${label}]` });
  }

  return problems;
}

/** Every broken local link in the repository. */
export function checkRepository(root = REPO_ROOT) {
  return markdownFiles(root).flatMap((file) => checkFile(file, root));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const problems = checkRepository();
  for (const p of problems) console.error(`${p.file}: ${p.kind} link does not resolve — ${p.target}`);
  console.error(`${problems.length} broken local link(s)`);
  process.exit(problems.length === 0 ? 0 : 1);
}
