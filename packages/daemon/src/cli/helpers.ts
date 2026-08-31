/** Shared installer helpers, including Codex vault discovery (#15). */
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { request as httpRequest } from "node:http";
import { Vault } from "@bastra-recall/core";
import { FORWARDER_SCRIPT_PATH, CLAUDE_DESKTOP_CONFIG, CLAUDE_CODE_CONFIG } from "./paths.js";
import { codexMcpGet, findCodexExecutable } from "./codex-cli.js";
import type { CodeStale } from "../code-staleness.js";
import type { InstallOpts } from "./types.js";

// Read from package.json at runtime (see ../version.ts) instead of a literal.
// The literals drifted: this one said 0.8.9 while index.ts still said 0.8.8,
// because a bump ran over part of the tree only. Now there is one source.
export { DAEMON_VERSION as VERSION } from "../version.js";
export const SERVER_KEY = "bastra-recall";

/**
 * The CLI and the daemon each carry their own version constant (VERSION here,
 * DAEMON_VERSION in index.ts) and nothing ever compared them (#225). They drift
 * for a mundane reason: upgrading the CLI does not touch the daemon that is
 * already running — the forwarder only spawns a new one when the AI client
 * restarts. Panel and doctor both name the pair, so the wording lives here
 * rather than being written twice.
 */
export const VERSION_DRIFT_HINT = "restart your AI client to reload the daemon";
const DAEMON_HEALTH_URL = "http://127.0.0.1:6723/health";

/**
 * A `code_stale` block from /health (#329). Validated rather than cast: an
 * older daemon does not send the field at all, and a half-shaped one must read
 * as "no finding" instead of printing `undefined` into a version line.
 */
function isCodeStale(v: unknown): v is CodeStale {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.running === "string" &&
    typeof s.on_disk === "string" &&
    typeof s.built_at === "string" &&
    (s.reason === "rebuilt" || s.reason === "not-built")
  );
}

export interface McpServerBlock {
  command: string;
  args: string[];
  env: Record<string, string>;
}

// forwarderPath defaults to this CLI's own dist; npx installs pass the
// stable-runtime copy instead (#180 — the npx cache is ephemeral).
export function buildServerBlock(vaultPath: string, forwarderPath: string = FORWARDER_SCRIPT_PATH): McpServerBlock {
  return {
    command: "node",
    args: [forwarderPath],
    env: { BASTRA_VAULT_PATH: vaultPath },
  };
}

export function blocksMatch(existing: unknown, target: McpServerBlock): boolean {
  if (typeof existing !== "object" || existing === null) return false;
  const x = existing as Record<string, unknown>;
  if (x.command !== target.command) return false;
  if (!Array.isArray(x.args) || x.args.length !== target.args.length) return false;
  for (let i = 0; i < target.args.length; i++) if (x.args[i] !== target.args[i]) return false;
  const xenv = x.env;
  if (typeof xenv !== "object" || xenv === null) return false;
  const e = xenv as Record<string, unknown>;
  if (Object.keys(e).length !== Object.keys(target.env).length) return false;
  for (const [k, v] of Object.entries(target.env)) if (e[k] !== v) return false;
  return true;
}

export async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

export interface ParsedConfig { data: Record<string, unknown>; existed: boolean; }

export async function readJsonConfig(p: string): Promise<ParsedConfig | { error: string }> {
  if (!(await fileExists(p))) return { data: {}, existed: false };
  let raw: string;
  try { raw = await readFile(p, "utf8"); }
  catch (e) { return { error: `cannot read ${p}: ${(e as Error).message}` }; }
  if (raw.trim() === "") return { data: {}, existed: true };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: `${p} is valid JSON but not an object — refusing to edit` };
    }
    return { data: parsed as Record<string, unknown>, existed: true };
  } catch (e) {
    return { error: `${p} has invalid JSON: ${(e as Error).message} — refusing to edit (fix it manually first)` };
  }
}

export async function backupConfig(configPath: string): Promise<string | null> {
  if (!(await fileExists(configPath))) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${configPath}.bak-${ts}`;
  await copyFile(configPath, backupPath);
  return backupPath;
}

export async function atomicWriteJson(configPath: string, data: unknown): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, configPath);
}

async function detectExistingVault(): Promise<string | null> {
  const candidates = [CLAUDE_DESKTOP_CONFIG, CLAUDE_CODE_CONFIG];
  for (const c of candidates) {
    try {
      const raw = await readFile(c, "utf8");
      const data = JSON.parse(raw);
      const vault = data?.mcpServers?.[SERVER_KEY]?.env?.BASTRA_VAULT_PATH;
      if (typeof vault === "string" && vault.length > 0) return vault;
    } catch { /* ignore — try next */ }
  }
  // Codex owns TOML serialization; ask its official CLI for the normalized
  // registration instead of maintaining a second TOML parser (#15).
  const codex = findCodexExecutable();
  if (codex) {
    const existing = codexMcpGet(codex);
    const vault = existing.server?.transport.env?.BASTRA_VAULT_PATH;
    if (typeof vault === "string" && vault.length > 0) return vault;
  }
  return null;
}

export const VAULT_REQUIRED_ERROR =
  "vault path required — pass --vault <path>, set BASTRA_VAULT_PATH, or install for another surface first (vault is auto-detected from existing registrations)";

export async function resolveVault(opts: InstallOpts): Promise<{ path: string } | { error: string }> {
  if (opts.vaultPath) return { path: opts.vaultPath };
  const env = process.env.BASTRA_VAULT_PATH;
  if (env && env.length > 0) return { path: env };
  const detected = await detectExistingVault();
  if (detected) return { path: detected };
  return { error: VAULT_REQUIRED_ERROR };
}

// ─── first-run vault (#178) ──────────────────────────────────────────────────

/** Default vault offered on first run. Keep DISPLAY and defaultVaultPath in sync. */
export const DEFAULT_VAULT_DIRNAME = "BastraVault";
export const DEFAULT_VAULT_DISPLAY = "~/BastraVault";

export function defaultVaultPath(home: string = homedir()): string {
  return resolve(home, DEFAULT_VAULT_DIRNAME);
}

// Deliberately one README rather than a set of example memory files: anything
// carrying a `type:` field is a real memory to the loader, so shipped examples
// would compete with the user's own memories in every recall. A fenced block
// inside a file with no frontmatter shows the same shape and stays invisible
// to the index (#16).
const VAULT_README = `# Bastra Vault

This folder is your bastra-recall memory vault. Every memory your AI saves —
lessons, preferences, decisions, project facts — lives here as a plain
markdown file you can read, edit, and back up like any other note.

## What a memory looks like

\`\`\`markdown
---
id: css-input-focus-ring-stacking
title: "Don't stack focus styles on inputs"
type: lesson          # lesson | preference | user-preference | decision |
                      # project-fact | workflow | meta-working | reference
summary: "Stacking ring + outline + custom :focus causes double focus rings."
topic_path: [css, input, focus]
tags: [css, focus-ring, ui-bug]
scope: all-projects   # or a project name
recall_when:          # the situations this should resurface in —
  - creating new input component      # the highest-weighted field there is
  - writing input or form css
---

The rule, then why it exists, then when it applies.
\`\`\`

\`recall_when\` is what makes a memory findable later: describe the *situation*
("about to write a Tailwind grid"), not the topic ("CSS").

## Working with it

- You don't have to write these by hand — tell your AI, and it saves them.
- Anything you edit here is picked up within seconds; no re-index step.
- Subfolders are free-form. \`.bastra/\` holds derived state (search vectors,
  audit log, trash) — leave it alone, it rebuilds itself.
- Files without a \`type:\` field — like this README — are ignored by the index.

Created by \`bastra install\`. To use a different folder, re-run:
\`bastra install all --vault <path>\`

New here? \`bastra onboard\` is a five-minute interview that seeds this vault
with your actual preferences instead of leaving you a blank folder.
`;

/**
 * Creates the vault folder (mkdir -p) plus a short README explaining what it
 * holds. Idempotent: an existing folder is fine and an existing README is
 * never overwritten. Returns the same shape as resolveVault so the caller
 * feeds the created path through the exact route a --vault value takes.
 */
export async function createVaultAt(path: string): Promise<{ path: string } | { error: string }> {
  try {
    await mkdir(path, { recursive: true });
    try {
      await writeFile(join(path, "README.md"), VAULT_README, { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    return { path };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export interface VaultPresence {
  /** The directory is there — whatever it holds. */
  exists: boolean;
  /** Memories the daemon would index; plain notes and the README don't count. */
  memoryCount: number;
}

/**
 * Read-only probe of a vault directory (#318).
 *
 * The guided setup offered "Create ~/BastraVault (recommended)" over a folder
 * already holding someone's memories. "Create" is a claim about the folder,
 * and it was made without looking — at the one moment where the truth is a
 * single directory listing away, and where a reinstall is most likely to be
 * pointing at an existing vault.
 *
 * Counts through Vault.init() rather than a private scanner: the number shown
 * has to be the number the daemon indexes, not a second opinion that drifts
 * from it. init() only reads — watching is a separate call. Best-effort: an
 * absent or unreadable directory reports zero rather than failing a setup step.
 */
export async function probeVaultPresence(path: string): Promise<VaultPresence> {
  if (!(await fileExists(path))) return { exists: false, memoryCount: 0 };
  try {
    const { loaded } = await new Vault(path).init();
    return { exists: true, memoryCount: loaded };
  } catch {
    return { exists: true, memoryCount: 0 };
  }
}

export type FirstRunVaultAction = "proceed" | "prompt" | "would-create" | "error";

/**
 * Pure decision for the first-run vault step (#178) — exported so the
 * TTY/flag matrix is unit-testable without a terminal:
 *   vault resolves (flag / env / auto-detect) → proceed, never ask
 *   non-TTY or --yes → error: keep today's deterministic per-surface error
 *     (scripts must never block on a prompt). Checked BEFORE dry-run so a
 *     dry-run reports what the same invocation would really do.
 *   --dry-run (interactive) → would-create: report the offer, write nothing
 *   otherwise → ask once, before the per-surface loop
 */
export function decideFirstRunVaultAction(i: {
  vaultConfigured: boolean;
  interactive: boolean;
  yes: boolean;
  dryRun: boolean;
}): FirstRunVaultAction {
  if (i.vaultConfigured) return "proceed";
  if (!i.interactive || i.yes) return "error";
  if (i.dryRun) return "would-create";
  return "prompt";
}

export interface DaemonProbe {
  ok: boolean;
  detail: string;
  /**
   * The RUNNING daemon's build (#225). /health has always carried it; nothing
   * read it, so a stale daemon could answer for a newer CLI unnoticed. Stays
   * optional: a daemon predating the field is indistinguishable from one that
   * simply isn't there, and neither is worth a separate state.
   */
  version?: string;
  /**
   * Set when the running daemon reports that its code was replaced on disk
   * (#329). `version` above is then the version of the PROCESS, not of the
   * installation — which is why every surface that shows a version has to be
   * able to say so instead of printing a number that reads as current.
   */
  codeStale?: CodeStale;
  // From /health when reachable — lets `bastra status` show the live embedding
  // mode (the user-visible #79 fix; the daemon's own stderr is /dev/null'd when
  // the forwarder spawns it).
  semanticRecall?: "on" | "off" | "degraded";
  embeddingMode?: string;
  embeddingSource?: string;
  /** Last provider error when semanticRecall === "degraded" (#92). */
  embeddingError?: string;
}

export function probeDaemon(): Promise<DaemonProbe> {
  return new Promise((resolve_) => {
    const req = httpRequest(DAEMON_HEALTH_URL, { method: "GET", timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode === 200 && data?.ok) {
            resolve_({
              ok: true,
              detail: `vault_size=${data.vault_size}`,
              version: typeof data.version === "string" ? data.version : undefined,
              codeStale: isCodeStale(data.code_stale) ? data.code_stale : undefined,
              semanticRecall: data.semantic_recall,
              embeddingMode: data.embedding_mode,
              embeddingSource: data.embedding_source,
              embeddingError: data.embedding_error,
            });
            return;
          }
        } catch { /* fallthrough */ }
        resolve_({ ok: false, detail: `daemon answered but health unexpected (status=${res.statusCode})` });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve_({ ok: false, detail: "timeout (no daemon listening — forwarder will auto-spawn on first MCP call)" }); });
    req.on("error", (e) => resolve_({ ok: false, detail: `not reachable: ${(e as NodeJS.ErrnoException).code ?? e.message} (forwarder will auto-spawn on first MCP call)` }));
    req.end();
  });
}

export function getServersBlock(data: Record<string, unknown>): Record<string, unknown> | null {
  const s = data.mcpServers;
  if (s && typeof s === "object" && !Array.isArray(s)) return s as Record<string, unknown>;
  return null;
}

export function formatStatus(status: string): string {
  switch (status) {
    case "installed": return "✓ installed";
    case "already-installed": return "= already installed";
    case "would-install": return "~ would install (dry-run)";
    case "removed": return "✓ removed";
    case "not-present": return "= not present";
    case "would-remove": return "~ would remove (dry-run)";
    case "ok": return "✓ ok";
    case "missing": return "✗ missing";
    case "broken": return "✗ broken";
    case "not-implemented": return "… not implemented yet";
    case "error": return "✗ error";
    case "warn": return "! note";
    default: return status;
  }
}
