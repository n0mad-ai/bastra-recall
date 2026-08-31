/**
 * #297: write-time vault-location check. A memory-shaped .md (recognized
 * `type:` frontmatter) written OUTSIDE the configured vault root is a silent
 * stray — it will never be indexed or recalled, and nothing else in the
 * pipeline ever notices. The write-lane appends this note to its output the
 * same way the size note rides along: deterministic, #152-framed,
 * non-blocking, fail-open.
 *
 * Compared against the RESPONDING daemon's vault root (not an env re-read in
 * the hook process) — an isolated agent with its own vault talks to its own
 * daemon and is measured against that root.
 */
import { open } from "node:fs/promises";
import * as path from "node:path";
import { isMemoryShapedMarkdown } from "./hook-skip.js";

/** Head of the pending write: `Write` carries content inline, edits read the
 *  existing file's first 2KB. Fail-open: unreadable → null. */
async function pendingHead(filePath: string, toolInput: Record<string, unknown>): Promise<string | null> {
  const content = toolInput.content;
  if (typeof content === "string") return content.slice(0, 2048);
  try {
    const fh = await open(filePath, "r");
    try {
      const buf = Buffer.alloc(2048);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.toString("utf8", 0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

function isInside(root: string, filePath: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(filePath));
  // Ein Vault-Unterordner darf `..sync` heißen — nur ein `..`-SEGMENT
  // verlässt den Baum (Codex-Gegenreview, P2).
  const escapes = rel === ".." || rel.startsWith(".." + path.sep) || rel.startsWith("../");
  return rel === "" || (!escapes && !path.isAbsolute(rel));
}

/**
 * Non-null when the pending write is a memory-shaped .md outside `vaultRoot`.
 * Only ever looks at `.md` paths; everything else returns null immediately.
 */
export async function memoryLocationNote(
  filePath: string,
  toolInput: Record<string, unknown>,
  vaultRoot: string | null,
): Promise<string | null> {
  if (!vaultRoot) return null;
  if (path.extname(filePath).toLowerCase() !== ".md") return null;
  if (isInside(vaultRoot, filePath)) return null;
  const head = await pendingHead(filePath, toolInput);
  if (!isMemoryShapedMarkdown(head)) return null;
  const typeMatch = head ? /^type:\s*["']?([\w-]+)["']?\s*$/m.exec(head) : null;
  const noteType = typeMatch?.[1] ?? "memory";
  return (
    `<vault-location-check file="${path.basename(filePath)}" type="${noteType}">` +
    `this file carries memory frontmatter but lives OUTSIDE the configured vault ` +
    `(${vaultRoot}) — it will never be indexed or recalled from here. If it is meant ` +
    `as a bastra memory, save it via save_memory (or move it under the vault root); ` +
    `if it is a plain document, ignore this note.</vault-location-check>`
  );
}
