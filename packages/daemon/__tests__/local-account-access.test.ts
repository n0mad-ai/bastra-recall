import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createConnection, Socket } from "node:net";
import { createServer as createHttpServer, request } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseLsofPeerUid,
  createLocalAccountGuard,
  localAccountPath,
  vaultAccountUid,
  macosPeerUid,
  createPeerUidLookup,
} from "../src/local-account-access.js";
import { assistantGatewayHandler, startAssistantSocket } from "../src/assistant-address-gateway.js";
import { Server } from "node:http";
const socket = () =>
  ({
    localAddress: "127.0.0.1",
    localPort: 6723,
    remoteAddress: "127.0.0.1",
    remotePort: 55555,
    destroyed: false,
    once() {
      return this;
    },
  }) as unknown as Socket;
const row = (uid: number, name = "127.0.0.1:55555->127.0.0.1:6723", state = "ESTABLISHED") =>
  `p123\0u${uid}\0\nf4\0n${name}\0TST=${state}\0\n`;
test("UID comes only from exact reverse established endpoint; missing or ambiguous peers stay closed", () => {
  const s = socket();
  assert.equal(parseLsofPeerUid(row(501), s), 501);
  assert.equal(parseLsofPeerUid(row(501, "127.0.0.1:6723->127.0.0.1:55555"), s), undefined);
  assert.equal(parseLsofPeerUid(row(501, "127.0.0.1:55555->127.0.0.1:6724"), s), undefined);
  assert.equal(parseLsofPeerUid(row(501, undefined, "CLOSE_WAIT"), s), undefined);
  assert.equal(parseLsofPeerUid(row(501) + row(502), s), undefined);
  assert.equal(parseLsofPeerUid(row(501).replace("u501\0", ""), s), undefined);
  assert.equal(parseLsofPeerUid("", s), undefined);
  assert.equal(parseLsofPeerUid(row(501).replace("p123\0", ""), s), undefined);
  const v6 = { ...s, localAddress: "::1", remoteAddress: "::1" } as Socket;
  assert.equal(parseLsofPeerUid(row(501, "[::1]:55555->[::1]:6723"), v6), 501);
});
test("account decision ignores headers, binds live socket, caches only that connection and denies unknown ownership", async () => {
  let count = 0;
  const s = socket();
  const allow = createLocalAccountGuard(501, {
    platform: "darwin",
    lookup: async () => {
      count++;
      return 501;
    },
  });
  assert.equal(await allow(s), true);
  assert.equal(await allow(s), true);
  assert.equal(count, 1);
  assert.equal(await allow(socket()), true);
  assert.equal(count, 2);
  Object.defineProperty(s, "destroyed", { value: true });
  assert.equal(await allow(s), false);
  assert.equal(await createLocalAccountGuard(501, { platform: "darwin", lookup: async () => 502 })(socket()), false);
  assert.equal(
    await createLocalAccountGuard(501, { platform: "darwin", lookup: async () => undefined })(socket()),
    false
  );
  assert.equal(
    await createLocalAccountGuard(undefined, { platform: "darwin", lookup: async () => 501 })(socket()),
    false
  );
});
test("UI/task app routes and normalized aliases are guarded; ordinary hook/recall path is unchanged", () => {
  for (const path of ["/ui", "/ui/tasks", "/api/v1/task_list", "/api/v1/tasks/stream", "/api/v1/a/../task_list"])
    assert.equal(localAccountPath(path), true, path);
  for (const path of ["/hook/prompt", "/hook/recall", "/api/v1/recall", "/api/v1/mcp", "/health"])
    assert.equal(localAccountPath(path), false, path);
});
test("vault owner is stat UID with matching daemon euid; unknown/mismatched vault remains closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-owner-"));
  try {
    const uid = process.geteuid?.() ?? 0;
    assert.equal(await vaultAccountUid(root, { platform: "darwin", euid: () => uid }), uid);
    assert.equal(await vaultAccountUid(root, { platform: "darwin", euid: () => uid + 1 }), undefined);
    assert.equal(await vaultAccountUid(join(root, "absent"), { platform: "darwin", euid: () => uid }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test(
  "macOS system lookup identifies real IPv4 and IPv6 fixture peers without another account",
  { skip: process.platform !== "darwin" },
  async () => {
    for (const host of ["127.0.0.1", "::1"]) {
      let accepted: Socket | undefined, client: Socket | undefined;
      const server = createServer((s) => (accepted = s));
      try {
        await new Promise<void>((r, j) => {
          server.once("error", j);
          server.listen(0, host, r);
        });
        const incoming = new Promise<void>((r) => server.once("connection", () => r()));
        client = createConnection({ host, port: (server.address() as any).port });
        await new Promise<void>((r, j) => {
          client!.once("error", j);
          client!.once("connect", r);
        });
        await incoming;
        assert.equal(await macosPeerUid(accepted!), process.geteuid!());
      } finally {
        client?.destroy();
        accepted?.destroy();
        await new Promise<void>((r) => server.close(() => r()));
      }
    }
  }
);
test("gateway rejects foreign browser account before forwarding, even with owner-looking headers", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "account-gateway-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settingsPath = join(dir, "settings.json"),
    hostsPath = join(dir, "hosts");
  await writeFile(settingsPath, JSON.stringify({ ui: { enabled: true }, assistant: { name: "jarvis" } }));
  await writeFile(hostsPath, "");
  let forwarded = 0;
  const upstream = createHttpServer((q, r) => {
    forwarded++;
    r.end("owner page");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const gateway = createHttpServer(
    assistantGatewayHandler({
      settingsPath,
      hostsPath,
      daemonUrl: `http://127.0.0.1:${(upstream.address() as any).port}`,
      owner: "501",
      localAccount: { platform: "darwin", lookup: async () => 502 },
    })
  );
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const q = request(
        {
          host: "127.0.0.1",
          port: (gateway.address() as any).port,
          path: "/ui/",
          headers: { Host: "jarvis.localhost", "x-bastra-owner": "501", Cookie: "uid=501" },
        },
        (r) => {
          r.resume();
          r.once("end", () => resolve(r.statusCode!));
        }
      );
      q.once("error", reject);
      q.end();
    });
    assert.equal(status, 403);
    assert.equal(forwarded, 0);
  } finally {
    gateway.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => gateway.close(() => r())),
      new Promise<void>((r) => upstream.close(() => r())),
    ]);
  }
});

const peer = (remotePort: number) => ({ ...socket(), remotePort }) as unknown as Socket;
const rows = (ports: number[], uid = 501) => ports.map((p) => row(uid, `127.0.0.1:${p}->127.0.0.1:6723`)).join("");
test("burst: concurrent sockets of one account share fresh scans; none is answered by a scan that started before it", async () => {
  let scans = 0;
  const started: Array<(text: string) => void> = [];
  const lookup = createPeerUidLookup(() => {
    scans++;
    return new Promise((r) => started.push(r));
  });
  const first = Array.from({ length: 12 }, (_, i) => lookup(peer(50000 + i)));
  await new Promise((r) => setImmediate(r));
  assert.equal(scans, 1, "twelve waiting sockets need one scan");
  // A socket arriving while that scan runs must wait for the next scan, even
  // though the running scan would list it.
  const late = lookup(peer(50100));
  started[0](rows([...Array.from({ length: 12 }, (_, i) => 50000 + i), 50100]));
  assert.deepEqual(await Promise.all(first), Array(12).fill(501));
  await new Promise((r) => setImmediate(r));
  assert.equal(scans, 2);
  started[1](rows([50100]));
  assert.equal(await late, 501);
});
test("burst: timeout or failure is retried once and then stays closed; a foreign account is rejected at once", async () => {
  let calls = 0;
  const flaky = createPeerUidLookup(async () => {
    if (++calls === 1) throw Object.assign(Error("timeout"), { killed: true, signal: "SIGTERM" });
    return rows([55555]);
  });
  assert.equal(await flaky(peer(55555)), 501);
  assert.equal(calls, 2);
  calls = 0;
  const failing = createPeerUidLookup(async () => {
    calls++;
    throw Error("lsof timeout");
  });
  assert.equal(await failing(peer(55555)), undefined);
  assert.equal(calls, 2);
  calls = 0;
  const empty = createPeerUidLookup(async () => {
    calls++;
    return "";
  });
  assert.equal(await empty(peer(55555)), undefined);
  assert.equal(calls, 2);
  calls = 0;
  const foreign = createPeerUidLookup(async () => {
    calls++;
    return rows([55555], 502);
  });
  assert.equal(await foreign(peer(55555)), 502);
  assert.equal(calls, 1);
  const guard = createLocalAccountGuard(501, {
    platform: "darwin",
    lookup: createPeerUidLookup(async () => {
      throw Error("lsof timeout");
    }),
  });
  assert.equal(await guard(peer(55555)), false);
  assert.equal(await createLocalAccountGuard(501, { platform: "darwin", lookup: foreign })(peer(55556)), false);
});
async function burstGateway(
  t: test.TestContext,
  localAccount: Parameters<typeof assistantGatewayHandler>[0]["localAccount"]
) {
  const dir = await mkdtemp(join(tmpdir(), "account-burst-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settingsPath = join(dir, "settings.json"),
    hostsPath = join(dir, "hosts");
  await writeFile(settingsPath, JSON.stringify({ ui: { enabled: true }, assistant: { name: "jarvis" } }));
  await writeFile(hostsPath, "");
  const counter = { forwarded: 0 };
  const upstream = createHttpServer((q, r) => {
    counter.forwarded++;
    setTimeout(() => r.end("owner page"), 20);
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => {
    upstream.closeAllConnections();
    return new Promise<void>((r) => upstream.close(() => r()));
  });
  const originalListen = Server.prototype.listen;
  t.mock.method(Server.prototype, "listen", function (this: Server, ...args: any[]) {
    return args[0]?.fd === 0
      ? (originalListen as any).call(this, 0, "127.0.0.1", args[1])
      : (originalListen as any).apply(this, args);
  });
  const server = await startAssistantSocket(
    {
      settingsPath,
      hostsPath,
      daemonUrl: `http://127.0.0.1:${(upstream.address() as any).port}`,
      owner: String(process.geteuid?.() ?? 501),
      localAccount,
    },
    true
  );
  t.mock.restoreAll();
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });
  const port = (server.address() as any).port;
  const burst = (n: number) =>
    Promise.all(
      Array.from(
        { length: n },
        (_, i) =>
          new Promise<number>((resolve, reject) => {
            const q = request(
              {
                host: "127.0.0.1",
                port,
                path: `/ui/v22/asset-${i}.js`,
                agent: false,
                headers: { Host: "jarvis.localhost" },
              },
              (r) => {
                r.resume();
                r.once("end", () => resolve(r.statusCode!));
              }
            );
            q.once("error", reject);
            q.end();
          })
      )
    );
  return { burst, counter };
}
test(
  "burst: 24 parallel connections of the vault account through the real listener and real lsof all pass",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { burst, counter } = await burstGateway(t, { platform: "darwin" });
    assert.deepEqual(await burst(24), Array(24).fill(200));
    assert.equal(counter.forwarded, 24);
  }
);
test("burst: a foreign account and a failing check stay at 403 under load and are never forwarded", async (t) => {
  for (const lookup of [
    async () => (process.geteuid?.() ?? 501) + 1,
    async () => {
      throw Error("lsof timeout");
    },
    async () => undefined,
  ]) {
    const { burst, counter } = await burstGateway(t, { platform: "darwin", lookup });
    assert.deepEqual(await burst(12), Array(12).fill(403));
    assert.equal(counter.forwarded, 0);
  }
});

import { mkdir, stat } from "node:fs/promises";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
import { mintTaskCredential } from "../src/task-auth.js";

test("real HTTP account boundary covers UI, task app, hook cards and REST projections before private state", async () => {
  const root = await mkdtemp(join(tmpdir(), "http-vault-account-")),
    vaultPath = join(root, "vault");
  await mkdir(vaultPath);
  const previous = { BASTRA_TASKS: process.env.BASTRA_TASKS, BASTRA_TASKS_PATH: process.env.BASTRA_TASKS_PATH };
  process.env.BASTRA_TASKS = "1";
  process.env.BASTRA_TASKS_PATH = join(root, "tasks.json");
  const credential = await mintTaskCredential(join(root, "task-auth.json"), {
    actor_id: "fixture",
    domains: ["personal"],
    role: "agent",
  });
  const vault = new Vault(vaultPath);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const owner = (await stat(vaultPath)).uid;
  let peer = owner + 1,
    lookups = 0;
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "fixture",
    toolDeps: { vault, search, telemetry, vaultPath },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
    localAccount: {
      platform: "darwin",
      euid: () => owner,
      lookup: async () => {
        lookups++;
        return peer;
      },
    },
  });
  const base = `http://127.0.0.1:${handle.port}`,
    headers = { "x-bastra-task-authorization": `Bearer ${credential.token}`, Connection: "close" };
  try {
    assert.equal((await fetch(base + "/health")).status, 200);
    assert.equal(lookups, 0);
    assert.equal((await fetch(base + "/api/v1/health")).status, 200);
    assert.equal(lookups, 0);
    for (const authorization of [undefined, "Bearer invalid-fixture-token"]) {
      const publicResponse = await fetch(base + "/api/v1/health", {
        headers: { Connection: "close", ...(authorization ? { "x-bastra-task-authorization": authorization } : {}) },
      });
      assert.equal(publicResponse.status, 200);
      assert.equal(((await publicResponse.json()) as Record<string, unknown>).proactive_due, undefined);
      assert.equal(lookups, 0);
    }
    const ordinary = await fetch(base + "/hook/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "fixture", k: 1, lexical_only: true }),
    });
    assert.equal(ordinary.status, 200);
    await ordinary.text();
    assert.equal(lookups, 0);
    for (const route of ["/ui/health", "/api/v1/tasks", "/api/v1/tasks/stream", "/api/v1/task_list"]) {
      const response = await fetch(base + route, {
        headers: {
          ...headers,
          Authorization: `Bearer ${credential.token}`,
          "x-bastra-uid": String(owner),
          Cookie: `uid=${owner}`,
        },
      });
      assert.equal(response.status, 403, route);
      await response.text();
    }
    for (const route of ["/hook/session-context", "/api/v1/health"]) {
      const response = await fetch(base + route, { headers });
      assert.equal(response.status, 403, route);
      await response.text();
    }
    const prompt = await fetch(base + "/hook/prompt", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { session_id: "fixture", prompt: "fixture" } }),
    });
    assert.equal(prompt.status, 403);
    await prompt.text();
    await assert.rejects(() => stat(process.env.BASTRA_TASKS_PATH!), { code: "ENOENT" });
    peer = owner;
    const response = await fetch(base + "/ui/health", { headers: { Connection: "close" } });
    assert.equal(response.status, 200);
    await response.text();
    const ownTasks = await fetch(base + "/api/v1/tasks", {
      headers: { Authorization: `Bearer ${credential.token}`, Connection: "close" },
    });
    assert.equal(ownTasks.status, 200);
    await ownTasks.text();
    const origin = await fetch(base + "/ui/tasks/session", {
      method: "POST",
      headers: { Origin: "https://foreign.invalid", "Content-Type": "application/json", Connection: "close" },
      body: "{}",
    });
    assert.equal(origin.status, 403);
    await origin.text();
    const forwarded = await fetch(base + "/ui/health", { headers: { Forwarded: "", Connection: "close" } });
    assert.equal(forwarded.status, 401);
    await forwarded.text();
  } finally {
    await handle.close();
    search.stop();
    await vault.stop();
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    await rm(root, { recursive: true, force: true });
  }
});
