/**
 * #339 — two stores of the same vault: which copy is ahead?
 *
 * mtime, hash and size cannot answer it. The daemon rewrites memory files on
 * its own (`trigger-expand.ts` stamps `recall_when_expanded`,
 * `related-enrich.ts` stamps `related_via` and appends the auto-related
 * block), so the copy the daemon served looks newer while holding the older
 * text. What stays stable under everything the daemon does to a file is the
 * AUTHORED content: the body without the generated block, wrapping collapsed,
 * wikilinks in one dialect — plus the frontmatter fields a person writes.
 * That comparison key (after @zzallirog's `comparableParagraphs`, reviewed on
 * #339) decides "same or not"; the audit log decides the direction.
 *
 * Direction comes from `<vault>/.bastra/audit-log.ndjson`, not from clocks:
 * every audited write carries a unique entry id, and a mirror carries the
 * entries it was copied with. If one side holds entries for a memory the other
 * lacks — and not the reverse — it is ahead. Entries on both sides, or none
 * (an edit outside bastra, in Obsidian say), is a conflict. Conflicts are
 * reported, never resolved: an automated resolution toward either side is a
 * data-loss path (the #339 case: the mirror held a retraction the vault did
 * not).
 *
 * Joined by the frontmatter `id` (what `Vault.get` resolves, and what
 * docs/survival.md promises), never by filename.
 *
 * Not to be confused with `Vault.reconcile()`, the periodic disk reindex.
 */
import { readdir, readFile, copyFile, rename, stat, writeFile, link, unlink, constants } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, sep, basename } from "node:path";
import matter from "gray-matter";
import { parseMemoryWith } from "./schema.js";
import { isMarkdownFile } from "./markdown-file.js";
import { slugify, stripAutoRelatedSection } from "./save-text.js";
import { memoryRevision } from "./memory-mutate.js";
import { AuditLog, type AuditEntry } from "./audit-log.js";
import { withIdClaim } from "./id-transaction.js";
import { assertInsideDir, assertOwnSubdir } from "./file-identity.js";
import { ensureVaultDir } from "./vault-root-guard.js";

/** Frontmatter the daemon writes on its own — not authored, not compared. */
const GENERATED_FIELDS: ReadonlySet<string> = new Set([
  "recall_when_expanded",
  "recall_when_expanded_src",
  "related_via",
  "updated",
  "stale_status",
]);

export interface AuthoredContent {
  /** Authored frontmatter, one stable JSON string per field. */
  fields: Record<string, string>;
  /** Authored body as paragraphs, whitespace collapsed outside code fences. */
  paragraphs: string[];
}

function stableJson(v: unknown): string {
  if (v instanceof Date) return JSON.stringify(v.toISOString().slice(0, 10));
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

function linkTarget(target: string): string {
  try {
    return slugify(target);
  } catch {
    return target.trim();
  }
}

/** `[[Präferenz|shown]]` → `[[praeferenz|shown]]` — the target in one dialect,
 *  the alias kept (it is authored text). */
function normalizeLinks(text: string): string {
  return text.replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, (_m, t: string, alias: string | undefined) =>
    `[[${linkTarget(t)}${alias ?? ""}]]`);
}

/** Links normalised outside inline code only — a code example stays verbatim. */
function normalizeLine(line: string): string {
  return line
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : normalizeLinks(part)))
    .join("");
}

export function authoredBody(body: string): string[] {
  const lines = stripAutoRelatedSection(body.replace(/^﻿/, "").replace(/\r\n?/g, "\n")).split("\n");
  const paragraphs: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = (joiner: string) => {
    const p = current.join(joiner).trim();
    if (p) paragraphs.push(p);
    current = [];
  };
  for (const line of lines) {
    const fm = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      current.push(line.trimEnd());
      if (fm && fm[1][0] === fence) {
        fence = null;
        flush("\n");
      }
      continue;
    }
    if (fm) {
      flush(" ");
      fence = fm[1][0];
      current.push(line.trim());
      continue;
    }
    if (line.trim() === "") {
      flush(" ");
      continue;
    }
    current.push(normalizeLine(line.trim()).replace(/\s+/g, " "));
  }
  flush(fence !== null ? "\n" : " ");
  return paragraphs;
}

export function authoredContent(fm: Record<string, unknown>, body: string): AuthoredContent {
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (GENERATED_FIELDS.has(k) || v === undefined) continue;
    // `related` is written in the same id dialect as the body's links.
    fields[k] = k === "related" && Array.isArray(v)
      ? stableJson(v.map((x) => linkTarget(String(x))).sort())
      : stableJson(v);
  }
  return { fields, paragraphs: authoredBody(body) };
}

export function authoredKey(a: AuthoredContent): string {
  return createHash("sha256").update(stableJson(a)).digest("hex").slice(0, 16);
}

/** What differs between two authored versions — for the report only. */
export function authoredDiff(a: AuthoredContent, b: AuthoredContent): {
  fields: string[];
  paragraphsOnlyA: number;
  paragraphsOnlyB: number;
} {
  const fields = [...new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])]
    .filter((k) => a.fields[k] !== b.fields[k])
    .sort();
  const count = (xs: string[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const ca = count(a.paragraphs);
  const cb = count(b.paragraphs);
  let onlyA = 0;
  let onlyB = 0;
  for (const [p, n] of ca) onlyA += Math.max(0, n - (cb.get(p) ?? 0));
  for (const [p, n] of cb) onlyB += Math.max(0, n - (ca.get(p) ?? 0));
  return { fields, paragraphsOnlyA: onlyA, paragraphsOnlyB: onlyB };
}

// ─── stores ───────────────────────────────────────────────────────

export interface StoreFile {
  id: string;
  /** Path relative to the store root, `/`-separated. */
  rel: string;
  filePath: string;
  /** `memoryRevision` of the bytes the plan was made from. */
  revision: string;
  authored: AuthoredContent;
  key: string;
}

export interface StoreSnapshot {
  root: string;
  files: Map<string, StoreFile[]>;
  /** Audit entry ids per memory id. */
  auditIds: Map<string, Set<string>>;
  /** Memory ids with a `delete` entry, by entry id. */
  deletes: Map<string, Set<string>>;
  audit: AuditEntry[];
  /** Directories and files the walk could not read — the plan is partial there. */
  unreadable: string[];
}

async function walk(root: string, dir: string, out: string[], unreadable: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    unreadable.push(dir);
    return;
  }
  for (const e of entries) {
    // Same rule as the vault scan: dot-dirs (.bastra, .obsidian, .trash) and
    // node_modules are not part of the store.
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(root, full, out, unreadable);
    else if (e.isFile() && isMarkdownFile(e.name)) out.push(full);
  }
}

export async function loadStore(root: string): Promise<StoreSnapshot> {
  const paths: string[] = [];
  const unreadable: string[] = [];
  await walk(root, root, paths, unreadable);
  const files = new Map<string, StoreFile[]>();
  for (const filePath of paths) {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      unreadable.push(filePath);
      continue;
    }
    let parsed;
    try {
      parsed = parseMemoryWith((input) => matter(input), raw, filePath, 0);
    } catch {
      continue; // not a memory — a plain note is not ours to reconcile
    }
    const authored = authoredContent(parsed.fm as Record<string, unknown>, parsed.body);
    const f: StoreFile = {
      id: parsed.fm.id,
      rel: relative(root, filePath).split(sep).join("/"),
      filePath,
      revision: memoryRevision(raw),
      authored,
      key: authoredKey(authored),
    };
    const list = files.get(f.id) ?? [];
    list.push(f);
    files.set(f.id, list);
  }
  const audit = await new AuditLog(root).readAll();
  const auditIds = new Map<string, Set<string>>();
  const deletes = new Map<string, Set<string>>();
  for (const e of audit) {
    const set = auditIds.get(e.memory_id) ?? new Set<string>();
    set.add(e.id);
    auditIds.set(e.memory_id, set);
    if (e.operation === "delete") {
      const d = deletes.get(e.memory_id) ?? new Set<string>();
      d.add(e.id);
      deletes.set(e.memory_id, d);
    }
  }
  return { root, files, auditIds, deletes, audit, unreadable };
}

// ─── plan ─────────────────────────────────────────────────────────

export type ConflictReason =
  /** Both sides carry audited writes the other lacks. */
  | "both-changed"
  /** Content differs and neither log says why — an edit outside bastra. */
  | "unrecorded"
  /** The memory is gone on one side by an audited delete the other lacks. */
  | "deleted-on-one-side"
  /** Two files with this id in one store (a vault defect of its own). */
  | "duplicate-id"
  /** The copy would land on a path the other store already uses. */
  | "path-taken";

export type PlanItem =
  | { kind: "same"; id: string; bytesDiffer: boolean }
  | {
      kind: "copy";
      id: string;
      /** `a` = this store is ahead / only here; copy goes from → to. */
      from: "a" | "b";
      why: "ahead" | "only-here";
      source: StoreFile;
      /** Absent when the memory does not exist on the target side. */
      target?: StoreFile;
      /** Audit entries the source has for this id and the target lacks. */
      carryAudit: string[];
      diff?: ReturnType<typeof authoredDiff>;
    }
  | {
      kind: "conflict";
      id: string;
      reason: ConflictReason;
      a?: StoreFile[];
      b?: StoreFile[];
      /** Audit entries only on side a / b. */
      onlyA: number;
      onlyB: number;
      diff?: ReturnType<typeof authoredDiff>;
    };

export interface ReconcilePlan {
  a: StoreSnapshot;
  b: StoreSnapshot;
  items: PlanItem[];
}

function minus(x: Set<string> | undefined, y: Set<string> | undefined): string[] {
  if (!x) return [];
  return [...x].filter((e) => !y?.has(e));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
}

export async function planReconcile(a: StoreSnapshot, b: StoreSnapshot): Promise<ReconcilePlan> {
  const ids = [...new Set([...a.files.keys(), ...b.files.keys()])].sort();
  const items: PlanItem[] = [];
  for (const id of ids) {
    const fa = a.files.get(id);
    const fb = b.files.get(id);
    const onlyA = minus(a.auditIds.get(id), b.auditIds.get(id));
    const onlyB = minus(b.auditIds.get(id), a.auditIds.get(id));
    if ((fa && fa.length > 1) || (fb && fb.length > 1)) {
      items.push({ kind: "conflict", id, reason: "duplicate-id", a: fa, b: fb, onlyA: onlyA.length, onlyB: onlyB.length });
      continue;
    }
    if (fa && fb) {
      const [x, y] = [fa[0], fb[0]];
      if (x.key === y.key) {
        items.push({ kind: "same", id, bytesDiffer: x.revision !== y.revision });
        continue;
      }
      const diff = authoredDiff(x.authored, y.authored);
      if (onlyA.length > 0 && onlyB.length === 0) {
        items.push({ kind: "copy", id, from: "a", why: "ahead", source: x, target: y, carryAudit: onlyA, diff });
      } else if (onlyB.length > 0 && onlyA.length === 0) {
        items.push({ kind: "copy", id, from: "b", why: "ahead", source: y, target: x, carryAudit: onlyB, diff });
      } else {
        items.push({
          kind: "conflict", id, reason: onlyA.length > 0 ? "both-changed" : "unrecorded",
          a: fa, b: fb, onlyA: onlyA.length, onlyB: onlyB.length, diff,
        });
      }
      continue;
    }
    // Present on one side only.
    const from: "a" | "b" = fa ? "a" : "b";
    const source = (fa ?? fb)![0];
    const other = from === "a" ? b : a;
    const here = from === "a" ? a : b;
    const deletedThere = minus(other.deletes.get(id), here.deletes.get(id)).length > 0;
    if (deletedThere) {
      items.push({ kind: "conflict", id, reason: "deleted-on-one-side", a: fa, b: fb, onlyA: onlyA.length, onlyB: onlyB.length });
      continue;
    }
    if (await exists(join(other.root, source.rel))) {
      items.push({ kind: "conflict", id, reason: "path-taken", a: fa, b: fb, onlyA: onlyA.length, onlyB: onlyB.length });
      continue;
    }
    items.push({ kind: "copy", id, from, why: "only-here", source, carryAudit: from === "a" ? onlyA : onlyB });
  }
  return { a, b, items };
}

// ─── apply ────────────────────────────────────────────────────────

export interface ApplyResult {
  id: string;
  from: "a" | "b";
  status: "copied" | "skipped";
  /** Why a copy was skipped. */
  reason?: string;
  /** Where the overwritten target's previous bytes went. */
  backup?: string;
  /** A copy committed but its audit trail could not be completed. */
  warning?: string;
  target: string;
}

/** `2026-09-28T14-03-07Z` — sortable, and legal in a Windows path. */
export function backupStamp(now: Date): string {
  return now.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

async function revisionOf(path: string): Promise<string | null> {
  try {
    return memoryRevision(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Restore from a backup without making the restored file and the backup the
 * same inode. The final link claims the absent destination exclusively. */
async function restoreBackupExclusive(backup: string, target: string): Promise<boolean> {
  const tmp = join(dirname(target), `.${basename(target)}.restore-${randomUUID()}.tmp`);
  try {
    await copyFile(backup, tmp, constants.COPYFILE_EXCL);
    await link(tmp, target);
    return true;
  } catch {
    return false;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/**
 * Carry out the plan's copies — conflicts are never touched. Files are only
 * copied and renamed: an overwritten target is first copied to
 * `<target store>/.bastra/reconcile-backup/<stamp>/<rel>`, then replaced by a
 * copy of the source via temp file + rename. A file that changed since the
 * plan was made is skipped, not overwritten.
 *
 * The source's audit entries for that memory are appended to the target's
 * log (same ids, same timestamps). Without them the next run would see the
 * target's later writes as a conflict instead of "ahead".
 */
export async function applyReconcile(
  plan: ReconcilePlan,
  now: Date = new Date(),
  io: { beforePublish?: (target: string) => Promise<void> } = {},
): Promise<ApplyResult[]> {
  const stamp = backupStamp(now);
  const results: ApplyResult[] = [];
  for (const item of plan.items) {
    if (item.kind !== "copy") continue;
    const src = item.from === "a" ? plan.a : plan.b;
    const dst = item.from === "a" ? plan.b : plan.a;
    const targetPath = item.target ? item.target.filePath : join(dst.root, item.source.rel);
    const base = { id: item.id, from: item.from, target: targetPath };
    try {
      const result = await withIdClaim(
        { vaultRoot: dst.root, id: item.id, filePath: targetPath, op: "reconcile_store" },
        async (claim): Promise<ApplyResult> => {
          const located = await claim.locate();
          if (item.target
            ? located.kind !== "unique" || located.filePath !== targetPath
            : located.kind !== "none") {
            return { ...base, status: "skipped", reason: "target id changed since the plan" };
          }
          let sourceRaw: string;
          try { sourceRaw = await readFile(item.source.filePath, "utf8"); }
          catch { return { ...base, status: "skipped", reason: "source unreadable since the plan" }; }
          if (memoryRevision(sourceRaw) !== item.source.revision) {
            return { ...base, status: "skipped", reason: "source changed since the plan" };
          }
          if (item.target && (await revisionOf(targetPath)) !== item.target.revision) {
            return { ...base, status: "skipped", reason: "target changed since the plan" };
          }

          await ensureVaultDir(dst.root, dirname(targetPath));
          const tmp = join(dirname(targetPath), `.${basename(targetPath)}.reconcile-${process.pid}-${randomUUID()}.tmp`);
          let backup: string | undefined;
          try {
            await writeFile(tmp, sourceRaw, { encoding: "utf8", flag: "wx", mode: (await stat(item.source.filePath)).mode & 0o777 });
            // Some cloud mounts cannot create hard links. Discover that while
            // the old target is still in place, before moving it to backup.
            const probe = `${tmp}.link-probe`;
            try { await link(tmp, probe); } finally { await unlink(probe).catch(() => {}); }
            if (item.target) {
              // Move, then verify the exact bytes now held by the backup. An
              // external edit in the preflight window is preserved there and
              // never replaced silently. The unique name cannot overwrite a
              // prior backup from another attempt in the same second.
              const privateDir = join(dst.root, ".bastra");
              const backupRoot = join(privateDir, "reconcile-backup");
              assertOwnSubdir(dst.root, privateDir, "reconcile backup");
              assertOwnSubdir(privateDir, backupRoot, "reconcile backup");
              const backupPath = join(backupRoot, stamp, item.target.rel) + `.${randomUUID()}`;
              assertInsideDir(backupRoot, backupPath, "reconcile backup");
              await ensureVaultDir(dst.root, dirname(backupPath));
              await rename(targetPath, backupPath);
              backup = backupPath;
              if ((await revisionOf(backup)) !== item.target.revision) {
                const restored = await restoreBackupExclusive(backup, targetPath);
                return { ...base, status: "skipped", reason: restored
                  ? "target changed before backup; original restored and backup preserved"
                  : "target changed before backup; check target and preserved backup", backup };
              }
            }
            await io.beforePublish?.(targetPath);
            // Exclusive publication: a writer arriving after the backup move
            // wins the path. `rename(tmp, target)` would overwrite that edit.
            await link(tmp, targetPath);
          } catch (err) {
            let restored = false;
            if (backup) {
              restored = await restoreBackupExclusive(backup, targetPath);
            }
            return { ...base, status: "skipped", reason: `publish failed: ${(err as Error).message}` +
              (backup ? restored ? "; target restored, backup preserved" : "; inspect target and preserved backup" : ""),
              ...(backup ? { backup } : {}) };
          } finally {
            await unlink(tmp).catch(() => {});
          }

          const carry = new Set(item.carryAudit);
          const log = new AuditLog(dst.root);
          try {
            for (const e of src.audit) {
              if (e.memory_id === item.id && carry.has(e.id)) await log.record(e);
            }
          } catch (err) {
            return { ...base, status: "copied", ...(backup ? { backup } : {}), warning: `audit entries could not all be copied: ${(err as Error).message}` };
          }
          return { ...base, status: "copied", ...(backup ? { backup } : {}) };
        },
      );
      results.push(result);
    } catch (err) {
      results.push({ ...base, status: "skipped", reason: (err as Error).message });
    }
  }
  return results;
}
