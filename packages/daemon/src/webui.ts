/**
 * Vault map web UI (#207) — static file serving for /ui.
 *
 * Serves the self-contained viewer bundled in `packages/daemon/webui/`
 * (plain HTML/CSS/JS, vendored assets only, zero external requests). Opt-in:
 * gated per-request on the `ui.enabled` cli-setting, so
 * `bastra config set ui.enabled true|false` takes effect without a daemon
 * restart. Loopback-only by construction: the route sits outside /api/v1/*,
 * so http.ts's DNS-rebinding host gate already covers it.
 */
import { createReadStream } from "node:fs";
import { appendFile, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SearchIndex } from "@bastra-recall/core";
import { getUiEnabled } from "./settings.js";

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
 *                         (managers/weather.js: forecast · geocode · reverse)
 *   img-src data:       — the inline SVG favicon in index.html
 *           blob:       — components/image-cropper.js previews a picked file
 *   style-src           — 'self' only. The three style="" attributes
 *                         that once justified 'unsafe-inline' here are gone
 *                         from index.html, and the colour dots in search.js
 *                         and inspector.js are set through the CSSOM after
 *                         insertion; the .style assignments across the
 *                         managers are CSSOM writes and were never governed
 *                         by this directive. ctxmenu.js can still set an
 *                         inline style attribute from an item's `style`
 *                         field, but nothing in this app populates it.
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

/** dist/webui.js → ../webui — the asset folder ships at the package root. */
export function resolveWebUiDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "webui");
}

// ─── vault care — annotations from the map, worked off in an AI session ────
//
// The map never edits memories. Instead the user flags them ("delete",
// "edit", "write this unwritten note", free note); each flag is appended to
// `vault-care.md` at the vault root — plain markdown with checkbox lines and
// wikilinks, readable by Obsidian, any AI session, and any viewer (#140).
// An AI session works the list off together with the user and ticks entries
// `[x]`; the map only shows unticked ones.

export const CARE_FILE = "vault-care.md";
export const CARE_KINDS = ["delete", "edit", "write", "note"] as const;
export type CareKind = (typeof CARE_KINDS)[number];

const CARE_HEADER = `# Vault Care

Flags from the vault map. In an AI session, say "let's work off the vault
care list" — go through the open entries together, apply them via the memory
tools, and tick them \`[x]\` here when done.

`;
const CARE_LINE_RE = /^- \[([ x])\] (\d{4}-\d{2}-\d{2}) · (\w+) · \[\[([^\]]+)\]\](?: — (.*))?$/;

export interface CareEntry {
  done: boolean;
  date: string;
  kind: string;
  id: string;
  note: string;
}

export function parseCareFile(content: string): CareEntry[] {
  const out: CareEntry[] = [];
  for (const line of content.split("\n")) {
    const m = CARE_LINE_RE.exec(line.trimEnd());
    if (m) out.push({ done: m[1] === "x", date: m[2], kind: m[3], id: m[4], note: m[5] ?? "" });
  }
  return out;
}

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
  settingsPath?: string,
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

/** GET /ui/vault-image[?entity=…] — serve the emblem (404 → monogram). */
export async function handleUiVaultImageGet(res: ServerResponse, url: string, vaultPath: string): Promise<void> {
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
  settingsPath?: string,
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

/** GET /ui/annotations — the parsed care list. */
export async function handleUiAnnotations(
  res: ServerResponse,
  vaultPath: string,
  settingsPath?: string,
): Promise<void> {
  if (!(await getUiEnabled(settingsPath))) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  try {
    const content = await readFile(join(vaultPath, CARE_FILE), "utf8");
    sendJsonPlain(res, 200, { annotations: parseCareFile(content) });
  } catch {
    sendJsonPlain(res, 200, { annotations: [] }); // no file yet = empty list
  }
}

/** POST /ui/annotate {id, kind, note?} — append one care entry. */
export async function handleUiAnnotate(
  req: IncomingMessage,
  res: ServerResponse,
  vaultPath: string,
  settingsPath?: string,
): Promise<void> {
  if (!(await getUiEnabled(settingsPath))) {
    sendJsonPlain(res, 404, { error: "ui disabled" });
    return;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) {
      sendJsonPlain(res, 413, { error: "body too large" });
      return;
    }
  }
  let body: { id?: unknown; kind?: unknown; note?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    sendJsonPlain(res, 400, { error: "invalid json" });
    return;
  }
  const id = typeof body.id === "string" ? body.id.replace(/[[\]\n\r]/g, "").trim() : "";
  const kind = typeof body.kind === "string" ? body.kind : "";
  const note =
    typeof body.note === "string" ? body.note.replace(/[\n\r]+/g, " ").trim().slice(0, 500) : "";
  if (!id || !(CARE_KINDS as readonly string[]).includes(kind)) {
    sendJsonPlain(res, 400, { error: "need id and kind (delete|edit|write|note)" });
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  const line = `- [ ] ${date} · ${kind} · [[${id}]]${note ? ` — ${note}` : ""}\n`;
  const file = join(vaultPath, CARE_FILE);
  try {
    // "wx" creates the header only when the file does not exist yet —
    // atomic, no stat-then-write race with a concurrent flag request.
    try {
      await writeFile(file, CARE_HEADER, { encoding: "utf8", flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    await appendFile(file, line, "utf8");
    sendJsonPlain(res, 200, { ok: true, entry: { done: false, date, kind, id, note } });
  } catch (err) {
    sendJsonPlain(res, 500, { error: (err as Error).message });
  }
}

function sendPlain(res: ServerResponse, status: number, msg: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(msg);
}

/** Handles GET /ui and GET /ui/* — call only after the host gate passed.
 *  `webUiDir`/`settingsPath` are injectable for tests only. */
export async function handleWebUi(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  webUiDir: string = resolveWebUiDir(),
  settingsPath?: string,
): Promise<void> {
  if (!(await getUiEnabled(settingsPath))) {
    sendPlain(res, 404, "vault map UI is disabled — enable with: bastra config set ui.enabled true");
    return;
  }

  // /ui → /ui/ so relative asset paths in index.html resolve.
  if (url === "/ui") {
    res.writeHead(302, { Location: "/ui/" });
    res.end();
    return;
  }

  const pathname = decodeURIComponent(new URL(url, "http://127.0.0.1").pathname);
  const rel = pathname === "/ui/" ? "index.html" : pathname.slice("/ui/".length);

  // Traversal guard: the resolved target must stay inside the asset dir.
  const root = resolve(webUiDir);
  const target = resolve(root, normalize(rel));
  if (target !== root && !target.startsWith(root + sep)) {
    sendPlain(res, 403, "forbidden");
    return;
  }

  const type = CONTENT_TYPES[extname(target).toLowerCase()];
  if (type === undefined) {
    sendPlain(res, 404, "not found");
    return;
  }

  try {
    const st = await stat(target);
    if (!st.isFile()) {
      sendPlain(res, 404, "not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": st.size,
      // Short-lived cache: assets change with daemon updates, not per request.
      "Cache-Control": "max-age=60",
      // CSP governs a DOCUMENT, so it rides on the html only — on a stylesheet
      // or a script response the browser ignores it, and shipping it there
      // would just suggest a protection that isn't happening.
      ...(type.startsWith("text/html") ? { "Content-Security-Policy": CSP } : {}),
    });
    createReadStream(target)
      .on("error", () => res.destroy())
      .pipe(res);
  } catch {
    sendPlain(res, 404, "not found");
  }
}
