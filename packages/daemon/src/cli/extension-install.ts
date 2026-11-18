/**
 * `bastra install claude-desktop --extension` — the CLI on-ramp to the
 * .mcpb Desktop Extension (#218). Claude Desktop does not allow headless
 * extension installs, so the best a CLI can do is "one command + one
 * click": fetch the right .mcpb (local build → versioned release asset →
 * latest release asset), install the skill, offer to remove a config-file
 * registration (duplicate tools otherwise), and hand the bundle to the
 * Desktop app via `open` — the user confirms Install in Desktop's dialog.
 */
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeDesktopAdapter } from "./adapters/claude-desktop.js";
import { CLAUDE_DESKTOP_CONFIG } from "./paths.js";
import { SERVER_KEY, fileExists, getServersBlock, readJsonConfig } from "./helpers.js";
import { copySkill } from "./skill.js";
import { extensionWords, type ExtensionWords } from "./extension-words.js";
import { confirm, isInteractive } from "./prompt.js";
import type { ParsedArgs } from "./types.js";

const REPO = "n0mad-ai/bastra-recall";
/** A real bundle is megabytes; anything tiny is an error page, not a .mcpb. */
const MIN_MCPB_BYTES = 100 * 1024;

function pkgRoot(): string {
  // dist layout: dist/cli/… → package root is one up; running from src
  // (tsx in tests) it is two up. Walk up to the first package.json.
  let dir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (let i = 0; i < 3; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = resolve(dir, "..");
  }
  return dir;
}

export async function pkgVersion(): Promise<string> {
  const raw = await readFile(join(pkgRoot(), "package.json"), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

/** Dev checkout: a locally built bundle next to dist/ wins over any download. */
export function localMcpbPath(version: string, root: string = pkgRoot()): string {
  return join(root, "mcpb", `bastra-recall-${version}.mcpb`);
}

export function releaseDownloadUrl(version: string): string {
  return `https://github.com/${REPO}/releases/download/v${version}/bastra-recall-${version}.mcpb`;
}

/** Fallback when this CLI version's release carries no bundle (yet): the
 *  newest release's .mcpb asset, whatever version it is. */
export async function latestMcpbAssetUrl(): Promise<string | null> {
  const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!resp.ok) return null;
  const body = (await resp.json()) as { assets?: Array<{ name?: string; browser_download_url?: string }> };
  const asset = (body.assets ?? []).find((a) => a.name?.endsWith(".mcpb"));
  return asset?.browser_download_url ?? null;
}

/** First whitespace-delimited token of a `.sha256` file, when it is a
 *  SHA-256 hex digest — tolerates both `<hex>` and `<hex>  <filename>`. */
export function parseSha256(text: string): string | null {
  const token = text.trim().split(/\s+/)[0] ?? "";
  return /^[a-f0-9]{64}$/i.test(token) ? token.toLowerCase() : null;
}

async function fetchChecksum(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return parseSha256(await resp.text());
  } catch {
    return null;
  }
}

async function download(url: string, dest: string, w: ExtensionWords): Promise<boolean> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return false;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength < MIN_MCPB_BYTES) return false;
    // #281: releases carry a .sha256 next to the bundle since 0.9.1 — verify
    // when it is there; a mismatch discards the download. Older releases (the
    // latest-asset fallback can land on one) never published a checksum, so
    // absence downgrades to a visible skip instead of breaking the install.
    const expected = await fetchChecksum(`${url}.sha256`);
    if (expected) {
      const actual = createHash("sha256").update(buf).digest("hex");
      if (actual !== expected) {
        process.stderr.write(w.checksumMismatch);
        return false;
      }
      process.stdout.write(w.checksumVerified);
    } else {
      process.stdout.write(w.noChecksum);
    }
    // "wx": the destination lives in a fresh private mkdtemp dir, so it must
    // not exist — refusing to follow a pre-planted file/symlink.
    await writeFile(dest, buf, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export async function cmdInstallExtension(args: ParsedArgs): Promise<number> {
  const w = await extensionWords();
  if (platform() !== "darwin") {
    process.stderr.write(w.macOnly);
    return 2;
  }
  const version = await pkgVersion();

  if (args.dryRun) {
    process.stdout.write(w.dryRun(version));
    return 0;
  }

  // Skill: Desktop reads ~/.claude/skills/ regardless of how the MCP server
  // is registered — the extension path needs it just like the config path.
  const skill = await copySkill({ dryRun: false });
  if (skill.status === "error") {
    process.stderr.write(w.skillFailed(skill.detail));
    return 1;
  }
  process.stdout.write(w.skill(skill.detail));

  // Locate the bundle.
  let mcpbPath = localMcpbPath(version);
  if (await fileExists(mcpbPath)) {
    process.stdout.write(w.localBuild(mcpbPath));
  } else {
    // Private per-run mkdtemp dir (0700) — a predictable path in the shared
    // tmpdir could be pre-planted or swapped between write and `open`.
    mcpbPath = join(await mkdtemp(join(tmpdir(), "bastra-mcpb-")), `bastra-recall-${version}.mcpb`);
    process.stdout.write(w.downloading(version));
    let ok = await download(releaseDownloadUrl(version), mcpbPath, w);
    if (!ok) {
      const latest = await latestMcpbAssetUrl();
      if (latest) {
        process.stdout.write(w.fallback(version));
        ok = await download(latest, mcpbPath, w);
      }
    }
    if (!ok) {
      process.stderr.write(w.noBundle);
      return 1;
    }
  }

  // Duplicate-tools guard: a config-file registration next to the extension
  // means every tool shows up twice in Desktop.
  const read = await readJsonConfig(CLAUDE_DESKTOP_CONFIG);
  const hasConfigServer = !("error" in read) && SERVER_KEY in (getServersBlock(read.data) ?? {});
  if (hasConfigServer) {
    const remove = args.yes ? true : isInteractive() ? await confirm(w.removeQuestion, { defaultYes: true }) : false;
    if (remove) {
      const un = await claudeDesktopAdapter.uninstall({ dryRun: false });
      process.stdout.write(w.configRegistration(un.message));
    } else {
      process.stdout.write(w.keeping);
    }
  }

  // Hand the bundle to Claude Desktop — its dialog owns the final Install click.
  spawn("open", [mcpbPath], { detached: true, stdio: "ignore" }).unref();
  process.stdout.write(w.handed(mcpbPath, `https://github.com/${REPO}/wiki/Claude-Desktop`));
  return 0;
}
