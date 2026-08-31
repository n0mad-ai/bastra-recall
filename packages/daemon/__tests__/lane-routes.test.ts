/**
 * The three lane routes added in #369: POST /hook/stop, /hook/session,
 * /hook/todo.
 *
 * What matters here is the CONTRACT the thin client and the compiled stub
 * depend on, not the pipelines behind it (those have their own tests): the
 * response body is the exact stdout document, the status is always 200, and a
 * broken request degrades to `{}` instead of an error the client would only
 * translate back into `{}` anyway.
 *
 * dispatchLaneRoutes is mounted on a bare server, so no vault, no search index
 * and no daemon boot are involved. The lanes' own loopback self-calls land on
 * this same server, which answers 404 — every one of them is best-effort, so
 * that is a legitimate "daemon has nothing to add" answer.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/lane-routes.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { dispatchLaneRoutes } from "../src/http-lane-routes.js";

interface Reply {
  status: number;
  body: string;
  contentType: string | undefined;
}

async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    if (dispatchLaneRoutes(req, res, req.method ?? "GET", url)) return;
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
}

function post(port: number, path: string, raw: string): Promise<Reply> {
  return new Promise((ok, ko) => {
    const req = request(
      { method: "POST", hostname: "127.0.0.1", port, path, headers: { "Content-Type": "application/json" } },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () =>
          ok({
            status: res.statusCode ?? 0,
            body,
            contentType: res.headers["content-type"],
          }),
        );
      },
    );
    req.on("error", ko);
    req.end(raw);
  });
}

/** Telemetry off for the whole file — these cases assert transport, not events. */
const telemetryBefore = process.env.BASTRA_TELEMETRY;
process.env.BASTRA_TELEMETRY = "off";
process.on("exit", () => {
  if (telemetryBefore === undefined) delete process.env.BASTRA_TELEMETRY;
  else process.env.BASTRA_TELEMETRY = telemetryBefore;
});

test("each lane answers 200 + `{}` when its event gate rejects the payload", async () => {
  await withServer(async (port) => {
    const cases: Array<[string, object]> = [
      ["/hook/stop", { hook_event_name: "PreToolUse" }],
      ["/hook/session", { hook_event_name: "Stop" }],
      ["/hook/todo", { hook_event_name: "PreToolUse", tool_name: "Write" }],
    ];
    for (const [path, payload] of cases) {
      const r = await post(port, path, JSON.stringify({ payload }));
      assert.equal(r.status, 200, path);
      assert.equal(r.body, "{}", path);
      assert.match(r.contentType ?? "", /application\/json/, path);
    }
  });
});

test("a malformed body still yields 200 + `{}` — the client must never see an error", async () => {
  await withServer(async (port) => {
    for (const path of ["/hook/stop", "/hook/session", "/hook/todo"]) {
      const r = await post(port, path, "{ not json");
      assert.equal(r.status, 200, path);
      assert.equal(r.body, "{}", path);
    }
  });
});

test("a missing `payload` key is an empty payload, not a crash", async () => {
  await withServer(async (port) => {
    for (const path of ["/hook/stop", "/hook/session", "/hook/todo"]) {
      const r = await post(port, path, "{}");
      assert.equal(r.status, 200, path);
      assert.equal(r.body, "{}", path);
    }
  });
});

test("the dispatcher claims only its three POST routes", () => {
  const seen: string[] = [];
  const fakeRes = {
    writeHead: () => undefined,
    end: () => undefined,
  } as unknown as Parameters<typeof dispatchLaneRoutes>[1];
  const fakeReq = {
    on: (ev: string, cb: (...a: unknown[]) => void) => {
      // readJsonBody subscribes; feed it an empty body so nothing hangs.
      if (ev === "end") cb();
      return fakeReq;
    },
    socket: { localPort: 6723 },
  } as unknown as Parameters<typeof dispatchLaneRoutes>[0];

  for (const [method, url, expected] of [
    ["POST", "/hook/stop", true],
    ["POST", "/hook/session", true],
    ["POST", "/hook/todo", true],
    ["GET", "/hook/stop", false],
    ["POST", "/hook/recall", false],
    ["POST", "/hook/stopped", false],
  ] as Array<[string, string, boolean]>) {
    seen.push(`${method} ${url}`);
    assert.equal(dispatchLaneRoutes(fakeReq, fakeRes, method, url), expected, `${method} ${url}`);
  }
  assert.equal(seen.length, 6);
});
