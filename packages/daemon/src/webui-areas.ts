/**
 * Area management (#216) — create / rename / delete the vault's top-level
 * areas ("Überbereiche": individual projects under memories/projects/, and
 * user-defined top folders under memories/) from the map.
 *
 * Ground rules, from the vault's own physics:
 *   - An area IS a folder; memory ids are filenames and stay stable across
 *     renames — only paths (and, for project areas, the `scope:` frontmatter)
 *     change. related[]-links keep working by construction.
 *   - Delete is never destructive: the whole folder moves into the vault
 *     trash (`.bastra/trash/areas/<name>-<timestamp>/`), recoverable by hand.
 *   - Reserved system folders (projects, user, all-projects, taxonomy) route
 *     saves (save.ts subfolderFor) and are not editable.
 *   - After any bulk move the caller heals the index with ONE
 *     vault.reconcile() — drops run before adds there, so renames resolve
 *     cleanly. Never mix per-file reindexFile into a bulk move.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { clearAreaMark, isMarkdownFile, slugify, withAreaExclusive } from "@bastra-recall/core";
import { sendJsonPlain } from "./webui.js";
import { getUiEnabled } from "./settings.js";
import { ensureVaultDir } from "@bastra-recall/core";
import { areaPath, assertEditable, isDir, isReservedTop } from "./webui-areas-shared.js";
import { renameArea } from "./webui-areas-rename.js";
import { deleteArea } from "./webui-areas-delete.js";

// #680: rename and delete live in their own modules; re-exported so every
// importer keeps using webui-areas.ts.
export { renameArea } from "./webui-areas-rename.js";
export type { RenameResult } from "./webui-areas-rename.js";
export { deleteArea } from "./webui-areas-delete.js";
export type { DeleteResult } from "./webui-areas-delete.js";

export interface AreaInfo {
  /** Folder name — for project areas this is the scope. */
  name: string;
  /** "project" = memories/projects/<name>, "top" = memories/<name>. */
  kind: "project" | "top";
  /** Markdown files in the area, recursive. */
  count: number;
  /** Reserved system areas are listed but not editable. */
  reserved: boolean;
}

async function countMarkdown(dir: string): Promise<number> {
  let n = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    if (e.isDirectory()) n += await countMarkdown(join(dir, e.name));
    else if (e.isFile() && isMarkdownFile(e.name)) n++;
  }
  return n;
}

/** All areas: memories/<top> (minus projects) + memories/projects/<scope>. */
export async function listAreas(vaultRoot: string): Promise<AreaInfo[]> {
  const out: AreaInfo[] = [];
  const memRoot = join(vaultRoot, "memories");
  let tops: string[] = [];
  try {
    tops = (await readdir(memRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of tops.sort()) {
    if (name === "projects") continue;
    out.push({
      name,
      kind: "top",
      count: await countMarkdown(join(memRoot, name)),
      reserved: isReservedTop(name),
    });
  }
  const projRoot = join(memRoot, "projects");
  try {
    const projects = (await readdir(projRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
    for (const name of projects.sort()) {
      out.push({ name, kind: "project", count: await countMarkdown(join(projRoot, name)), reserved: false });
    }
  } catch {
    // no projects folder yet — fine
  }
  return out;
}

/** New project area — an empty folder; it shows on the map once the first
 *  memory lands in it, and immediately in the areas manager. */
export async function createArea(vaultRoot: string, rawName: string): Promise<AreaInfo> {
  const name = slugify(rawName);
  assertEditable("project", name);
  // Codex-Gegenreview Runde 10 (P0-1/P0-2): Area-Operationen liefen ohne jede
  // gegenseitige Ausschließung — parallel gegeneinander und gegen laufende
  // Saves. Ab hier gilt für Create, Rename und Delete derselbe EXKLUSIVE
  // Area-Claim, und der Save hält denselben Namen geteilt.
  return withAreaExclusive(vaultRoot, [name], () => createAreaLocked(vaultRoot, name));
}

async function createAreaLocked(vaultRoot: string, name: string): Promise<AreaInfo> {
  const dir = areaPath(vaultRoot, "project", name);
  if (await isDir(dir)) throw new Error(`area already exists: ${name}`);
  await ensureVaultDir(vaultRoot, dir);
  // Der eine Weg, einen Grabstein wieder abzuräumen (siehe `markAreaRenamed`
  // in core/area-claim.ts): Wer eine Area unter einem fortgezogenen oder
  // gelöschten Namen NEU anlegt, tut das bewusst — und ab hier ist der Name
  // wieder ein lebendes Regal. Ein Grabstein blockiert `createArea` deshalb
  // ausdrücklich NICHT; er soll nur verhindern, dass ein stale Save das Regal
  // beiläufig wiederbelebt, ohne dass jemand hinsieht.
  await clearAreaMark(vaultRoot, name);
  return { name, kind: "project", count: 0, reserved: false };
}

/**
 * GET/POST /ui/areas — the map's areas manager. GET lists; POST mutates:
 *   { action: "create", name }
 *   { action: "rename", kind, name, newName }
 *   { action: "delete", kind, name }
 * ui-gated + loopback-only like the rest of /ui. `onChanged` runs after a
 * successful mutation (the http layer passes vault.reconcile — the one
 * correct healing call after a bulk folder move).
 */
export async function handleUiAreas(
  req: IncomingMessage,
  res: ServerResponse,
  vaultRoot: string,
  onChanged?: () => Promise<unknown>,
  settingsPath?: string,
): Promise<void> {
  if (!(await getUiEnabled(settingsPath))) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  if (req.method === "GET") {
    sendJsonPlain(res, 200, { areas: await listAreas(vaultRoot) });
    return;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) {
      sendJsonPlain(res, 413, { error: "body too large" });
      return;
    }
  }
  let body: { action?: unknown; kind?: unknown; name?: unknown; newName?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    sendJsonPlain(res, 400, { error: "invalid JSON body" });
    return;
  }
  const kind = body.kind === "top" ? "top" : "project";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  try {
    let payload: unknown;
    if (body.action === "create") {
      payload = await createArea(vaultRoot, name);
    } else if (body.action === "rename") {
      const newName = typeof body.newName === "string" ? body.newName.trim() : "";
      if (!newName) throw new Error("newName is required");
      payload = await renameArea(vaultRoot, kind, name, newName);
    } else if (body.action === "delete") {
      payload = await deleteArea(vaultRoot, kind, name);
    } else {
      sendJsonPlain(res, 400, { error: "action must be create, rename or delete" });
      return;
    }
    if (onChanged) await onChanged().catch(() => {});
    sendJsonPlain(res, 200, { ok: true, result: payload });
  } catch (err) {
    sendJsonPlain(res, 400, { error: (err as Error).message });
  }
}
