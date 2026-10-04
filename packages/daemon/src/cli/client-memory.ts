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
import { readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { ensureVaultDir, slugify, snapshotLocator } from "@bastra-recall/core";
import { recordAudit } from "../audit-trail.js";
import { KNOWN_ADAPTERS, safeParse } from "../import/adapters.js";
import { escapeRe, uniqueId } from "../import/identity.js";
import { IMPORT_ROOT, listSourceMarkdown } from "../import-vault.js";

export interface ClientMemoryDir {
  client: "claude-code" | "codex";
  dir: string;
  /** The label `bastra import clients` imports it under. */
  label: string;
  /** The label an import before #885 used, where it differs. */
  previousLabel?: string;
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
 *  character turned into `-`; the home prefix carries no information. This is
 *  the label every project got up to #885 — kept, because the migration below
 *  needs to know where an earlier import put a folder. */
function legacyClaudeProjectLabel(project: string, home: string): string {
  const homeSlug = home.replace(/[^a-zA-Z0-9]/g, "-") + "-";
  const rest = project.startsWith(homeSlug) ? project.slice(homeSlug.length) : project;
  try {
    return slugify(`claude-code-${rest}`) || "claude-code";
  } catch {
    return "claude-code";
  }
}

const HOME_LABEL = "claude-code-home";

function claudeProjectLabel(project: string, home: string): string {
  // A project opened in the home directory itself IS the home slug, with no
  // dash after it — without this it kept the OS user name in label and ids.
  if (project === home.replace(/[^a-zA-Z0-9]/g, "-")) return HOME_LABEL;
  // #885: `~/home` (or `~/Home`, or `/home` itself) slugs to the same label as
  // the home directory; it gets its own so the two never share a folder.
  const label = legacyClaudeProjectLabel(project, home);
  return label === HOME_LABEL ? `${HOME_LABEL}-home` : label;
}

async function describe(
  client: ClientMemoryDir["client"],
  dir: string,
  label: string,
  vaultRoot: string | null,
  previousLabel?: string,
): Promise<ClientMemoryDir | null> {
  // The very walk `bastra import clients` runs, so what doctor counts is what
  // the import writes (subfolders included, MEMORY.md and dotdirs not).
  const files = await listSourceMarkdown(dir);
  if (files.length === 0) return null;
  // The import writes a marker into its folder on every run that changed
  // something; a note newer than it has not been imported yet. (An import
  // still under its pre-#885 label counts as pending: `import clients` is
  // what moves it.)
  const importedAt = vaultRoot ? await mtime(join(vaultRoot, IMPORT_ROOT, label, ".bastra-imported")) : null;
  let pending = 0;
  for (const f of files) {
    const m = await mtime(f);
    if (m !== null && (importedAt === null || m > importedAt)) pending += 1;
  }
  return { client, dir, label, ...(previousLabel ? { previousLabel } : {}), notes: files.length, pending };
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
    const label = claudeProjectLabel(project, env.home);
    const previous = legacyClaudeProjectLabel(project, env.home);
    const d = await describe(
      "claude-code",
      join(projectsDir, project, "memory"),
      label,
      vaultRoot,
      previous === label ? undefined : previous,
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

export interface LabelMigration {
  from: string;
  to: string;
  /** Memories whose id moved with the label. */
  memories: number;
  /** Why the folder stayed where it is; absent when it moved. */
  skipped?: string;
  /** #1048: files in the old folder this import did not write, left there
   *  (paths relative to the vault). */
  left?: string[];
}

/**
 * #885: the project opened in the home directory used to be imported under a
 * label built from the home path (`claude-code-users-<name>` on macOS,
 * `claude-code-home-<name>` on Linux), and `~/home` under `claude-code-home`.
 * Re-importing under the new labels would write every note a second time
 * beside the old copy, so the old folder moves to the new label first: every
 * file inside it gets the label rewritten — ids and file names, the `source`
 * stamps the import recognises its own notes by, scope, tags, links — and the
 * folder is renamed. Nothing is deleted or overwritten. A note in the old
 * folder this import did not write (no `source` stamp of it) stays where it
 * is and is reported; the rest then moves file by file instead (#1048).
 *
 * A folder only moves when the new one does not exist yet and its import
 * marker names this very source folder, so a second run, a vault that never
 * had the old folder, and a folder another import made under that name are
 * all left alone. `dryRun` reports without moving.
 */
export async function migrateClientLabels(
  vaultRoot: string,
  dirs: ClientMemoryDir[],
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<LabelMigration[]> {
  const moved: LabelMigration[] = [];
  let skipped: LabelMigration[] = [];
  let todo = dirs.filter((d) => d.previousLabel);
  // `~/home` has to leave `claude-code-home` before the home directory can
  // move in, so repeat while a pass still moved something.
  for (let again = true; again; ) {
    again = false;
    skipped = [];
    const left: ClientMemoryDir[] = [];
    for (const d of todo) {
      const m = await migrateOne(vaultRoot, d, dryRun);
      if (m && !m.skipped) {
        moved.push(m);
        again = !dryRun;
      } else {
        left.push(d);
        if (m) skipped.push(m);
      }
    }
    todo = left;
  }
  return [...moved, ...skipped];
}

async function migrateOne(vaultRoot: string, d: ClientMemoryDir, dryRun: boolean): Promise<LabelMigration | null> {
  const from = d.previousLabel!;
  const to = d.label;
  const oldDir = join(vaultRoot, IMPORT_ROOT, from);
  const newDir = join(vaultRoot, IMPORT_ROOT, to);
  let marker: { source?: unknown };
  try {
    marker = JSON.parse(await readFile(join(oldDir, ".bastra-imported"), "utf8"));
  } catch {
    return null; // never imported under the old label
  }
  if (marker.source !== (await realpath(d.dir).catch(() => d.dir))) return null; // another import's folder
  const skip = (why: string): LabelMigration => ({ from, to, memories: 0, skipped: why });
  // A new folder without a marker is a file-by-file move (#1048) that stopped
  // before its marker, the last file, moved: finish it.
  const newExists = (await mtime(newDir)) !== null;
  if (newExists && (await mtime(join(newDir, ".bastra-imported"))) !== null) {
    return skip(`${IMPORT_ROOT}/${to}/ exists already`);
  }

  // Each memory gets the id the import mints for its source file under the
  // new label — read from its `source` stamp, the way the import recognises
  // its own notes. Replacing the label inside the old id is not enough: ids
  // are cut at 80 characters, so a long one would come out different.
  const entries = await readdir(oldDir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((f) => f.isFile())
    .map((f) => join(f.parentPath, f.name))
    .sort();
  const raws = new Map<string, string>();
  const newIdOf = new Map<string, string>();
  const oldAliases = new Map<string, string>();
  // Ids a stopped file-by-file move already took, so the rest mint the same.
  const used = new Set<string>(
    newExists
      ? (await readdir(newDir, { recursive: true, withFileTypes: true }))
          .filter((f) => f.isFile() && f.name.endsWith(".md"))
          .map((f) => basename(f.name, ".md"))
      : [],
  );
  const markerPath = join(oldDir, ".bastra-imported");
  // Only imported Markdown and the root marker belong to this migration.
  // Attachments and symlinks are user data; never decode or rename them.
  const foreign: string[] = entries
    .filter((f) => !f.isDirectory() && !f.isFile())
    .map((f) => join(f.parentPath, f.name));
  for (const path of files) {
    if (!path.endsWith(".md") && path !== markerPath) {
      foreign.push(path);
      continue;
    }
    raws.set(path, await readFile(path, "utf8"));
    if (!path.endsWith(".md")) continue;
    const src = String(safeParse(raws.get(path)!).data.source ?? "").split(":");
    if (src[1] !== from && src[1] !== to) {
      foreign.push(path);
      continue;
    }
    const relKey = src.slice(2).join(":");
    const baseFor = (label: string): string | null => {
      if (src[0] === "index") return slugify(`${label}-index`);
      if (!KNOWN_ADAPTERS.has(src[0]) || !relKey) return null;
      const segments = relKey.split("/");
      const file = segments.pop()!;
      return slugify([label, ...segments, file.slice(0, file.length - extname(file).length)].join("-"));
    };
    const base = baseFor(to);
    if (!base) return skip(`the source stamp in ${path} cannot identify its note`);
    const currentId = basename(path, ".md");
    const newId = uniqueId(base, used);
    const oldId = baseFor(from)!;
    if (src[1] === to && currentId !== oldId && currentId !== newId) {
      return skip(`the partially moved id in ${path} cannot be reconstructed`);
    }
    newIdOf.set(currentId, newId);
    // A previous run may have written AND renamed one file before stopping.
    // Its current filename is new, but another note may still link to the old
    // id. The source stamp reconstructs that alias, including the 80-unit cut.
    if (src[1] === to && currentId === newId) {
      if (oldId !== currentId) {
        const prior = oldAliases.get(oldId);
        if (prior && prior !== newId) return skip(`the old id ${oldId} is ambiguous`);
        oldAliases.set(oldId, newId);
      }
    }
  }
  for (const [oldId, newId] of oldAliases) {
    const prior = newIdOf.get(oldId);
    if (prior && prior !== newId) return skip(`the old id ${oldId} is ambiguous`);
    newIdOf.set(oldId, newId);
  }
  // Only a label near the 80-character cap leaves an id that IS the label;
  // then the text no longer tells the two apart.
  if (newIdOf.has(from)) return skip(`an id there is the label itself`);
  // One pass over every file: an old id becomes its new id, the bare label
  // (scope, tags, `source` stamps, a link outside the set) the new label. One
  // pass, because the new label may begin with the old one (`~/home`).
  const oldIds = [...newIdOf.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  const token = new RegExp(
    `(?<![\\p{L}\\p{N}-])(?:(${oldIds.join("|") || "(?!)"})(?![\\p{L}\\p{N}-])|${escapeRe(from)}(?![\\p{L}\\p{N}]))`,
    "gu",
  );
  const rewrite = (s: string) => s.replace(token, (_, id?: string) => (id ? newIdOf.get(id)! : to));

  // With a foreign note in it the old folder stays, so every other file
  // moves on its own — the marker last, which marks the move as finished.
  const byFile = foreign.length > 0 || newExists;
  const ids = snapshotLocator(vaultRoot);
  const plan: Array<{ path: string; target: string; dest: string; oldId?: string; newId?: string }> = [];
  for (const path of [...files.filter((f) => f !== markerPath && !foreign.includes(f)), markerPath]) {
    const target = join(dirname(path), rewrite(basename(path)));
    if (target !== path && (await mtime(target)) !== null) return skip(`${target} exists already`);
    const dest = join(newDir, relative(oldDir, target));
    if (byFile && (await mtime(dest)) !== null) return skip(`${dest} exists already`);
    const oldId = basename(path, ".md");
    const newId = path.endsWith(".md") ? basename(target, ".md") : oldId;
    const located = ids.locate(newId);
    if (located.kind === "incomplete" || located.kind === "ambiguous" ||
        (located.kind === "unique" && located.filePath !== path)) return skip(`the id ${newId} is taken or cannot be checked`);
    plan.push({ path, target, dest, ...(newId !== oldId ? { oldId, newId } : {}) });
  }
  const memories = plan.filter((p) => p.newId).length;
  const left = foreign.map((f) => relative(vaultRoot, f)).sort();
  const done: LabelMigration = { from, to, memories, ...(left.length > 0 ? { left } : {}) };
  if (dryRun) return done;

  // Files first, the folder last: a run that stops halfway leaves the old
  // folder in place, and the next run finishes it.
  for (const p of plan) {
    const raw = raws.get(p.path)!;
    const next = rewrite(raw);
    if (next !== raw) await writeFile(p.path, next, "utf8");
    if (p.target !== p.path) await rename(p.path, p.target);
  }
  if (!byFile) await rename(oldDir, newDir);
  else {
    for (const p of plan) {
      await ensureVaultDir(vaultRoot, dirname(p.dest));
      await rename(p.target, p.dest);
    }
  }
  for (const p of plan) {
    if (!p.newId) continue;
    await recordAudit({
      vaultRoot,
      memoryId: p.newId,
      operation: "update",
      actor: "import",
      actorDetail: "cli:import clients",
      diffBefore: { id: p.oldId },
      diffAfter: { id: p.newId },
      filePath: p.dest,
      reason: `#885: the import label ${from} became ${to}`,
    });
  }
  return done;
}
