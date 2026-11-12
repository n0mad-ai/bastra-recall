/**
 * Background image of the web UI (settings ui.backdrop / ui.backdropDim / ui.backdropBlur).
 *
 *   GET  /ui/backdrop          → { backdrop, dim, blur, uploads: [{ id, name, url }] }
 *   GET  /ui/backdrop/<id>     → the uploaded image (id = up-<16 hex>, nothing else resolves)
 *   POST /ui/backdrop?name=…   → raw image body (png | jpeg | webp, ≤ 8 MB) → { id, name, url }
 *
 * Uploads stay on this machine: <data dir>/backdrops/<id>.<ext>, never in the vault.
 * The file name on disk comes only from a server-generated id; the user's name is
 * display text in uploads.json. Loopback, account and same-origin gates run in
 * http.ts before this dispatcher (gateLocalPost admits the image types for this path).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bastraDataDir } from "./platform-paths.js";
import { getUiEnabled, readSettings } from "./settings.js";
import { BACKDROP_UPLOAD_ID, SETTINGS_REGISTRY } from "./settings-registry.js";
import { sendJson } from "./http-util.js";

export const BACKDROP_MAX_BYTES = 8 * 1024 * 1024;
export const BACKDROP_MAX_UPLOADS = 24;
const TYPES: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
const BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(TYPES).map(([type, ext]) => [ext, type]));

export interface BackdropOptions { settingsPath?: string; dir?: string; }
interface Upload { id: string; name: string; ext: string; }

const dirOf = (o: BackdropOptions) => o.dir ?? join(bastraDataDir(), "backdrops");
const urlOf = (id: string) => `/ui/backdrop/${id}`;

/** Magic bytes decide, not the declared type alone. */
function sniff(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** uploads.json is local data: every row is checked again before use. */
async function readIndex(dir: string): Promise<Upload[]> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(join(dir, "uploads.json"), "utf8")); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.filter((u): u is Upload => !!u && typeof u === "object"
    && typeof u.id === "string" && BACKDROP_UPLOAD_ID.test(u.id)
    && typeof u.ext === "string" && u.ext in BY_EXT
    && typeof u.name === "string");
}

async function writeIndex(dir: string, rows: Upload[]): Promise<void> {
  const tmp = join(dir, `uploads.json.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(tmp, JSON.stringify(rows, null, 2));
  await rename(tmp, join(dir, "uploads.json"));
}

async function present(dir: string): Promise<Upload[]> {
  const rows = await readIndex(dir);
  const ok = await Promise.all(rows.map(async (u) => { try { return (await stat(join(dir, u.id + u.ext))).isFile(); } catch { return false; } }));
  return rows.filter((_, i) => ok[i]);
}

/** Display name only: no control characters, bounded length. */
export function backdropName(raw: string | null): string {
  const clean = (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\.[A-Za-z0-9]{1,5}$/, "").trim().slice(0, 80);
  return clean || "image";
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BACKDROP_MAX_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function state(o: BackdropOptions) {
  const s = (await readSettings(o.settingsPath)).ui;
  const uploads = await present(dirOf(o));
  const d = SETTINGS_REGISTRY.ui;
  let backdrop = s?.backdrop ?? d.backdrop.default;
  // A stored upload whose file is gone falls back to no image.
  if (BACKDROP_UPLOAD_ID.test(backdrop) && !uploads.some((u) => u.id === backdrop)) backdrop = "none";
  return { backdrop, dim: s?.backdropDim ?? d.backdropDim.default, blur: s?.backdropBlur ?? d.backdropBlur.default,
    uploads: uploads.map((u) => ({ id: u.id, name: u.name, url: urlOf(u.id) })) };
}

async function handle(req: IncomingMessage, res: ServerResponse, method: string, path: string, query: URLSearchParams, o: BackdropOptions): Promise<void> {
  if (!(await getUiEnabled(o.settingsPath))) { sendJson(res, 404, { error: "ui disabled" }); return; }
  const dir = dirOf(o);
  if (path === "/ui/backdrop" && method === "GET") { res.setHeader("Cache-Control", "no-store"); sendJson(res, 200, await state(o)); return; }
  if (path === "/ui/backdrop" && method === "POST") {
    const declared = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (!(declared in TYPES)) { sendJson(res, 415, { error: "image/png, image/jpeg or image/webp only" }); return; }
    const body = await readBody(req);
    if (body === null) { sendJson(res, 413, { error: "max 8 MB" }); return; }
    if (sniff(body) !== declared) { sendJson(res, 415, { error: "not a png, jpeg or webp image" }); return; }
    await mkdir(dir, { recursive: true });
    const rows = await present(dir);
    if (rows.length >= BACKDROP_MAX_UPLOADS) { sendJson(res, 409, { error: `at most ${BACKDROP_MAX_UPLOADS} images` }); return; }
    const up: Upload = { id: `up-${randomBytes(8).toString("hex")}`, name: backdropName(query.get("name")), ext: TYPES[declared] };
    await writeFile(join(dir, up.id + up.ext), body, { flag: "wx" });
    await writeIndex(dir, [...rows, up]);
    sendJson(res, 200, { id: up.id, name: up.name, url: urlOf(up.id) });
    return;
  }
  const id = path.slice("/ui/backdrop/".length);
  if (method !== "GET" || !BACKDROP_UPLOAD_ID.test(id)) { sendJson(res, 404, { error: "not found" }); return; }
  const up = (await readIndex(dir)).find((u) => u.id === id);
  if (!up) { sendJson(res, 404, { error: "not found" }); return; }
  const file = join(dir, up.id + up.ext);
  let size: number;
  try { const st = await stat(file); if (!st.isFile()) throw new Error("not a file"); size = st.size; } catch { sendJson(res, 404, { error: "not found" }); return; }
  // Ids are random and never reused: the bytes behind one never change.
  res.writeHead(200, { "Content-Type": BY_EXT[up.ext], "Content-Length": size, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

/** Returns true when the request belongs to /ui/backdrop. */
export function dispatchUiBackdrop(req: IncomingMessage, res: ServerResponse, method: string, url: string, o: BackdropOptions = {}): boolean {
  const u = new URL(url, "http://127.0.0.1");
  if (u.pathname !== "/ui/backdrop" && !u.pathname.startsWith("/ui/backdrop/")) return false;
  handle(req, res, method, u.pathname, u.searchParams, o).catch(() => { if (!res.headersSent) sendJson(res, 500, { error: "backdrop error" }); else res.destroy(); });
  return true;
}
