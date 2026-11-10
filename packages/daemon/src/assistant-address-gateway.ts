/** UI-only loopback gateway. This module and its pure imports also run from a
 * launchd inetd socket as the installing user, never as root. */
import { createServer, request, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { normalizeAssistantName } from "./assistant-address-name.js";
import { managedAssistantHostsName } from "./assistant-address-files.js";
import { gateLocalPost, isLoopback } from "./http-auth.js";
import { readRuntimeSettingsRecord } from "./runtime-feature-settings.js";

export const ASSISTANT_SOCKET_PROTOCOL=2;
export interface AssistantGatewayOptions {
  runtimeStatePath?:string;runtimeVersion?:string;
  helperPath?: string; settingsPath: string; databasePath?: string; hostsPath: string; daemonUrl: string; owner?: string; }
export async function readAssistantGatewayConfig(path: string, databasePath?: string): Promise<{ name: string; enabled: boolean } | null> {
  try {
    const stored = readRuntimeSettingsRecord(path, databasePath);
    const data = JSON.parse(stored === undefined ? await readFile(path, "utf8") : stored ?? "{}");
    return { name: normalizeAssistantName(data.assistant?.name), enabled: data.ui?.enabled === true };
  }
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
    if(opts.runtimeStatePath){
      const current=JSON.parse(await readFile(opts.runtimeStatePath,"utf8"));
      if(current.protocol!==ASSISTANT_SOCKET_PROTOCOL||current.version!==opts.runtimeVersion||current.daemonUrl!==opts.daemonUrl||current.databasePath!==opts.databasePath){res.setHeader("Connection","close");return reply(res,503,"assistant runtime changed; retry the request");}
    }
    const config = await readAssistantGatewayConfig(opts.settingsPath, opts.databasePath);
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
    // #1264: preserve forwarding evidence and Authorization so the daemon
    // cannot mistake a proxied caller for a tokenless direct-local request.
    for (const key of ["connection", "upgrade", "proxy-authorization", "proxy-authenticate", "keep-alive", "transfer-encoding", "te", "trailer", "x-forwarded-proto"]) delete headers[key];
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
        const config = await readAssistantGatewayConfig(opts.settingsPath, opts.databasePath);
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

/** Handles accepted sockets, plus compatibility for previously installed Wait=true jobs. */
export async function startAssistantSocket(opts:AssistantGatewayOptions,listening=false):Promise<Server>{
 const rejected=new WeakSet<Socket>(),gateway=assistantGatewayHandler(opts);
 const server=createServer((req,res)=>{
  // end(raw503) does not prevent a parser from emitting an already buffered
  // request. Rejection belongs to the socket and must guard forwarding too.
  if(rejected.has(req.socket)){req.resume();return;}
  gateway(req,res);
 });
 if(listening){
  // Each of the two launchd jobs owns one listener. Admission here bounds
  // connections, never creates a process: the only process was admitted by launchd.
  const sockets=new Set<Socket>(),headers=new Map<Socket,NodeJS.Timeout>();
  const [headersMs,lifetimeMs]=(process.env.BASTRA_ASSISTANT_ADDRESS_TEST_LIMITS??"").split(",").map(Number);
  server.on("connection",socket=>{
   if(sockets.size>=8){rejected.add(socket);socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nRetry-After: 1\r\nConnection: close\r\n\r\n");return;}
   sockets.add(socket);
   const header=setTimeout(()=>socket.destroy(),Math.min(headersMs||10000,10000));headers.set(socket,header);
   const lifetime=setTimeout(()=>socket.destroy(),Math.min(lifetimeMs||230000,230000));lifetime.unref();
   socket.on("error",()=>socket.destroy());socket.once("close",()=>{sockets.delete(socket);clearTimeout(header);clearTimeout(lifetime);headers.delete(socket);});
  });
  server.on("request",req=>{const timer=headers.get(req.socket);if(timer)clearTimeout(timer);headers.delete(req.socket);});
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen({fd:0},()=>{server.removeListener("error",reject);server.on("error",()=>{server.closeAllConnections();server.close();});resolve();});});}
 else{
  const socket=new Socket({fd:0,readable:true,writable:true});
  socket.on("error",()=>socket.destroy());socket.on("close",()=>process.exit(0));socket.setTimeout(230000,()=>socket.destroy());
  // This process holds one of the launcher's helper slots (#1335). The server never
  // listens, so Node's headersTimeout is not enforced here: the first request's
  // headers get 10 s, and no connection outlives the longest forwarded request,
  // whatever its activity. The variable only shortens both for tests.
  const [headersMs,lifetimeMs]=(process.env.BASTRA_ASSISTANT_ADDRESS_TEST_LIMITS??"").split(",").map(Number);
  const headers=setTimeout(()=>socket.destroy(),Math.min(headersMs||10000,10000));setTimeout(()=>socket.destroy(),Math.min(lifetimeMs||230000,230000)).unref();
  server.once("request",()=>clearTimeout(headers));
  server.emit("connection",socket);socket.resume();
 }
 return server;
}
if(process.argv.includes("--assistant-address-inetd")){
 const arg=(key:string)=>process.argv[process.argv.indexOf(key)+1];
 void startAssistantSocket({settingsPath:arg("--settings-path"),hostsPath:arg("--hosts-path"),daemonUrl:arg("--daemon-url")},process.env.BASTRA_ASSISTANT_ADDRESS_LISTEN==="1").catch(()=>{process.stderr.write("assistant address socket unavailable\n");process.exitCode=1;});
}
