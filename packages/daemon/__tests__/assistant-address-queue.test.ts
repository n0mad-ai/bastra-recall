import test from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse, Server } from "node:http";
import { Socket } from "node:net";
import { once } from "node:events";
import { startAssistantSocket, ASSISTANT_ACTIVE_REQUESTS } from "../src/assistant-address-gateway.js";

const ASSISTANT_MAX_PENDING_REQUESTS = 64;

// Exercise the inherited-listener request handler without launchd or an open
// listener. Hold account inspection so admission never depends on scheduling IO.
test("gateway bounds pipelined requests and immediately reclaims abandoned waiters", async (t) => {
  const originalListen = Server.prototype.listen;
  t.mock.method(Server.prototype, "listen", function (this: Server, ...args: any[]) {
    return args[0]?.fd === 0
      ? (originalListen as any).call(this, 0, "127.0.0.1", args[1])
      : (originalListen as any).apply(this, args);
  });
  const inspections: Array<(value: number | undefined) => void> = [];
  const server = await startAssistantSocket(
    {
      settingsPath: "/unused",
      hostsPath: "/unused",
      daemonUrl: "http://127.0.0.1:9",
      owner: "501",
      localAccount: { platform: "darwin", lookup: () => new Promise((resolve) => inspections.push(resolve)) },
    },
    true
  );
  t.mock.restoreAll();
  const sockets: Socket[] = [];
  t.after(async () => {
    inspections.forEach((resolve) => resolve(undefined));
    sockets.forEach((socket) => socket.destroy());
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const socket = () => {
    const s = new Socket();
    sockets.push(s);
    for (const [key, value] of Object.entries({
      localAddress: "127.0.0.1",
      remoteAddress: "127.0.0.1",
      localPort: 80,
      remotePort: sockets.length + 10000,
    })) {
      Object.defineProperty(s, key, { value });
    }
    return s;
  };
  const emit = (s: Socket) => {
    const req = new IncomingMessage(s);
    req.method = "GET";
    req.url = "/ui/";
    req.headers = { host: "jarvis.localhost" };
    const res = new ServerResponse(req);
    server.emit("request", req, res);
    return res;
  };
  const active = Array.from({ length: ASSISTANT_ACTIVE_REQUESTS }, () => emit(socket()));
  assert.equal(inspections.length, ASSISTANT_ACTIVE_REQUESTS);
  const pipeline = socket();
  const waiting = Array.from({ length: ASSISTANT_MAX_PENDING_REQUESTS - active.length }, () => emit(pipeline));
  assert.equal(pipeline.destroyed, false, "all 64 requests fit, including the active requests");
  assert.equal(inspections.length, active.length, "queued requests cannot enter account inspection");
  const overflow = socket();
  emit(overflow);
  assert.equal(overflow.destroyed, true, "a new socket cannot bypass the request bound");

  // Model response cancellation independently of socket cancellation here.
  // The real pipeline test below covers both on Node versions whose unbound
  // responses do not emit close when their socket closes (including22.22).
  pipeline.destroy();
  waiting.forEach((res) => res.emit("close"));
  const replacement = socket();
  const replacements = Array.from({ length: waiting.length }, () => emit(replacement));
  assert.equal(replacement.destroyed, false, "closed waiters immediately free every queue slot");
  emit(replacement);
  assert.equal(replacement.destroyed, true, "pipelining on one socket has the same bound");
  replacements.forEach((res) => res.emit("close"));

  const next = socket();
  emit(next);
  assert.equal(next.destroyed, false);
  active[0].emit("close");
  assert.equal(inspections.length, active.length + 1, "an active close releases its slot to the oldest live waiter");
});

test("gateway frees real pipelined requests when their socket disconnects", { timeout: 5000 }, async (t) => {
  const { connect } = await import("node:net");
  const originalListen = Server.prototype.listen;
  t.mock.method(Server.prototype, "listen", function (this: Server, ...args: any[]) {
    return args[0]?.fd === 0
      ? (originalListen as any).call(this, 0, "127.0.0.1", args[1])
      : (originalListen as any).apply(this, args);
  });
  const inspections: Array<(value: number | undefined) => void> = [];
  const server = await startAssistantSocket(
    {
      settingsPath: "/unused",
      hostsPath: "/unused",
      daemonUrl: "http://127.0.0.1:9",
      owner: "501",
      localAccount: { platform: "darwin", lookup: () => new Promise((resolve) => inspections.push(resolve)) },
    },
    true
  );
  t.mock.restoreAll();
  const clients: Socket[] = [];
  t.after(async () => {
    clients.forEach((socket) => socket.destroy());
    server.closeAllConnections();
    inspections.forEach((resolve) => resolve(undefined));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as { port: number }).port;
  const wave = async () => {
    let count = 0,
      accepted: Socket | undefined;
    const parsed = new Promise<void>((resolve) => {
      const observe = (req: IncomingMessage) => {
        accepted = req.socket;
        if (++count === ASSISTANT_MAX_PENDING_REQUESTS) {
          server.removeListener("request", observe);
          resolve();
        }
      };
      server.on("request", observe);
    });
    const client = connect(port, "127.0.0.1");
    clients.push(client);
    client.on("error", () => {});
    await once(client, "connect");
    client.write("GET /ui/ HTTP/1.1\r\nHost: jarvis.localhost\r\n\r\n".repeat(ASSISTANT_MAX_PENDING_REQUESTS));
    await parsed;
    assert.equal(accepted!.destroyed, false, "a full wave of 64 requests remains admitted");
    return { client, accepted: accepted! };
  };
  const first = await wave();
  const firstClosed = once(first.accepted, "close");
  first.client.destroy();
  await firstClosed;
  const afterDisconnect = inspections.length;
  const second = await wave();
  assert.ok(inspections.length > afterDisconnect, "disconnect also freed the active slots");
  const closed = once(second.accepted, "close");
  second.client.write("GET /ui/ HTTP/1.1\r\nHost: jarvis.localhost\r\n\r\n");
  await closed;
  assert.equal(second.accepted.destroyed, true, "the 65th pipelined request closes the overflowing socket");
});
