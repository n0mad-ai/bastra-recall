/** Generated startup instructions (#1314). Never owns bytes outside its markers. */
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { CODEX_CONFIG, SKILL_SOURCE_DIR } from "./paths.js";
import { confirm, isInteractive } from "./prompt.js";

export const BOOTSTRAP_START = "<!-- bastra-recall:start -->";
export const BOOTSTRAP_END = "<!-- bastra-recall:end -->";
export type BootstrapHost = "codex" | "claude-code";
export function bootstrapPath(host: BootstrapHost): string {
  return host === "codex" ? join(dirname(CODEX_CONFIG), "AGENTS.md")
    : join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "CLAUDE.md");
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
export type BootstrapState = "missing" | "current" | "stale" | "modified" | "malformed";
export function inspectBootstrap(source: string, expected: string): { state: BootstrapState; start?: number; end?: number } {
  const starts = source.split(BOOTSTRAP_START).length - 1;
  const ends = source.split(BOOTSTRAP_END).length - 1;
  if (!starts && !ends) return { state: "missing" };
  if (starts !== 1 || ends !== 1) return { state: "malformed" };
  const start = source.indexOf(BOOTSTRAP_START), end = source.indexOf(BOOTSTRAP_END) + BOOTSTRAP_END.length;
  if (end <= start) return { state: "malformed" };
  const block = source.slice(start, end);
  if (block === expected) return { state: "current", start, end };
  const recorded = block.match(/^<!-- bastra-recall:start -->\n<!-- GENERATED SKILL.md bastra-recall:hash [a-f0-9]{16}\/([a-f0-9]{16}) -->\n([\s\S]*)\n<!-- bastra-recall:end -->$/);
  return { state: recorded && digest(recorded[2]) === recorded[1] ? "stale" : "modified", start, end };
}
async function textAt(path: string): Promise<string> {
  try {
    // Refuse a symlink at open time, rather than checking a path and later
    // reading whatever may have replaced it. Read from this same handle.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`instruction path is not a regular file: ${path}; left untouched`);
      // O_NOFOLLOW is unavailable on some platforms. Verify the path still
      // names this regular file; all actual reading stays on the handle.
      const named = await lstat(path);
      if (named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino) {
        throw new Error(`instruction path changed or is a symlink: ${path}; left untouched`);
      }
      const bytes = await handle.readFile();
      if (!isUtf8(bytes)) throw new Error(`instruction file is not UTF-8: ${path}; left untouched`);
      return bytes.toString("utf8");
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`instruction path is a symlink: ${path}; inspect its target manually`);
    throw error;
  }
}
export async function bootstrapProjection(): Promise<string> {
  return readFile(join(SKILL_SOURCE_DIR, "bootstrap-block.md"), "utf8");
}
export interface BootstrapOptions {
  dryRun: boolean;
  withBootstrap?: boolean;
  /** Explicit temporary test paths, never a second source of instructions. */
  path?: string;
  projection?: string;
  interactive?: boolean;
  ask?: (question: string) => Promise<boolean>;
}
export async function ensureBootstrap(host: BootstrapHost, action: "install" | "uninstall", opts: BootstrapOptions): Promise<{ changed: boolean; detail: string; error?: true }> {
  const path = opts.path ?? bootstrapPath(host);
  // Opt-out and unattended installs do not own this optional instruction
  // channel. Do not even read it or require the optional projection asset.
  if (action === "install" && opts.withBootstrap === false) return { changed: false, detail: `${path}: bootstrap declined; file untouched` };
  if (action === "install" && opts.withBootstrap !== true && (opts.dryRun || !(opts.interactive ?? isInteractive()))) {
    return { changed: false, detail: `${path}: bootstrap not authorized; use --with-bootstrap or accept the interactive offer` };
  }
  try {
    const source = await textAt(path);
    const expected = opts.projection ?? await bootstrapProjection();
    const inspection = inspectBootstrap(source, expected);
    if (inspection.state === "malformed") return { changed: false, detail: `${path}: malformed/duplicate bootstrap markers; repair manually, file untouched`, error: true };
    const outside = inspection.start === undefined ? source : source.slice(0, inspection.start) + source.slice(inspection.end);
    if (action === "install" && host === "claude-code" && /bastra-recall/i.test(outside)) {
      return { changed: false, detail: `${path}: existing unmanaged bastra-recall line; doctor notice only, file untouched` };
    }
    if (action === "uninstall" && inspection.state === "missing") return { changed: false, detail: `${path}: no managed bootstrap` };
    if (action === "install" && inspection.state === "current") return { changed: false, detail: `${path}: bootstrap current` };
    if (action === "install") {
      if (opts.withBootstrap !== true) {
        // Exact target/content shown in the question. --yes / force is deliberately unrelated.
        if (!await (opts.ask ?? confirm)(`Add/update only this managed region in ${path}?\n${expected}\nWrite bootstrap?`)) {
          return { changed: false, detail: `${path}: bootstrap declined; file untouched` };
        }
      }
    }
    // No separator outside the ownership markers: uninstall restores every
    // original byte, even when user text ended without a newline.
    const next = action === "uninstall" ? outside : inspection.start === undefined
      ? source + expected : source.slice(0, inspection.start) + expected + source.slice(inspection.end);
    if (opts.dryRun) return { changed: true, detail: `${path}: would ${action === "install" ? "write" : "remove"} managed bootstrap\n${action === "install" ? expected : ""}` };
    if (await textAt(path) !== source) return { changed: false, detail: `${path}: changed while awaiting bootstrap consent; file untouched, re-run installer`, error: true };
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.bastra-${process.pid}.tmp`;
    const mode = await lstat(path).then(stat => stat.mode & 0o777).catch(() => 0o600);
    await writeFile(tmp, next, { mode, flag: "wx" });
    await rename(tmp, path);
    return { changed: true, detail: `${path}: managed bootstrap ${action === "install" ? "written; restart the host" : "removed"}` };
  } catch (error) { return { changed: false, detail: `${path}: ${(error as Error).message}`, error: true }; }
}

/** Read-only diagnostics: file parity does not establish runtime loading. */
export async function describeBootstrap(host: BootstrapHost, opts: { path?: string; projection?: string } = {}): Promise<string> {
  const path = opts.path ?? bootstrapPath(host);
  try {
    const source = await textAt(path);
    const expected = opts.projection ?? await bootstrapProjection();
    const inspection = inspectBootstrap(source, expected);
    const parts = [`${inspection.state}: ${path}`];
    if (inspection.state !== "current") parts.push(inspection.state === "missing" && /bastra-recall/i.test(source)
      ? "unmanaged Recall line exists; no write offered on Claude Code"
      : `repair with bastra install ${host} --with-bootstrap (optional, explicit consent)`);
    if (host === "codex") {
      const root = dirname(path);
      parts.push(`active CODEX_HOME/root: ${root}`);
      const override = await textAt(join(root, "AGENTS.override.md"));
      parts.push(override.trim() ? "SHADOWED by non-empty AGENTS.override.md; override untouched" : "AGENTS.md selected at global scope (empty override skipped)");
      const config = await textAt(join(root, "config.toml"));
      // Global root keys only. Per-project/CLI overrides cannot be proven here.
      const global = config.split(/^\s*\[/m)[0];
      const budget = Number(global.match(/^\s*project_doc_max_bytes\s*=\s*(\d+)\s*(?:#.*)?$/m)?.[1] ?? 32768);
      const end = inspection.end ?? source.length;
      parts.push(`instruction budget: ${budget} bytes; global file ${Buffer.byteLength(source)} bytes; ${Buffer.byteLength(source.slice(0, end)) > budget ? "bootstrap beyond budget" : "bootstrap fits global budget"}; combined project guidance/CLI overrides unverified`);
      const fallback = global.match(/^\s*project_doc_fallback_filenames\s*=\s*(.*)$/m)?.[1];
      parts.push(`project fallback selection: ${fallback ?? "none configured"}; project root/nearer overrides depend on launch directory`);
    } else {
      parts.push(`active Claude user root: ${dirname(path)}; CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ? "set (runtime discovery unverified)" : "default"}`);
      if (Buffer.byteLength(source) > 4 * 1024 * 1024) parts.push("over 4 MiB: host skips instruction file");
      if (source.split("\n").length > 200) parts.push("over recommended 200 lines; use /context to inspect delivery");
      parts.push("managed-only/exclusions/settings sources may suppress user instructions");
    }
    parts.push("file parity only; runtime loading and compliance unverified");
    return parts.join("; ");
  } catch (error) { return `bootstrap diagnosis failed: ${(error as Error).message}`; }
}
