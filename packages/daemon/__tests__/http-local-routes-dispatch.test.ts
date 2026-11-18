/**
 * #1529: characterization of the loopback route dispatch, recorded against the
 * branch chain before it became a route table. Every route of
 * `dispatchLocalRoutes` is called through a real HTTP server with its method,
 * a wrong method, unknown paths, and a missing or invalid body; the snapshot
 * holds whether the dispatcher took the request, the status, the response
 * headers and the body bytes. Only volatile header values are left out.
 *
 * Update (only for an intended behaviour change):
 *   node --import tsx --import ./scripts/test-env.mjs --test --test-update-snapshots \
 *     packages/daemon/__tests__/http-local-routes-dispatch.test.ts
 */
import test from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchIndex, Vault } from "@bastra-recall/core";
import { dispatchLocalRoutes, type LocalRouteCtx } from "../src/http-local-routes.js";
import { Telemetry } from "../src/telemetry.js";
import type { RepoStatus } from "../src/code-graph/refresh.js";
import { filterToolDefsForSurface, servedToolDefs, toolSurfaceFrom } from "../src/tool-defs.js";

const UNHANDLED = 599;

interface Answer {
  handled: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Headers whose values depend on the clock or the socket, not on the route. */
const VOLATILE = new Set(["date", "connection", "keep-alive"]);

async function withServer(ctx: LocalRouteCtx, fn: (port: number) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    const handled = dispatchLocalRoutes(req, res, req.method ?? "GET", req.url ?? "", Date.now(), ctx);
    if (handled) return;
    req.resume();
    res.writeHead(UNHANDLED).end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  }
}

function call(port: number, method: string, path: string, body?: string): Promise<Answer> {
  return new Promise((ok, ko) => {
    const req = request(
      {
        method,
        hostname: "127.0.0.1",
        port,
        path,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) if (!VOLATILE.has(key)) headers[key] = String(value);
          ok({
            handled: res.statusCode !== UNHANDLED,
            status: res.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", ko);
    req.end(body);
  });
}

const INVALID = "{not json";

/** Every route of the dispatcher, plus its wrong-method and near-miss neighbours. */
const CASES: Array<[method: string, path: string, body?: string]> = [
  ["GET", "/nope"],
  ["POST", "/nope"],
  ["GET", "/"],
  ["GET", "/health"],
  ["POST", "/health"],
  ["GET", "/health?x=1"],
  ["GET", "/tools"],
  ["GET", "/tools?surface=search"],
  ["GET", "/tools?surface=write"],
  ["GET", "/tools?surface=unknown"],
  ["GET", "/toolsx"],
  ["POST", "/tools"],
  ["GET", "/vault/count"],
  ["POST", "/vault/count"],
  ["POST", "/hook/action-conventions", INVALID],
  ["POST", "/hook/action-conventions", "{}"],
  ["POST", "/hook/action-conventions", JSON.stringify({ category: "github-issues-prs" })],
  ["GET", "/hook/action-conventions"],
  ["POST", "/hook/recall", INVALID],
  ["GET", "/hook/recall"],
  ["POST", "/hook/reflex", INVALID],
  ["GET", "/hook/reflex"],
  ["POST", "/hook/prompt", INVALID],
  ["POST", "/hook/prompt"],
  ["GET", "/hook/prompt"],
  ["POST", "/hook/write", INVALID],
  ["POST", "/hook/write"],
  ["GET", "/hook/write"],
  ["POST", "/hook/bash-pre", INVALID],
  ["GET", "/hook/bash-pre"],
  ["POST", "/hook/bash-fail", INVALID],
  ["GET", "/hook/bash-fail"],
  ["POST", "/hook/stop", INVALID],
  ["GET", "/hook/stop"],
  ["POST", "/hook/session", INVALID],
  ["GET", "/hook/session"],
  ["POST", "/hook/todo", INVALID],
  ["GET", "/hook/todo"],
  ["POST", "/hook/gate", INVALID],
  ["GET", "/hook/gate"],
  ["POST", "/hook/act", INVALID],
  ["GET", "/hook/act"],
  ["POST", "/hook/hinted", INVALID],
  ["POST", "/hook/hinted", JSON.stringify({ ids: ["missing", 3] })],
  ["GET", "/hook/hinted"],
  ["GET", "/curator/state"],
  ["POST", "/curator/state"],
  ["GET", "/curator/run"],
  ["POST", "/curator/run", JSON.stringify({ dryRun: true, force: false })],
  ["GET", "/code/refresh"],
  ["POST", "/code/refresh", INVALID],
  ["POST", "/code/refresh", "{}"],
  ["POST", "/code/refresh", JSON.stringify({ repo: "/elsewhere" })],
  ["POST", "/code/refresh", JSON.stringify({ repo: "/repo" })],
  ["PUT", "/code/refresh"],
  ["DELETE", "/code/refresh"],
  ["GET", "/code/refresh?x=1"],
  ["GET", "/hook/taxonomy"],
  ["POST", "/hook/taxonomy"],
  ["GET", "/hook/drift"],
  ["POST", "/hook/drift"],
  ["GET", "/hook/care"],
  ["POST", "/hook/care"],
  ["GET", "/hook/floors"],
  ["GET", "/hook/floors?scope=fixture"],
  ["GET", "/hook/floorsx"],
  ["POST", "/hook/floors"],
  ["GET", "/settings/docs"],
  ["POST", "/settings/docs", INVALID],
  ["POST", "/settings/docs", JSON.stringify({ mode: "nope" })],
  ["POST", "/settings/docs", JSON.stringify({ language: "not a tag!" })],
  ["POST", "/settings/docs", "{}"],
  ["PUT", "/settings/docs"],
  ["DELETE", "/settings/docs"],
  ["GET", "/settings/docs?x=1"],
];

const REPO: RepoStatus = {
  repoRoot: "/repo",
  state: "idle",
  pending: false,
  failures: 0,
  lastError: null,
  givenUp: false,
  lastReason: null,
  builds: 0,
  nextAttemptAt: null,
};

test("#1529: every loopback route answers as recorded before the route table", async (t) => {
  assert.ok(process.env.BASTRA_TEST_RUN_ROOT, "requires the isolated test profile");
  const root = await mkdtemp(join(tmpdir(), "local-routes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultDir = join(root, "vault");
  await mkdir(vaultDir);
  const vault = new Vault(vaultDir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  t.after(async () => {
    search.stop();
    await vault.stop?.();
  });
  const telemetry = new Telemetry();
  const enqueued: string[] = [];
  const base = {
    vault,
    telemetry,
    toolDeps: { vault, search, telemetry, vaultPath: vaultDir },
    healthPayload: () => ({ ok: true, fixture: "health" }),
    documentWriteEnabled: false,
  } as unknown as LocalRouteCtx;
  const full: LocalRouteCtx = {
    ...base,
    curator: { vaultRoot: vaultDir, vault, setDemotions: () => {} },
    codeRefresh: {
      status: () => [REPO],
      enqueue: (repo) => enqueued.push(repo),
      allows: (repo) => repo === "/repo",
    },
  };

  const record: Record<string, Answer> = {};
  for (const [label, ctx] of [
    ["bare", base],
    ["full", full],
  ] as const) {
    await withServer(ctx, async (port) => {
      for (const [method, path, body] of CASES) {
        const key = `${label} ${method} ${path}${body === undefined ? "" : ` ${body}`}`;
        const answer = await call(port, method, path, body);
        // The tool list is its own guarded catalogue (#1462); pin that the route
        // serves exactly it for the surface, not its text.
        if (answer.handled && path.startsWith("/tools")) {
          const surface = toolSurfaceFrom(new URL(path, "http://127.0.0.1").searchParams.get("surface") ?? undefined);
          assert.equal(
            answer.body,
            JSON.stringify({ tools: filterToolDefsForSurface(servedToolDefs(false), surface) })
          );
          answer.body = `<served tool definitions, surface ${surface}>`;
          delete answer.headers["content-length"];
        }
        record[key] = answer;
      }
    });
  }
  assert.deepEqual(enqueued, ["/repo"]);
  t.assert.snapshot(record);
});
