/**
 * GET /api/v1/health — Erreichbarkeit für einen BROWSER.
 *
 * Hintergrund: bastra.ios Admin-Bridge prüfte die Erreichbarkeit mit einem
 * echten `recall("health", k=1)` im Minutentakt — volle Vektorsuche (~1,2s) für
 * zwei Booleans, und seit #221 zusätzlich eine "read"-Notice, die in der Map als
 * Aktivität aufblitzt. 21.972 solcher Proben lagen im Telemetrie-Log.
 *
 * /health selbst kann der Browser nicht lesen: CORS-Header gehen nur an
 * /api/v1/* (bewusst — alles Token-freie bleibt same-machine). Also dieselbe
 * Antwort hinter Token+CORS.
 *
 * Runner: `tsx --test __tests__/http-api-health.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";

const TOKEN = "test-token-abcdef0123456789";

// Token und CORS-Allowlist kommen aus der Umgebung (BASTRA_API_TOKEN /
// BASTRA_CORS_ORIGIN), nicht aus den Server-Optionen — hier gesetzt, damit der
// Test die Browser-Situation von bastra.io nachstellt.
process.env.BASTRA_API_TOKEN = TOKEN;
process.env.BASTRA_CORS_ORIGIN = "https://bastra.io";

function memoryMarkdown(id: string, title: string): string {
  const ts = new Date().toISOString();
  return [
    "---", `id: ${id}`, `title: ${title}`, "type: reference", `summary: ${title}`,
    "topic_path:", "  - test", "tags:", "  - test", "scope: health-test",
    "recall_when:", `  - ${title}`, `created: ${ts}`, `updated: ${ts}`, "---",
    "", `Body for ${title}.`, "",
  ].join("\n");
}

interface Reply {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function httpReq(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function withServer(
  fn: (port: number, activity: () => number) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-apihealth-"));
  await writeFile(join(dir, "alpha.md"), memoryMarkdown("alpha", "alpha bravo"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  let activityCount = 0;
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test-version",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    onActivity: () => {
      activityCount += 1;
    },
    embedding: { on: false, providerId: null, source: "none" },
    origin: { startedBy: "direct", envOrigin: "own", configFingerprint: "0123456789ab" },
  });
  try {
    await fn(handle.port!, () => activityCount);
  } finally {
    search.stop();
    await vault.stop?.();
    await handle.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("api health: answers a token-carrying browser with reachability + vault size", async () => {
  await withServer(async (port) => {
    const res = await httpReq(port, "GET", "/api/v1/health", {
      Authorization: `Bearer ${TOKEN}`,
      Origin: "https://bastra.io",
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body) as { ok: boolean; vault_size: number; version: string };
    assert.equal(body.ok, true);
    assert.equal(body.vault_size, 1, "the bridge shows this number as the vault size");
    assert.equal(body.version, "test-version");
    assert.equal(
      res.headers["access-control-allow-origin"],
      "https://bastra.io",
      "without this header the browser cannot read the answer at all",
    );
  });
});

test("api health: same payload as /health — one shape, two doors", async () => {
  await withServer(async (port) => {
    const open = await httpReq(port, "GET", "/health");
    const api = await httpReq(port, "GET", "/api/v1/health", {
      Authorization: `Bearer ${TOKEN}`,
    });
    const a = JSON.parse(api.body) as Record<string, unknown>;
    const o = JSON.parse(open.body) as Record<string, unknown>;
    // uptime_seconds is read at request time, so two calls a moment apart may
    // legitimately differ by one second. Compare it as a field that exists on
    // both doors, and the rest byte for byte.
    assert.deepEqual(Object.keys(a).sort(), Object.keys(o).sort());
    assert.equal(typeof a.uptime_seconds, "number");
    assert.equal(typeof o.uptime_seconds, "number");
    delete a.uptime_seconds;
    delete o.uptime_seconds;
    assert.deepEqual(a, o);
    // #684 / #719: who started the daemon and its config fingerprint, on both.
    assert.equal(o.started_by, "direct");
    assert.equal(o.env_origin, "own");
    assert.equal(o.config_fingerprint, "0123456789ab");
  });
});

test("health: reports how long this daemon has been up (#22)", async () => {
  await withServer(async (port) => {
    const res = await httpReq(port, "GET", "/health");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body) as { uptime_seconds: number; started_at: string };

    assert.equal(typeof body.uptime_seconds, "number");
    assert.ok(body.uptime_seconds >= 0, "a fresh daemon is not negative seconds old");
    assert.ok(body.uptime_seconds < 60, "a test server did not just run for a minute");

    // started_at must be a real ISO timestamp, and the two fields must agree:
    // the point is a supervisor being able to spot a restart, so a started_at
    // that drifts from uptime_seconds would defeat the whole feature.
    const started = Date.parse(body.started_at);
    assert.ok(!Number.isNaN(started), `started_at is not parseable: ${body.started_at}`);
    const derived = (Date.now() - started) / 1000;
    assert.ok(
      Math.abs(derived - body.uptime_seconds) < 2,
      `started_at (${derived}s ago) and uptime_seconds (${body.uptime_seconds}) disagree`,
    );
  });
});

test("api health: needs the token, like every other /api/v1 route", async () => {
  await withServer(async (port) => {
    const res = await httpReq(port, "GET", "/api/v1/health", { Origin: "https://bastra.io" });
    assert.equal(res.status, 401);
  });
});

test("api health: a probe must not keep the daemon awake", async () => {
  await withServer(async (port, activity) => {
    await httpReq(port, "GET", "/api/v1/health", { Authorization: `Bearer ${TOKEN}` });
    assert.equal(activity(), 0, "a liveness probe is not work — else idle shutdown never fires");
    // the contrast: a real call does count
    await httpReq(port, "GET", "/api/v1/graph", { Authorization: `Bearer ${TOKEN}` });
    assert.equal(activity(), 1);
  });
});
