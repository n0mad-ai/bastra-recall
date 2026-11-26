import { tasksEnabled } from "./tasks-enabled.js";
/**
 * Web UI (#207) — static file serving for /ui.
 *
 * Serves the self-contained UI v2 bundled in `packages/daemon/webui/app/`
 * (plain HTML/CSS/JS, vendored assets only) at /ui/, and the unchanged map
 * engines it hosts (Mindspace, Clouds, Semantic) from `webui/js/` at
 * /ui/engines/. Opt-in:
 * gated per-request on the `ui.enabled` cli-setting, so
 * `bastra config set ui.enabled true|false` takes effect without a daemon
 * restart. Loopback-only by construction: the route sits outside /api/v1/*,
 * so http.ts's DNS-rebinding host gate already covers it.
 */
import { createReadStream } from "node:fs";
import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SearchIndex } from "@bastra-recall/core";
import { getPrimaryLanguage, getUiEnabled } from "./settings.js";
import { MAX_BODY_BYTES, readJsonBody } from "./http-util.js";
import {
  CARE_FILE,
  appendCareEntry,
  CARE_KINDS,
  CareConflictError,
  formatCareEntry,
  parseCareFile,
  rewriteCareNote,
  type CareTarget,
} from "./vault-care.js";

/**
 * Content-Security-Policy for the map (#217).
 *
 * The map is a local-first tool whose whole promise is that the vault never
 * leaves the machine. Until the weather layer it made no outbound request at
 * all; now it talks to three hosts. Without a policy that is a promise with
 * nothing enforcing it — a compromised dependency, or one wrong line of mine,
 * could send anywhere and nobody would notice. With one, the BROWSER refuses,
 * loudly, and the guarantee becomes checkable instead of merely stated.
 *
 * Derived from what the page actually uses, verified against the sources:
 *   default-src 'self'  — everything not named below stays same-origin
 *   connect-src         — the daemon + exactly the three weather services
 *                         (webui/js/managers/weather.js: forecast · geocode
 *                         · reverse)
 *   img-src data: blob: — unused by the UI v2 today (the first UI's favicon
 *                         and image cropper needed them); left as it was
 *   style-src           — 'self' only, no 'unsafe-inline': no style=""
 *                         attribute and no injected <style> element; the
 *                         .style assignments in the scripts are CSSOM writes
 *                         and were never governed by this directive.
 *   object-src 'none' · frame-ancestors 'none' · base-uri 'self' — the page
 *                         embeds no plugins, must not be framed, and must not
 *                         let an injected <base> retarget its relative URLs.
 *
 * Deliberately absent: 'unsafe-eval' and inline script. The viewer has no
 * eval, no new Function, no inline <script> — keep it that way; anything that
 * needs them is the wrong shape for this page.
 *
 * When a new outbound host appears, add it HERE and nowhere else. A forgotten
 * entry fails visibly in the browser console, which is the intended behaviour:
 * silence would mean the policy was doing nothing.
 */
const CSP = [
  "default-src 'self'",
  "connect-src 'self' https://api.open-meteo.com https://geocoding-api.open-meteo.com https://api.bigdatacloud.net",
  "img-src 'self' data: blob:",
  "style-src 'self'",
  "script-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** dist/webui.js → ../webui/app — the asset folder ships at the package root. */
export function resolveWebUiDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "webui", "app");
}

/** dist/webui.js → ../webui/js — the map engines, served at /ui/engines/. */
export function resolveEngineDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "webui", "js");
}

const ENGINE_PREFIX = "engines/";

// ─── vault care — the file format lives in vault-care.ts ────────────────────
export { CARE_FILE, CARE_KINDS, formatCareEntry, parseCareFile };
export type { CareEntry, CareKind } from "./vault-care.js";

export function sendJsonPlain(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

/** GET /ui/search?q=… — semantic recall for the map's search box. Hybrid
 *  (BM25 + embeddings when live), lean hits only, never private memories. */
export async function handleUiSearch(
  res: ServerResponse,
  url: string,
  search: SearchIndex,
  settingsPath?: string
): Promise<void> {
  if (!(await getUiEnabled(settingsPath))) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  const q = new URL(url, "http://127.0.0.1").searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    sendJsonPlain(res, 200, { hits: [] });
    return;
  }
  try {
    const hits = await search.recallHybrid(q, { k: 8, allow_private: false });
    // Only hits that stand close to the top score make it into the type-ahead:
    // the long tail of a hybrid search is keyword noise and reads as fuzz.
    //
    // Relative to the top hit, not `max(100, …)`. The absolute half of that
    // floor produced an EMPTY list whenever the top hit itself scored under
    // 100 — a one-armed top hit is 81.967 by construction at any k, so the
    // search box already returned nothing for those queries, and RRF_K made
    // the case common rather than rare (measured on a 3 633-doc corpus:
    // 6.2% → 17.6% of queries). A floor above the best result the search has
    // is not a confidence filter, it is a switch that turns the box off.
    const floor = hits.length ? hits[0].score * 0.85 : 0;
    const confident = hits.filter((h) => h.score >= floor).slice(0, 5);
    sendJsonPlain(res, 200, {
      hits: confident.map((h) => ({ id: h.id, title: h.title, type: h.type, score: h.score })),
    });
  } catch (err) {
    sendJsonPlain(res, 500, { error: (err as Error).message });
  }
}

// ─── vault image — the ring view's center emblem ────────────────────────────

const IMAGE_TYPES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};
const IMAGE_BASENAME = "vault-image";
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** ?entity=<project> scopes the emblem to memories/projects/<project>/ —
 *  the image lives openly inside the project's own folder. Strictly one
 *  path-safe component; anything else falls back to the vault root. */
function imageDirFor(vaultPath: string, url: string): string {
  const entity = new URL(url, "http://127.0.0.1").searchParams.get("entity") ?? "";
  if (entity !== "" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entity) && !entity.includes("..")) {
    return join(vaultPath, "memories", "projects", entity);
  }
  return vaultPath;
}

async function findVaultImage(dir: string): Promise<{ file: string; type: string } | null> {
  for (const [type, ext] of Object.entries(IMAGE_TYPES)) {
    const file = join(dir, IMAGE_BASENAME + ext);
    try {
      if ((await stat(file)).isFile()) return { file, type };
    } catch {
      /* next */
    }
  }
  return null;
}

/** GET /ui/vault-image[?entity=…] — serve the emblem (404 → monogram).
 *  #1571: under ui.enabled like the POST beside it; nothing else reads it. */
export async function handleUiVaultImageGet(
  res: ServerResponse,
  url: string,
  vaultPath: string,
  settingsPath?: string
): Promise<void> {
  if (!(await getUiEnabled(settingsPath))) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  const found = await findVaultImage(imageDirFor(vaultPath, url));
  if (!found) {
    sendJsonPlain(res, 404, { error: "no vault image" });
    return;
  }
  const st = await stat(found.file);
  res.writeHead(200, { "Content-Type": found.type, "Content-Length": st.size, "Cache-Control": "no-cache" });
  createReadStream(found.file)
    .on("error", () => res.destroy())
    .pipe(res);
}

/** POST /ui/vault-image[?entity=…] — raw image body; stored as
 *  vault-image.<ext> at the vault root or inside the project folder (open
 *  files, visible in Obsidian/Finder like everything else). */
export async function handleUiVaultImagePost(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  vaultPath: string,
  settingsPath?: string
): Promise<void> {
  if (!(await getUiEnabled(settingsPath))) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  const dir = imageDirFor(vaultPath, url);
  if (dir !== vaultPath) {
    try {
      if (!(await stat(dir)).isDirectory()) throw new Error("not a directory");
    } catch {
      sendJsonPlain(res, 404, { error: "unknown project folder" });
      return;
    }
  }
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim();
  const ext = IMAGE_TYPES[type];
  if (!ext) {
    sendJsonPlain(res, 415, { error: "image/png, image/jpeg or image/webp only" });
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_IMAGE_BYTES) {
      sendJsonPlain(res, 413, { error: "max 2 MB" });
      return;
    }
    chunks.push(chunk as Buffer);
  }
  if (size === 0) {
    sendJsonPlain(res, 400, { error: "empty body" });
    return;
  }
  try {
    // one emblem at a time — drop other extensions before writing
    for (const oldExt of Object.values(IMAGE_TYPES)) {
      if (oldExt !== ext) await unlink(join(dir, IMAGE_BASENAME + oldExt)).catch(() => undefined);
    }
    await writeFile(join(dir, IMAGE_BASENAME + ext), Buffer.concat(chunks));
    sendJsonPlain(res, 200, { ok: true });
  } catch (err) {
    sendJsonPlain(res, 500, { error: (err as Error).message });
  }
}

/** GET /hook/care — open-flag count for the session hook. Deliberately NOT
 *  gated on ui.enabled: the file may exist from earlier use or hand-editing,
 *  and the session instruction should surface either way. */
export async function handleHookCare(res: ServerResponse, vaultPath: string): Promise<void> {
  try {
    const content = await readFile(join(vaultPath, CARE_FILE), "utf8");
    const open = parseCareFile(content).filter((e) => !e.done).length;
    sendJsonPlain(res, 200, { open, file: CARE_FILE });
  } catch {
    sendJsonPlain(res, 200, { open: 0, file: CARE_FILE });
  }
}

/** Both care reads and writes use the same transport-derived projection. */
function careTargetVisible(visibleIds: ReadonlySet<string> | null, id: string): boolean {
  return visibleIds === null || visibleIds.has(id);
}

/** GET /ui/annotations — the parsed care list. */
export async function handleUiAnnotations(
  res: ServerResponse,
  vaultPath: string,
  settingsPath?: string,
  /** Internal graph projection; null only after a proven peer-account check. */
  visibleIds: ReadonlySet<string> | null = new Set()
): Promise<void> {
  if (!(await getUiEnabled(settingsPath))) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  try {
    const content = await readFile(join(vaultPath, CARE_FILE), "utf8");
    const annotations = parseCareFile(content).filter((entry) => careTargetVisible(visibleIds, entry.id));
    sendJsonPlain(res, 200, { annotations });
  } catch {
    sendJsonPlain(res, 200, { annotations: [] }); // no file yet = empty list
  }
}

/** `previous` of an edit: the entry as the UI last read it (kind, date, note). */
function careTarget(id: string, v: unknown): CareTarget | null {
  const p = v as { kind?: unknown; date?: unknown; note?: unknown } | null;
  if (!p || typeof p !== "object") return null;
  if (typeof p.kind !== "string" || typeof p.date !== "string" || typeof p.note !== "string") return null;
  return { id, kind: p.kind, date: p.date, note: p.note };
}

/** Edit: replace the note of exactly the entry `previous` names. An emptied
 *  note is refused (removing a flag is not an edit); an entry changed or
 *  removed meanwhile answers 409 and nothing is written. */
async function editCareNote(res: ServerResponse, file: string, target: CareTarget, note: string): Promise<void> {
  if (!note) {
    sendJsonPlain(res, 400, { error: "note required to edit" });
    return;
  }
  try {
    sendJsonPlain(res, 200, { ok: true, entry: await rewriteCareNote(file, target, note) });
  } catch (err) {
    const gone = err instanceof CareConflictError || (err as NodeJS.ErrnoException).code === "ENOENT";
    sendJsonPlain(res, gone ? 409 : 500, {
      error: gone ? "entry changed or removed meanwhile" : (err as Error).message,
    });
  }
}

/** POST /ui/annotate {id, kind, note?, previous?} — append one care entry, or
 *  with `previous` {kind, date, note} replace the note of that entry in place.
 *  The note is stored unabridged; only the shared HTTP body cap
 *  (MAX_BODY_BYTES) applies, answered with 413 and nothing written. */
export async function handleUiAnnotate(
  req: IncomingMessage,
  res: ServerResponse,
  vaultPath: string,
  settingsPath?: string,
  /** Internal graph projection; null only after a proven peer-account check. */
  visibleIds: ReadonlySet<string> | null = new Set()
): Promise<void> {
  if (!(await getUiEnabled(settingsPath))) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  let body: { id?: unknown; kind?: unknown; note?: unknown; previous?: unknown };
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (err) {
    const msg = (err as Error).message;
    sendJsonPlain(res, msg.startsWith("body too large") ? 413 : 400, { error: msg });
    return;
  }
  const id = typeof body.id === "string" ? body.id.replace(/[[\]\n\r]/g, "").trim() : "";
  const kind = typeof body.kind === "string" ? body.kind : "";
  // No content limit: the note is kept in full, line breaks included.
  const note = typeof body.note === "string" ? body.note.replace(/\r\n?/g, "\n").trim() : "";
  if (!id || !(CARE_KINDS as readonly string[]).includes(kind)) {
    sendJsonPlain(res, 400, { error: "need id and kind (delete|edit|write|note)" });
    return;
  }
  if (!careTargetVisible(visibleIds, id)) {
    sendJsonPlain(res, 404, { error: "annotation target unavailable" });
    return;
  }
  const file = join(vaultPath, CARE_FILE);
  if (body.previous !== undefined) {
    const target = careTarget(id, body.previous);
    if (!target || target.kind !== kind) {
      sendJsonPlain(res, 400, { error: "previous needs the entry's kind, date and note" });
      return;
    }
    await editCareNote(res, file, target, note);
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  try {
    const entry = await appendCareEntry(file, { date, kind, id, note });
    sendJsonPlain(res, 200, { ok: true, entry });
  } catch (err) {
    sendJsonPlain(res, 500, { error: (err as Error).message });
  }
}

function sendPlain(res: ServerResponse, status: number, msg: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(msg);
}

/** The file behind a /ui/ path, or null when it would leave its folder:
 *  /ui/engines/<p> → <engineDir>/<p>, any other /ui/<p> → <webUiDir>/<p>. */
function uiFile(rel: string, webUiDir: string, engineDir: string): string | null {
  const engine = rel.startsWith(ENGINE_PREFIX);
  // Traversal guard: the resolved target must stay inside its asset dir.
  const root = resolve(engine ? engineDir : webUiDir);
  const target = resolve(root, normalize(engine ? rel.slice(ENGINE_PREFIX.length) : rel));
  return target === root || target.startsWith(root + sep) ? target : null;
}

/** An HTML page of the UI with the per-request <html> attributes, or null when it is not a file. */
async function readUiPage(target: string, settingsPath?: string): Promise<string | null> {
  // Bind validation and reading to one descriptor (#1238, CodeQL).
  const file = await open(target, "r");
  try {
    if (!(await file.stat()).isFile()) return null;
    // Resolve before first paint; disabled clients never wire the Tasks view.
    const enabled = tasksEnabled();
    // UI language follows language.primary: "de" → German, anything else → English.
    const lang = (await getPrimaryLanguage(settingsPath)) === "de" ? "de" : "en";
    return (await file.readFile("utf8")).replace("<html", `<html data-tasks-enabled="${enabled}" data-lang="${lang}"`);
  } finally {
    await file.close();
  }
}

/** #1198 GET /ui/login — the sign-in page (webui/app/login.html), reachable without a session. */
export async function serveLoginPage(
  res: ServerResponse,
  webUiDir: string = resolveWebUiDir(),
  settingsPath?: string
): Promise<void> {
  let html: string | null;
  try {
    html = await readUiPage(join(webUiDir, "login.html"), settingsPath);
  } catch {
    html = null;
  }
  if (html === null) {
    sendPlain(res, 404, "not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[".html"]!,
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
    "Content-Security-Policy": CSP,
  });
  res.end(html);
}

/**
 * #1198: a /ui request without a valid session. A page navigation (GET that
 * accepts text/html) goes to the sign-in page with the path it wanted as
 * `next` — always a relative /ui/ path, it is this request's own target; a
 * data route answers 401 JSON.
 */
export function sendUiAuthRequired(req: IncomingMessage, res: ServerResponse, method: string): void {
  const url = req.url ?? "";
  const page = (method === "GET" || method === "HEAD") && /\btext\/html\b/i.test(String(req.headers.accept ?? ""));
  if (page && url.startsWith("/ui") && !url.startsWith("//")) {
    const next = url === "/ui" || url.startsWith("/ui?") ? `/ui/${url.slice(3)}` : url;
    res.writeHead(302, { Location: `/ui/login?next=${encodeURIComponent(next)}`, "Cache-Control": "no-store" });
    res.end();
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  sendJsonPlain(res, 401, { error: "auth-required" });
}

/** Handles GET /ui and GET /ui/* — call only after the host gate passed.
 *  `webUiDir`/`settingsPath`/`engineDir` are injectable for tests only. */
export async function handleWebUi(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  webUiDir: string = resolveWebUiDir(),
  settingsPath?: string,
  engineDir: string = resolveEngineDir()
): Promise<void> {
  if (!(await getUiEnabled(settingsPath))) {
    sendPlain(res, 404, "vault map UI is disabled — enable with: bastra config set ui.enabled true");
    return;
  }

  // /ui → /ui/ so relative asset paths in index.html resolve.
  if (url === "/ui") {
    res.writeHead(302, { Location: "/ui/", "Cache-Control": "no-store" });
    res.end();
    return;
  }

  const pathname = decodeURIComponent(new URL(url, "http://127.0.0.1").pathname);
  const rel = pathname === "/ui/" ? "index.html" : pathname.slice("/ui/".length);

  const target = uiFile(rel, webUiDir, engineDir);
  if (target === null) {
    sendPlain(res, 403, "forbidden");
    return;
  }

  const type = CONTENT_TYPES[extname(target).toLowerCase()];
  if (type === undefined) {
    sendPlain(res, 404, "not found");
    return;
  }

  try {
    let html: string | undefined;
    let contentLength: number;
    if (rel === "index.html") {
      html = (await readUiPage(target, settingsPath)) ?? undefined;
      if (html === undefined) {
        sendPlain(res, 404, "not found");
        return;
      }
      contentLength = Buffer.byteLength(html);
    } else {
      const st = await stat(target);
      if (!st.isFile()) {
        sendPlain(res, 404, "not found");
        return;
      }
      contentLength = st.size;
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": contentLength,
      // Short-lived cache: assets change with daemon updates, not per request.
      "Cache-Control": html === undefined ? "max-age=60" : "no-store",
      // CSP governs a DOCUMENT, so it rides on the html only — on a stylesheet
      // or a script response the browser ignores it, and shipping it there
      // would just suggest a protection that isn't happening.
      ...(type.startsWith("text/html") ? { "Content-Security-Policy": CSP } : {}),
    });
    if (html !== undefined) {
      res.end(html);
      return;
    }
    createReadStream(target)
      .on("error", () => res.destroy())
      .pipe(res);
  } catch {
    sendPlain(res, 404, "not found");
  }
}
