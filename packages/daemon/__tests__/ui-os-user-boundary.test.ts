/**
 * #1198 — the tokenless UI and the Tasks session belong to the OS user that
 * owns the daemon. A caller that cannot read the owner's 0600 UI secret (the
 * stand-in for another OS user) or a local proxy that rewrites Host to
 * localhost must not obtain a /ui response or a Tasks session.
 */
import "./tasks-opt-in.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { connect } from "node:net";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
import { settingsFilePath } from "../src/settings.js";
import { ensureLocalTaskAgent } from "../src/task-auto-setup.js";

async function daemon(t: test.TestContext) {
  assert.ok(process.env.BASTRA_TEST_RUN_ROOT, "requires isolated test profile");
  const root = await mkdtemp(join(tmpdir(), "ui-boundary-"));
  const previousTasks = process.env.BASTRA_TASKS_PATH;
  process.env.BASTRA_TASKS_PATH = join(root, "tasks.json");
  const settingsPath = settingsFilePath();
  await mkdir(join(settingsPath, ".."), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ ui: { enabled: true } }));
  await ensureLocalTaskAgent();
  const vaultDir = join(root, "vault"); await mkdir(vaultDir);
  const vault = new Vault(vaultDir); await vault.init();
  const search = new SearchIndex(vault); search.start();
  const telemetry = new Telemetry();
  const handle = await startHttpServer({ port: 0, vault, search, telemetry, version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: vaultDir }, documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" } });
  t.after(async () => {
    await handle.close(); search.stop(); await vault.stop?.();
    await writeFile(settingsPath, JSON.stringify({ ui: { enabled: false } }));
    if (previousTasks === undefined) delete process.env.BASTRA_TASKS_PATH; else process.env.BASTRA_TASKS_PATH = previousTasks;
    await rm(root, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${handle.port}`;
}

const raw = (base: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    // Options form: the path goes on the wire unnormalized (a URL string would resolve "..").
    const r = request({ hostname: "127.0.0.1", port: new URL(base).port, path, method: opts.method ?? "GET", headers: opts.headers }, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", c => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    r.on("error", reject); r.end(opts.body);
  });
const json = { "Content-Type": "application/json" };

test("#1198: a loopback caller without the owner's UI secret gets neither /ui nor a Tasks session", async t => {
  const base = await daemon(t);
  // Another OS user: same loopback socket, same localhost Host, no access to the secret.
  assert.equal((await raw(base, "/ui/annotations")).status, 401);
  assert.equal((await raw(base, "/ui/tasks/session", { method: "POST", headers: json, body: "{}" })).status, 401);
  assert.equal((await raw(base, "/ui/areas", { method: "POST", headers: json, body: "{}" })).status, 401);
  // A local proxy/tunnel that rewrites Host to localhost and forwards a foreign client.
  const proxied = { Host: "localhost", "X-Forwarded-For": "203.0.113.7", "X-Forwarded-Host": "tunnel.example" };
  assert.equal((await raw(base, "/ui/annotations", { headers: proxied })).status, 401);
  assert.equal((await raw(base, "/ui/tasks/session", { method: "POST", headers: { ...json, ...proxied }, body: "{}" })).status, 401);
  // Prefix routes cannot be reached through a path that normalizes away from /ui.
  assert.equal((await raw(base, "/ui/search/../../?q=fixture")).status, 401);
  // A guessed code or secret is no way in either.
  assert.equal((await raw(base, `/ui/annotations?bastra_ui_code=${"A".repeat(43)}`)).status, 401);
  assert.equal((await raw(base, "/ui/bootstrap", { method: "POST", headers: { ...json, "x-bastra-ui-secret": "B".repeat(43) }, body: "{}" })).status, 401);
  // Liveness stays open, like /health.
  assert.equal((await raw(base, "/ui/health")).status, 200);
});

test("#1198: the owner reaches /ui and the Tasks session without typing a token", async t => {
  const base = await daemon(t);
  const { ensureUiSecret, uiSecretPath, withUiCode } = await import("../src/ui-access.js");
  const secret = ensureUiSecret()!;
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  // What `bastra ui` does: a one-time code in the opened URL, exchanged for the cookie.
  const link = new URL(await withUiCode(`${base}/ui/annotations`, base));
  const code = link.searchParams.get("bastra_ui_code");
  assert.ok(code, "a code was issued");
  const exchanged = await raw(base, link.pathname + link.search);
  assert.equal(exchanged.status, 303);
  assert.equal(exchanged.headers.location, "/ui/annotations", "the code never stays in the URL");
  const setCookie = String(exchanged.headers["set-cookie"]);
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/); assert.match(setCookie, /Path=\/ui/);
  const cookie = setCookie.split(";")[0];
  assert.equal((await raw(base, link.pathname + link.search)).status, 401, "a code is single-use");
  assert.equal((await raw(base, "/ui/annotations", { headers: { Cookie: cookie } })).status, 200);
  const session = await raw(base, "/ui/tasks/session", { method: "POST", headers: { ...json, Cookie: cookie }, body: "{}" });
  assert.equal(session.status, 200, session.body);
  assert.equal(JSON.parse(session.body).role, "agent");
  // A secret readable by others is not a per-user secret: refused, never repaired silently.
  if (process.platform !== "win32") {
    await chmod(uiSecretPath(), 0o644);
    try {
      assert.equal((await raw(base, "/ui/annotations", { headers: { Cookie: cookie } })).status, 401);
    } finally { await chmod(uiSecretPath(), 0o600); }
  }
});

test("#1198 review: the secret only ever travels to a loopback daemon", async () => {
  const { withUiCode } = await import("../src/ui-access.js");
  const original = globalThis.fetch; const sent: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => { sent.push(String(input)); throw new Error("no network in this test"); }) as typeof fetch;
  try {
    for (const base of ["http://192.0.2.10:6723", "https://daemon.example", "http://127.0.0.1.example:6723"]) {
      assert.equal(await withUiCode(`${base}/ui`, base), `${base}/ui`);
    }
    assert.deepEqual(sent, [], "a non-loopback BASTRA_DAEMON_URL never receives the UI secret");
  } finally { globalThis.fetch = original; }
});

test("#1198 review: sessions are distinct per sign-in; refresh needs the owner; malformed targets are refused", async t => {
  const base = await daemon(t);
  const { ensureUiSecret, withUiCode } = await import("../src/ui-access.js");
  const secret = ensureUiSecret()!;
  const signIn = async () => {
    const link = new URL(await withUiCode(`${base}/ui/annotations`, base));
    return String((await raw(base, link.pathname + link.search)).headers["set-cookie"]).split(";")[0];
  };
  const a = await signIn(), b = await signIn();
  assert.notEqual(a, b, "the cookie is not a static function of the secret");
  for (const cookie of [a, b]) assert.equal((await raw(base, "/ui/annotations", { headers: { Cookie: cookie } })).status, 200);
  assert.ok(!a.includes(secret));
  // The refresh nudge answers with the assistant address status: owner only.
  const refresh = (headers: Record<string, string>) => raw(base, "/ui/assistant-address/refresh", { method: "POST", headers: { ...json, ...headers }, body: "{}" });
  assert.equal((await refresh({})).status, 401);
  assert.notEqual((await refresh({ "x-bastra-ui-secret": secret })).status, 401);
  // A request target the URL parser rejects must not take the daemon down.
  const status = await new Promise<string>((resolve, reject) => {
    const socket = connect(Number(new URL(base).port), "127.0.0.1", () => socket.write("GET http://[/ui HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"));
    let data = ""; socket.on("data", c => { data += c; }); socket.on("end", () => resolve(data.split("\r\n")[0])); socket.on("error", reject);
  });
  assert.doesNotMatch(status, / 200 /);
  assert.equal((await raw(base, "//evil/ui/annotations")).status, 401);
  assert.equal((await raw(base, "/ui/health")).status, 200, "the daemon still answers");
});
