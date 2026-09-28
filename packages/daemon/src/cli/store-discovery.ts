/**
 * Store discovery for `bastra reconcile` (#339): which copies of this vault
 * exist on this machine?
 *
 * The case behind the issue had four stores of one vault, and nothing in the
 * tool knew about any but the one it was pointed at. A copy shows up in one of
 * these places:
 *
 *  - **Settings.** Every client registration names a vault in
 *    `BASTRA_VAULT_PATH`, and that is where the forwarder's auto-spawned daemon
 *    writes when the configured one is unreachable (the failover mirror of the
 *    case). A registration that names another folder than this vault is a
 *    second store. Claude Code's per-project registrations count too, and so
 *    does `BASTRA_VAULT_PATH` in the environment.
 *  - **Symlinks.** A registration or a folder in the home directory can reach
 *    a store through a symlink. Those are the same store, reported as an alias
 *    rather than a copy.
 *  - **Sync folders.** iCloud Drive (and app containers such as Obsidian's),
 *    `~/Library/CloudStorage/*` (Dropbox, Google Drive, OneDrive on macOS) and
 *    the usual home-level sync roots are searched for a folder that carries a
 *    bastra audit log (`.bastra/audit-log.ndjson`). Only directory entries are
 *    listed on the way there, so evicted cloud files are not downloaded; the
 *    audit log of a hit is read.
 *
 * A folder with an audit log belongs to THIS vault when its log names at least
 * one memory this vault's log names too — a copy shares its history up to the
 * point where it diverged. A sync-folder hit sharing none is another vault and
 * is left out; a registered folder is always listed, since a daemon writes
 * there.
 *
 * Read-only. Never throws on a missing or unreadable file.
 */
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { AuditLog } from "@bastra-recall/core";
import { CLAUDE_CODE_CONFIG, CLAUDE_DESKTOP_CONFIG, CURSOR_CONFIG } from "./paths.js";
import { SERVER_KEY } from "./helpers.js";
import { codexMcpGet, findCodexExecutable } from "./codex-cli.js";

export interface StoreDiscoveryEnv {
  home: string;
  /** Vault paths the client registrations (and the environment) name. */
  registrations: Array<{ source: string; path: string }>;
  /** Sync-client folders searched for vault copies. */
  syncRoots: string[];
}

export interface DiscoveredStore {
  path: string;
  realPath: string;
  /** Where it was found: "claude-code registration", "sync folder …", … */
  sources: string[];
  /** Paths that reach this store through a symlink. */
  aliases: string[];
  exists: boolean;
  /** Distinct memory ids in its audit log. */
  auditMemories: number;
  /** Of those, ids this vault's audit log names too. */
  sharedWithThis: number;
}

export interface StoreDiscovery {
  self: DiscoveredStore;
  others: DiscoveredStore[];
}

const AUDIT_FILE = join(".bastra", "audit-log.ndjson");
const SYNC_WALK_DEPTH = 4;
const SYNC_WALK_MAX_DIRS = 3000;

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const data = JSON.parse(await readFile(path, "utf8")) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function vaultOf(servers: unknown): string | null {
  const block = (servers as Record<string, unknown> | undefined)?.[SERVER_KEY] as { env?: Record<string, unknown> } | undefined;
  const v = block?.env?.BASTRA_VAULT_PATH;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** The registrations a JSON client config carries: top level, and Claude
 *  Code's per-project `projects.<dir>.mcpServers`. Exported for tests. */
export function registrationsFromConfig(source: string, data: Record<string, unknown> | null): Array<{ source: string; path: string }> {
  if (!data) return [];
  const out: Array<{ source: string; path: string }> = [];
  const top = vaultOf(data.mcpServers);
  if (top) out.push({ source, path: top });
  const projects = data.projects;
  if (projects && typeof projects === "object") {
    for (const [dir, p] of Object.entries(projects as Record<string, unknown>)) {
      const v = vaultOf((p as { mcpServers?: unknown } | null)?.mcpServers);
      if (v) out.push({ source: `${source} (project ${dir})`, path: v });
    }
  }
  return out;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function listDirs(p: string): Promise<string[]> {
  try {
    return (await readdir(p, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => join(p, e.name));
  } catch {
    return [];
  }
}

/** The sync roots that exist under `home`. */
async function defaultSyncRoots(home: string): Promise<string[]> {
  const roots = [
    join(home, "Library", "Mobile Documents"),
    ...(await listDirs(join(home, "Library", "CloudStorage"))),
    join(home, "Dropbox"),
    join(home, "OneDrive"),
    join(home, "Google Drive"),
    join(home, "iCloudDrive"),
    join(home, "Nextcloud"),
    join(home, "pCloudDrive"),
    join(home, "Sync"),
  ];
  const out: string[] = [];
  for (const r of roots) if (await isDir(r)) out.push(r);
  return out;
}

/** The real machine: its client configs, Codex through its own CLI, the environment. */
export async function defaultStoreDiscoveryEnv(): Promise<StoreDiscoveryEnv> {
  const home = homedir();
  const registrations = [
    ...registrationsFromConfig("claude-code registration", await readJson(CLAUDE_CODE_CONFIG)),
    ...registrationsFromConfig("claude-desktop registration", await readJson(CLAUDE_DESKTOP_CONFIG)),
    ...registrationsFromConfig("cursor registration", await readJson(CURSOR_CONFIG)),
  ];
  // Codex owns its TOML; ask its CLI, as detectExistingVault does.
  const codex = findCodexExecutable();
  if (codex) {
    const v = codexMcpGet(codex).server?.transport.env?.BASTRA_VAULT_PATH;
    if (typeof v === "string" && v.trim() !== "") registrations.push({ source: "codex registration", path: v.trim() });
  }
  const env = process.env.BASTRA_VAULT_PATH;
  if (env && env.trim() !== "") registrations.push({ source: "BASTRA_VAULT_PATH", path: env.trim() });
  return { home, registrations, syncRoots: await defaultSyncRoots(home) };
}

async function real(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

async function auditIds(root: string): Promise<Set<string>> {
  try {
    return new Set((await new AuditLog(root).readAll()).map((e) => e.memory_id));
  } catch {
    return new Set();
  }
}

async function hasAudit(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, AUDIT_FILE))).isFile();
  } catch {
    return false;
  }
}

/** Folders under `root` (depth-bounded, dot folders skipped, symlinks not
 *  followed) that carry a bastra audit log. */
async function findAuditedDirs(root: string): Promise<string[]> {
  const out: string[] = [];
  let queue: string[] = [root];
  let visited = 0;
  for (let depth = 0; depth <= SYNC_WALK_DEPTH && queue.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      if (++visited > SYNC_WALK_MAX_DIRS) return out;
      if (await hasAudit(dir)) {
        out.push(dir);
        continue; // a vault's own subfolders are not further copies
      }
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") next.push(join(dir, e.name));
      }
    }
    queue = next;
  }
  return out;
}

/** Every copy of `vaultPath` this machine shows. */
export async function discoverStores(vaultPath: string, env: StoreDiscoveryEnv): Promise<StoreDiscovery> {
  const selfIds = await auditIds(vaultPath);
  const byReal = new Map<string, DiscoveredStore>();
  const add = async (path: string, source: string | null): Promise<DiscoveredStore> => {
    const abs = resolve(path);
    const r = await real(abs);
    let s = byReal.get(r);
    if (!s) {
      const exists = await isDir(abs);
      const ids = exists ? await auditIds(abs) : new Set<string>();
      let shared = 0;
      for (const id of ids) if (selfIds.has(id)) shared++;
      s = { path: abs, realPath: r, sources: [], aliases: [], exists, auditMemories: ids.size, sharedWithThis: shared };
      byReal.set(r, s);
    }
    if (source && !s.sources.includes(source)) s.sources.push(source);
    if (abs !== r && !s.aliases.includes(abs)) s.aliases.push(abs);
    return s;
  };

  const self = await add(vaultPath, null);
  for (const reg of env.registrations) await add(reg.path, reg.source);
  for (const root of env.syncRoots) {
    for (const dir of await findAuditedDirs(root)) {
      const known = byReal.get(await real(dir));
      if (known === self) continue; // this vault lives in the sync folder
      if (known) {
        await add(dir, `sync folder ${basename(root)}`);
        continue;
      }
      const ids = await auditIds(dir);
      if ([...ids].some((id) => selfIds.has(id))) await add(dir, `sync folder ${basename(root)}`);
    }
  }
  // Home-level symlinks onto a known store: the same store, another path.
  try {
    for (const name of await readdir(env.home)) {
      const p = join(env.home, name);
      try {
        if (!(await lstat(p)).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      const s = byReal.get(await real(p));
      if (s && !s.aliases.includes(p)) s.aliases.push(p);
    }
  } catch {
    /* no readable home — nothing to add */
  }
  return { self, others: [...byReal.values()].filter((s) => s !== self) };
}

/** Human-readable listing for `bastra reconcile` without a store argument. */
export function formatDiscovery(d: StoreDiscovery): string {
  const line = (s: DiscoveredStore): string[] => {
    const out = [`  ${s.path}${s.realPath !== s.path ? `  → ${s.realPath}` : ""}`];
    const facts: string[] = [];
    if (s.sources.length) facts.push(`found via: ${s.sources.join(", ")}`);
    if (!s.exists) facts.push("missing");
    else facts.push(`audit log: ${s.auditMemories} memor${s.auditMemories === 1 ? "y" : "ies"}, ${s.sharedWithThis} shared with this vault`);
    out.push(`    ${facts.join("; ")}`);
    if (s.aliases.length) out.push(`    also reached as: ${s.aliases.join(", ")}`);
    return out;
  };
  const lines = ["this vault:", ...line(d.self)];
  if (d.others.length === 0) {
    lines.push("", "no other copy of this vault found (settings, symlinks, sync folders).");
    return lines.join("\n");
  }
  lines.push("", `other stores: ${d.others.length}`);
  for (const s of d.others) lines.push(...line(s));
  return lines.join("\n");
}
