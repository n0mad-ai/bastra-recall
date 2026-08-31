/**
 * hook-skip — fast path/extension filter for the PreToolUse hook.
 *
 * Goal: cheaply decide "is this Write/Edit even worth a recall round-trip?"
 * BEFORE we load `@bastra-recall/core` or hit the daemon. Pure stdlib, no
 * deps — kept in its own module so hook.ts can stay tight and so the
 * matrix is unit-testable in isolation.
 *
 * Heuristic (see issue #20):
 *   - Skip extensions: .txt, .rst, .log, .tmp, .cache, .lock — never source.
 *   - Skip .md OUTSIDE of any `docs/` segment. Docs writes can legitimately
 *     benefit from prior context, everything else (issue bodies, scratch
 *     notes, plan files) is transient.
 *   - Skip transient basenames: issue-*, pr-*, CHANGELOG*, README*,
 *     CONTRIBUTING*, LICENSE*, .env*.
 */
import * as path from "node:path";
import { closeSync, openSync, readSync } from "node:fs";

const SKIP_EXTENSIONS = new Set<string>([
  ".txt",
  ".rst",
  ".log",
  ".tmp",
  ".cache",
  ".lock",
]);

const SKIP_BASENAME_PATTERNS: RegExp[] = [
  /^issue-/i,
  /^pr-/i,
  /^CHANGELOG/i,
  /^README/i,
  /^CONTRIBUTING/i,
  /^LICENSE/i,
  /^\.env/,
];

/** #297: the vault's known memory types — a leading frontmatter block whose
 *  `type:` carries one of these marks a memory-shaped .md. Mirrors
 *  core/schema.ts MemoryTypeEnum; kept as a copy because this module must
 *  stay stdlib-only (it runs in the hook client BEFORE @bastra-recall/core
 *  is ever loaded, see the header). */
const MEMORY_TYPE_VALUES = new Set([
  "lesson",
  "preference",
  "project-fact",
  "meta-working",
  "decision",
  "workflow",
  "reference",
  "user-preference",
  "doc",
]);

/** True when `head` opens with a frontmatter block carrying a recognized
 *  memory `type:` — the same recognition Vault's loader applies. */
export function isMemoryShapedMarkdown(head: string | null): boolean {
  if (!head || !head.startsWith("---")) return false;
  const end = head.indexOf("\n---", 3);
  const fm = end === -1 ? head : head.slice(0, end);
  const m = /^type:\s*["']?([\w-]+)["']?\s*$/m.exec(fm);
  return m !== null && MEMORY_TYPE_VALUES.has(m[1]!);
}

/** #297: head of the pending write for the memory-shape check. `Write`
 *  carries the new content inline; `Edit`/`MultiEdit` only carry edit
 *  strings, so the existing file's head is read (2KB, sync — this runs in
 *  a short-lived hook process). Fail-open: unreadable → null. */
export function pendingWriteHead(filePath: string, toolInput?: Record<string, unknown>): string | null {
  const content = toolInput?.content;
  if (typeof content === "string") return content.slice(0, 2048);
  try {
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(2048);
      const n = readSync(fd, buf, 0, buf.length, 0);
      return buf.toString("utf8", 0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Returns `true` if the path should be skipped (no recall round-trip).
 * Returns `false` if the file is plausibly source code worth recalling for.
 *
 * `cwd` is currently informational only — kept in the signature so future
 * refinements (e.g. respect a project-level skip-list) don't have to break
 * the call sites.
 *
 * `toolInput` (#297) feeds the memory-shape exception: a `.md` outside
 * `docs/` normally skips, but a memory-shaped one (recognized `type:` in
 * frontmatter) must reach the daemon — that is the only place the
 * vault-location check can run. Looked at lazily, only on the branch that
 * would otherwise skip.
 */
export function shouldSkipPath(
  filePath: string,
  _cwd?: string,
  toolInput?: Record<string, unknown>,
): boolean {
  if (!filePath) return true;
  const norm = filePath.replace(/\\/g, "/");
  const ext = path.extname(norm).toLowerCase();
  const base = path.basename(norm);

  // Hard-skip basenames — transient or non-code regardless of extension.
  for (const rx of SKIP_BASENAME_PATTERNS) {
    if (rx.test(base)) return true;
  }

  // Hard-skip extensions.
  if (SKIP_EXTENSIONS.has(ext)) return true;

  // .md is conditional: keep ACTIVE if anywhere in the path is a `docs/`
  // segment (case-insensitive). Otherwise skip — issue bodies, ad-hoc
  // plans, scratch notes don't benefit from a project-wide recall.
  // #297 exception: a memory-shaped .md never skips, wherever it lives.
  if (ext === ".md") {
    const segments = norm.toLowerCase().split("/");
    const inDocs = segments.includes("docs");
    if (inDocs) return false;
    return !isMemoryShapedMarkdown(pendingWriteHead(filePath, toolInput));
  }

  return false;
}

// Scope-Kompatibilität (isScopeCompatible/passesScopeFilter/GLOBAL_SCOPES)
// lebt seit #360 in ./scope-filter.ts, NICHT hier: dieses Modul wird von
// hook.ts importiert — dem THIN CLIENT, der laut eigenem Kopfkommentar bei
// JEDEM Tool-Call neu startet und bewusst "stdlib + the dependency-free
// hook-skip/env modules only" lädt. hook.ts braucht nur `shouldSkipPath` und
// zahlt sonst den Import-Preis von `@bastra-recall/core/scope` bei jedem
// einzelnen Tool-Call mit, ohne die Funktion je zu nutzen (nur write-lane.ts
// ruft passesScopeFilter, und das Modul lädt core ohnehin schon komplett).
