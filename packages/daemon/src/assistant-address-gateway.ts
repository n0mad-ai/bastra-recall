/** UI-only loopback gateway. This module and its pure imports also run from a
 * launchd inetd socket as the installing user, never as root. */
import { createServer, request, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { normalizeAssistantName } from "./assistant-address-name.js";
import { managedAssistantHostsName } from "./assistant-address-files.js";
import { gateLocalPost, isLoopback } from "./http-auth.js";

export interface AssistantGatewayOptions {
  helperPath?: string; settingsPath: string; hostsPath: string; daemonUrl: string; owner?: string; }
export async function readAssistantGatewayConfig(path: string): Promise<{ name: string; enabled: boolean } | null> {
  try { const data = JSON.parse(await readFile(path, "utf8")); return { name: normalizeAssistantName(data.assistant?.name), enabled: data.ui?.enabled === true }; }
  catch { return null; }
}
function reply(res: ServerResponse, code: number, error: string) { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ error })); }
export function assistantUiPath(path: string, method: string): boolean {
  if (method !== "GET" && method !== "POST" && method !== "HEAD") return false;
  if (path === "/ui" || path.startsWith("/ui/")) return true;
  if (method === "GET" && ["/api/v1/graph", "/api/v1/graph/node", "/api/v1/graph/semantic"].includes(path)) return true;
  return method === "POST" && /^\/api\/v1\/task_[a-z_]+$/.test(path);
}
export function assistantGatewayHandler(opts: AssistantGatewayOptions) {
  const target = new URL(opts.daemonUrl);
  if (target.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(target.hostname) || target.username || target.password || target.pathname !== "/" || target.search || target.hash) throw new Error("assistant gateway requires a fixed loopback daemon URL");
  const owner = opts.owner ?? String(process.getuid?.() ?? 0);
  return (req: IncomingMessage, res: ServerResponse): void => { void (async () => {
    if (!isLoopback(req)) return reply(res, 403, "loopback only");
    const config = await readAssistantGatewayConfig(opts.settingsPath);
    if (!config?.enabled) return reply(res, 404, "assistant UI is disabled");
    const rawHost = req.headers.host?.toLowerCase() ?? "";
    const host = rawHost.replace(new RegExp(`:${req.socket.localPort}$`), "").replace(/\.$/, "");
    let bareReady = false;
    if (host === config.name) {
      try { bareReady = managedAssistantHostsName(await readFile(opts.hostsPath, "utf8"), owner) === config.name; } catch { /* unknown ownership stays closed */ }
    }
    if (![`${config.name}.localhost`, "localhost", "127.0.0.1", "[::1]"].includes(host) && !bareReady) return reply(res, 403, "host not allowed");
    if (req.headers.origin !== undefined) {
      try { const origin = new URL(req.headers.origin); if (origin.protocol !== "http:" || origin.host.toLowerCase() !== rawHost) return reply(res, 403, "origin not allowed"); }
      catch { return reply(res, 403, "origin not allowed"); }
    }
    const raw = req.url ?? "/", method = req.method ?? "GET";
    if (!raw.startsWith("/") || raw.startsWith("//")) return reply(res, 400, "invalid path");
    const url = new URL(raw, "http://localhost");
    if (/%(?:2f|5c|00)/i.test(url.pathname)) return reply(res, 404, "not found");
    if (method === "GET" && url.pathname === "/.well-known/bastra-assistant-address") {
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ service: "bastra-assistant-address", name: config.name })); return;
    }
    if (method === "GET" && url.pathname === "/") { res.writeHead(302, { Location: "/ui/", "Cache-Control": "no-store" }); res.end(); return; }
    if (!assistantUiPath(url.pathname, method)) return reply(res, 404, "not found");
    if (method === "POST") {
      const gate = gateLocalPost({ origin: req.headers.origin, host: req.headers.host, contentType: req.headers["content-type"], path: url.pathname });
      if (gate !== 200) return reply(res, gate, gate === 403 ? "origin not allowed" : "unsupported content type");
    }
    const headers: import("node:http").OutgoingHttpHeaders = { ...req.headers, host: target.host };
    for (const key of ["connection", "upgrade", "proxy-authorization", "proxy-authenticate", "keep-alive", "transfer-encoding", "te", "trailer", "forwarded", "x-forwarded-host", "x-forwarded-for", "x-forwarded-proto"]) delete headers[key];
    if (headers.origin !== undefined) headers.origin = target.origin;
    if (headers.referer !== undefined) headers.referer = `${target.origin}/ui/`;
    const upstream = request(target, { method, path: url.pathname + url.search, headers }, response => {
      const responseHeaders = { ...response.headers };
      for (const key of Object.keys(responseHeaders)) if (key.startsWith("access-control-") || ["connection", "transfer-encoding", "upgrade"].includes(key)) delete responseHeaders[key];
      res.writeHead(response.statusCode ?? 502, responseHeaders); response.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) reply(res, 502, "local UI daemon unavailable"); else res.destroy(); });
    upstream.setTimeout(url.pathname.startsWith("/ui/assistant-address") ? 210000 : 30000, () => upstream.destroy());
    req.on("aborted", () => upstream.destroy()); res.on("close", () => upstream.destroy()); req.pipe(upstream);
  })().catch(() => { if (!res.headersSent) reply(res, 500, "assistant gateway error"); else res.destroy(); }); };
}

export function createAssistantAddressListener(opts: AssistantGatewayOptions, port = 80) {
  let server: Server | null = null;
  let serial: Promise<unknown> = Promise.resolve();
  const close = async () => { const old = server; server = null; if (old) { old.closeAllConnections(); await new Promise<void>(r => old.close(() => r())); } };
  return {
    refresh(): Promise<{ ready: boolean; port?: number; error?: string }> {
      const work = async () => {
        const config = await readAssistantGatewayConfig(opts.settingsPath);
        if (!config?.enabled) { await close(); return { ready: false }; }
        if (opts.helperPath) {
          try {
            const helper = await readFile(opts.helperPath,"utf8");
            if (helper.includes(`<key>BASTRA_ASSISTANT_ADDRESS_OWNER</key><string>${opts.owner ?? process.getuid?.() ?? 0}</string>`)) { await close(); return { ready: false }; }
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { await close(); return { ready: false }; } }
        }
        if (server) return { ready: true, port: (server.address() as {port:number}).port };
        const candidate = createServer(assistantGatewayHandler(opts));
        return new Promise<{ready:boolean;port?:number;error?:string}>(resolve => {
          candidate.once("error", (error: NodeJS.ErrnoException) => resolve({ ready: false, error: error.code ?? "listen failed" }));
          candidate.listen(port, "127.0.0.1", () => { server = candidate; candidate.removeAllListeners("error"); candidate.on("error", () => {}); resolve({ ready: true, port: (candidate.address() as {port:number}).port }); });
        });
      };
      const next = serial.then(work, work); serial = next; return next;
    },
    close,
  };
}

// Wait=true hands over one listening IPv4 loopback socket on fd 0.
// Older installed Wait=false plists retain their accepted-socket entry path
// until the next explicitly approved setup. No root request code is involved.
if (process.argv.includes("--assistant-address-inetd")) {
  const arg = (key: string) => process.argv[process.argv.indexOf(key) + 1];
  const opts = { settingsPath: arg("--settings-path"), hostsPath: arg("--hosts-path"), daemonUrl: arg("--daemon-url") };
  try {
    const server = createServer(assistantGatewayHandler(opts));
    if (process.env.BASTRA_ASSISTANT_ADDRESS_LISTEN === "1") {
      server.on("error", () => { process.stderr.write("assistant address listener unavailable\n");process.exitCode=1; });
      server.listen({fd:0});
    } else {
      const socket = new Socket({ fd: 0, readable: true, writable: true });
      socket.on("close", () => process.exit(0)); socket.setTimeout(230000, () => socket.destroy());
      server.emit("connection", socket); socket.resume();
    }
  } catch { process.stderr.write("assistant address socket unavailable\n"); process.exitCode = 1; }
}
