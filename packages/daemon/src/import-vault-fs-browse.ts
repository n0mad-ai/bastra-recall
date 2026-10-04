/**
 * Folder picker for the map's import dialog (#215, split out of
 * `import-vault.ts` in #680): lists subdirectories, never file names or
 * contents. `import-vault.ts` re-exports everything here.
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJsonPlain } from "./webui.js";
import { getUiEnabled } from "./settings.js";

export interface FsBrowseEntry {
  name: string;
  path: string;
  /** Number of markdown files directly inside — a quick "is this a vault?" cue. */
  md: number;
}

/**
 * Subdirectories of `dir`, for the map's folder picker. Directories only —
 * never file names, never file contents. Dot-directories are included (the
 * common import source `~/.claude/projects/<x>/memory` lives behind one) but
 * sorted after the visible ones; node_modules is dropped.
 */
export async function listSubdirs(dir: string): Promise<{ path: string; parent: string | null; dirs: FsBrowseEntry[] }> {
  const abs = resolve(dir);
  const entries = await readdir(abs, { withFileTypes: true });
  const dirs: FsBrowseEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name === "node_modules") continue;
    const full = join(abs, e.name);
    let md = 0;
    try {
      md = (await readdir(full)).filter((n) => n.toLowerCase().endsWith(".md")).length;
    } catch {
      // unreadable subdir — still listed, just without the count
    }
    dirs.push({ name: e.name, path: full, md });
  }
  dirs.sort((a, b) => {
    const da = a.name.startsWith(".") ? 1 : 0;
    const db = b.name.startsWith(".") ? 1 : 0;
    return da - db || a.name.localeCompare(b.name);
  });
  const parent = dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, dirs };
}

/**
 * GET /ui/fs?path=<abs> — the folder picker's data source. Directory names
 * only, loopback + ui-gated like the rest of /ui (same trust boundary as the
 * import itself, which reads arbitrary local folders). Defaults to $HOME.
 */
export async function handleUiFsBrowse(
  req: IncomingMessage,
  res: ServerResponse,
  settingsPath?: string,
): Promise<void> {
  if (!(await getUiEnabled(settingsPath))) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  const u = new URL(req.url ?? "/", "http://127.0.0.1");
  const raw = u.searchParams.get("path");
  const dir = raw && raw.trim().length > 0 ? raw.trim() : homedir();
  if (!isAbsolute(dir)) {
    sendJsonPlain(res, 400, { error: "path must be absolute" });
    return;
  }
  try {
    sendJsonPlain(res, 200, await listSubdirs(dir));
  } catch (err) {
    sendJsonPlain(res, 400, { error: (err as Error).message });
  }
}
