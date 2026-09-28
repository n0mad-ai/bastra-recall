/**
 * The clients' own file-based memory directories (#674).
 *
 * Claude Code keeps a memory folder per project
 * (`~/.claude/projects/<project>/memory/*.md`, `CLAUDE_CONFIG_DIR` moves it)
 * and Codex one per user (`~/.codex/memories`, `CODEX_HOME` moves it). An agent
 * that saves there instead of through `save_memory` writes notes recall never
 * sees: 78 had piled up on a contributor's machines before he promoted them by
 * hand.
 *
 * `bastra doctor` reports the folders that hold notes and how many of them are
 * not in the vault yet; `bastra import clients` imports each through the
 * existing folder import (`importVault`, Claude Code adapter included), which
 * is idempotent (#530) and writes through the audit trail.
 */
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { slugify } from "@bastra-recall/core";
import { IMPORT_ROOT, listSourceMarkdown } from "../import-vault.js";

export interface ClientMemoryDir {
  client: "claude-code" | "codex";
  dir: string;
  /** The label `bastra import clients` imports it under. */
  label: string;
  /** Markdown notes in the folder (the `MEMORY.md` index not counted). */
  notes: number;
  /** Notes changed since this folder was last imported (all, if never). */
  pending: number;
}

export interface ClientMemoryEnv {
  home: string;
  claudeConfigDir?: string;
  codexHome?: string;
}

export function defaultClientMemoryEnv(): ClientMemoryEnv {
  return {
    home: homedir(),
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || undefined,
    codexHome: process.env.CODEX_HOME || undefined,
  };
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function mtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/** Claude Code names a project folder after its path with every non-alphanumeric
 *  character turned into `-`; the home prefix carries no information. */
function claudeProjectLabel(project: string, home: string): string {
  const homeSlug = home.replace(/[^a-zA-Z0-9]/g, "-") + "-";
  const rest = project.startsWith(homeSlug) ? project.slice(homeSlug.length) : project;
  try {
    return slugify(`claude-code-${rest}`) || "claude-code";
  } catch {
    return "claude-code";
  }
}

async function describe(
  client: ClientMemoryDir["client"],
  dir: string,
  label: string,
  vaultRoot: string | null,
): Promise<ClientMemoryDir | null> {
  // The very walk `bastra import clients` runs, so what doctor counts is what
  // the import writes (subfolders included, MEMORY.md and dotdirs not).
  const files = await listSourceMarkdown(dir);
  if (files.length === 0) return null;
  // The import writes a marker into its folder on every run that changed
  // something; a note newer than it has not been imported yet.
  const importedAt = vaultRoot ? await mtime(join(vaultRoot, IMPORT_ROOT, label, ".bastra-imported")) : null;
  let pending = 0;
  for (const f of files) {
    const m = await mtime(f);
    if (m !== null && (importedAt === null || m > importedAt)) pending += 1;
  }
  return { client, dir, label, notes: files.length, pending };
}

/** Every client memory folder that holds at least one note. Never throws. */
export async function findClientMemoryDirs(
  vaultRoot: string | null,
  env: ClientMemoryEnv = defaultClientMemoryEnv(),
): Promise<ClientMemoryDir[]> {
  const out: ClientMemoryDir[] = [];
  const claudeRoot = env.claudeConfigDir ?? join(env.home, ".claude");
  const projectsDir = join(claudeRoot, "projects");
  for (const project of (await listDir(projectsDir)).sort()) {
    const d = await describe(
      "claude-code",
      join(projectsDir, project, "memory"),
      claudeProjectLabel(project, env.home),
      vaultRoot,
    );
    if (d) out.push(d);
  }
  const codex = await describe("codex", join(env.codexHome ?? join(env.home, ".codex"), "memories"), "codex", vaultRoot);
  if (codex) out.push(codex);
  return out;
}

/** Doctor lines; empty when no client folder holds a note. */
export function clientMemoryLines(dirs: ClientMemoryDir[]): string[] {
  if (dirs.length === 0) return [];
  const pending = dirs.reduce((n, d) => n + d.pending, 0);
  const lines = dirs.map(
    (d) =>
      `${d.pending > 0 ? "⚠ " : ""}${d.client}: ${d.dir} — ${d.notes} note(s)` +
      (d.pending > 0 ? `, ${d.pending} not in the vault yet` : ", all imported"),
  );
  if (pending > 0) {
    lines.push(
      `recall never reads these folders — import them with 'bastra import clients' ` +
        `(add --dry-run to preview; re-running only picks up what changed)`,
    );
  }
  return lines;
}
