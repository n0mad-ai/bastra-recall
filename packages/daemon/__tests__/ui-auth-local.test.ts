/**
 * #1198 S8 — acceptance before internet access, the Mac side ("Abnahme vor der
 * Internet-Freigabe", points 3, 6, 8, 9 and 10), against the real HTTP server:
 * #1264 for forwarded requests, session lifetimes and every way to end them,
 * backward compatibility for existing local users, malformed input and what
 * leaves the database or reaches the logs.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_TOKEN,
  JSON_TYPE,
  PASSWORD,
  PUBLIC_HOST,
  PUBLIC_ORIGIN,
  USER,
  call,
  createAccount,
  local,
  resetAuth,
  signIn,
  tunnel,
  withServer,
} from "./ui-auth-harness.js";
import { uiAuthStores, type UiAuthStores } from "../src/ui-auth-stores.js";
import { cmdAccount, type AccountIO } from "../src/cli/account-cmd.js";
import { accountWordsIn } from "../src/cli/account-words.js";

const NEW_PASSWORD = "another long passphrase 1234";

beforeEach(() => resetAuth());

const stores = (): UiAuthStores => uiAuthStores()!;
const tokenOf = (cookie: string) => cookie.slice(cookie.indexOf("=") + 1);
const graph = (port: number, cookie: string, access: "local" | "public" = "local") =>
  call(port, "GET", "/ui/graph", access === "local" ? local(port, { cookie }) : tunnel({ cookie }));

/** Sets fields of the session behind a cookie directly in the isolated app database. */
function ageSession(cookie: string, fields: { lastSeenAt?: number; expiresAt?: number }): void {
  const db = stores().db.sqlite;
  for (const [column, value] of [
    ["last_seen_at", fields.lastSeenAt],
    ["expires_at", fields.expiresAt],
  ] as const) {
    if (value === undefined) continue;
    const changed = db
      .prepare(`UPDATE ui_sessions SET ${column}=? WHERE token_hash=?`)
      .run(value, sha256(tokenOf(cookie)));
    assert.equal(Number(changed.changes), 1, "session row found");
  }
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const lastSeen = (cookie: string) =>
  Number(
    (
      stores()
        .db.sqlite.prepare("SELECT last_seen_at FROM ui_sessions WHERE token_hash=?")
        .get(sha256(tokenOf(cookie))) as {
        last_seen_at: number;
      }
    ).last_seen_at
  );

test("Abnahme 3: #1264 unchanged — forwarded with Host 127.0.0.1 and no token is 401, also with a cookie", async () => {
  await withServer(async (port) => {
    // Without an account the Mac's UI is open, but never for a forwarded request without the token.
    for (const fwd of [
      { "x-forwarded-for": "203.0.113.9" },
      { "x-forwarded-proto": "https" },
      { "x-forwarded-host": PUBLIC_HOST },
      { forwarded: "for=203.0.113.9" },
      { "x-real-ip": "203.0.113.9" },
      { via: "1.1 proxy" },
      { "x-forwarded-for": "" },
    ] as Array<Record<string, string>>) {
      for (const path of ["/ui/graph", "/ui/auth/state", "/hook/onboarding", "/vault/count"]) {
        const res = await call(port, "GET", path, local(port, fwd));
        assert.equal(res.status, 401, `${path} ${JSON.stringify(fwd)}`);
      }
    }
    // (i) With the API token a forwarded local request stays usable (no account yet), but is no setup door.
    const withToken = local(port, { "x-forwarded-for": "203.0.113.9", authorization: `Bearer ${API_TOKEN}` });
    assert.equal((await call(port, "GET", "/ui/graph", withToken)).status, 200);
    assert.equal((await call(port, "GET", "/ui/auth/state", withToken)).json().setupAllowed, false);
    const wrongToken = local(port, { "x-forwarded-for": "203.0.113.9", authorization: "Bearer nope" });
    assert.equal((await call(port, "GET", "/ui/graph", wrongToken)).status, 401);
  });
  await createAccount();
  await withServer(async (port) => {
    const mac = await signIn(port, "local");
    const res = await call(
      port,
      "GET",
      "/ui/graph",
      local(port, { cookie: mac.cookie, "x-forwarded-for": "203.0.113.9" })
    );
    assert.equal(res.status, 401);
    assert.deepEqual(res.json(), { error: "unauthorized" });
    // With the token but without a session: the sign-in gate still asks for a session.
    const tokenOnly = local(port, { "x-forwarded-for": "203.0.113.9", authorization: `Bearer ${API_TOKEN}` });
    assert.equal((await call(port, "GET", "/ui/graph", tokenOnly)).status, 401);
    assert.deepEqual((await call(port, "GET", "/ui/graph", tokenOnly)).json(), { error: "auth-required" });
  });
});

test("Abnahme 6: idle 2 h and absolute 24 h end a browser session; a device session ignores idle", async () => {
  await createAccount();
  await withServer(async (port) => {
    const browser = await signIn(port, "local");
    const device = await signIn(port, "public", true);
    const idle = await signIn(port, "local");
    assert.equal((await graph(port, browser.cookie)).status, 200);
    ageSession(idle.cookie, { lastSeenAt: Date.now() - 2 * 3600_000 - 1000 });
    assert.equal((await graph(port, idle.cookie)).status, 401, "2 h idle");
    ageSession(browser.cookie, { expiresAt: Date.now() - 1 });
    assert.equal((await graph(port, browser.cookie)).status, 401, "absolute end");
    ageSession(device.cookie, { lastSeenAt: Date.now() - 10 * 24 * 3600_000 });
    assert.equal((await graph(port, device.cookie, "public")).status, 200, "device: no idle limit");
    ageSession(device.cookie, { expiresAt: Date.now() - 1 });
    assert.equal((await graph(port, device.cookie, "public")).status, 401, "device: 30-day end");
  });
});

test("Abnahme 6 (h): background polls do not extend a session over HTTP; real use does", async () => {
  await createAccount();
  await withServer(async (port) => {
    const mac = await signIn(port, "local");
    const old = Date.now() - 30 * 60_000;
    ageSession(mac.cookie, { lastSeenAt: old });
    for (const path of ["/ui/health", "/ui/import-count"]) {
      assert.equal((await call(port, "GET", path, local(port, { cookie: mac.cookie }))).status, 200, path);
      assert.equal(lastSeen(mac.cookie), old, `${path} must not touch the session`);
    }
    assert.equal((await graph(port, mac.cookie)).status, 200);
    assert.ok(lastSeen(mac.cookie) > old, "a real request records activity");
  });
});

test("Abnahme 6: logout, sign-out everywhere, single revoke and CLI reset end sessions at once", async () => {
  await createAccount();
  await withServer(async (port) => {
    // Logout: own session only; the old cookie never works again.
    const a = await signIn(port, "local");
    const b = await signIn(port, "local");
    const out = await call(
      port,
      "POST",
      "/ui/auth/logout",
      local(port, { ...JSON_TYPE, cookie: a.cookie, "x-bastra-csrf": a.csrf }),
      "{}"
    );
    assert.equal(out.status, 200);
    assert.equal((await graph(port, a.cookie)).status, 401);
    assert.equal((await graph(port, b.cookie)).status, 200);
    // Logout needs CSRF: a foreign page cannot sign the owner out.
    assert.equal(
      (await call(port, "POST", "/ui/auth/logout", local(port, { ...JSON_TYPE, cookie: b.cookie }), "{}")).status,
      403
    );
    // Single revoke by handle (device list), effective on the next request.
    const pub = await signIn(port, "public", true);
    const pubId = stores()
      .sessions.list()
      .find((s) => s.origin === "public")!.id;
    assert.ok(stores().sessions.revoke(pubId));
    assert.equal((await graph(port, pub.cookie, "public")).status, 401);
    // Sign-out everywhere from a public session ends the Mac's too.
    const c = await signIn(port, "public");
    const all = await call(
      port,
      "POST",
      "/ui/auth/logout-all",
      tunnel({ ...JSON_TYPE, origin: PUBLIC_ORIGIN, cookie: c.cookie, "x-bastra-csrf": c.csrf }),
      "{}"
    );
    assert.equal(all.status, 200);
    assert.equal((await graph(port, b.cookie)).status, 401);
    assert.equal((await graph(port, c.cookie, "public")).status, 401);
    // CLI reset-password: every session ends, the new password works, the old one not.
    const d = await signIn(port, "local");
    const e = await signIn(port, "public", true);
    const said: string[] = [];
    const io: AccountIO = {
      stores: uiAuthStores,
      interactive: () => true,
      askLine: async () => null,
      askSecret: async () => NEW_PASSWORD,
      out: (t) => void said.push(t),
      err: (t) => void said.push(t),
      words: async () => accountWordsIn("en"),
      publicOrigin: { get: async () => PUBLIC_ORIGIN, set: async () => undefined },
    };
    assert.equal(await cmdAccount({ sub: "reset-password", positional: [] }, io), 0);
    assert.doesNotMatch(said.join(""), new RegExp(NEW_PASSWORD));
    assert.equal((await graph(port, d.cookie)).status, 401);
    assert.equal((await graph(port, e.cookie, "public")).status, 401);
    const login = (password: string) =>
      call(port, "POST", "/ui/auth/login", local(port, JSON_TYPE), JSON.stringify({ username: USER, password }));
    assert.equal((await login(PASSWORD)).status, 401);
    assert.equal((await login(NEW_PASSWORD)).status, 200);
  });
});

test("Abnahme 6: a daemon restart keeps device and browser sessions", async () => {
  await createAccount();
  let device = "";
  let browser = "";
  await withServer(async (port) => {
    device = (await signIn(port, "public", true)).cookie;
    browser = (await signIn(port, "local")).cookie;
  });
  await withServer(async (port) => {
    assert.equal((await graph(port, device, "public")).status, 200);
    assert.equal((await graph(port, browser)).status, 200);
  });
});

test("Abnahme 8: an existing user without an account keeps everything on the Mac; MCP, hooks, /api/v1 and OAuth unchanged", async () => {
  const checkLocal = async (port: number) => {
    // /api/v1 locally without token (MCP forwarder, CLI), never reading a cookie.
    assert.equal((await call(port, "GET", "/api/v1/health", local(port))).status, 200);
    const recall = await call(port, "POST", "/api/v1/recall", local(port, JSON_TYPE), JSON.stringify({ query: "a1" }));
    assert.equal(recall.status, 200, recall.body);
    // Hooks and the loopback surface.
    assert.equal((await call(port, "GET", "/health", local(port))).status, 200);
    const hook = await call(
      port,
      "POST",
      "/hook/recall",
      local(port, JSON_TYPE),
      JSON.stringify({ query: "Title of a1" })
    );
    assert.equal(hook.status, 200, hook.body);
    assert.equal((await call(port, "GET", "/vault/count", local(port))).status, 200);
    // /api/v1 through the tunnel only with the bearer token, a UI cookie does not help.
    assert.equal((await call(port, "GET", "/api/v1/health", tunnel())).status, 401);
    assert.equal(
      (await call(port, "GET", "/api/v1/health", tunnel({ authorization: `Bearer ${API_TOKEN}` }))).status,
      200
    );
    // Remote MCP / OAuth discovery through the tunnel.
    const wellKnown = await call(port, "GET", "/.well-known/oauth-authorization-server", tunnel());
    assert.equal(wellKnown.status, 200, wellKnown.body);
  };
  await withServer(async (port) => {
    // Without an account: the web UI on the Mac as before, reads and writes, no sign-in needed.
    assert.equal((await graph(port, "")).status, 200);
    assert.equal((await call(port, "GET", "/ui/", local(port, { accept: "text/html" }))).status, 200);
    const annotate = await call(
      port,
      "POST",
      "/ui/annotate",
      local(port, JSON_TYPE),
      '{"id":"a1","kind":"note","note":"n"}'
    );
    assert.notEqual(annotate.status, 401);
    assert.notEqual(annotate.status, 403);
    const settings = await call(port, "POST", "/ui/settings/session", local(port, JSON_TYPE), "{}");
    assert.equal(settings.status, 200, "settings page as before");
    await checkLocal(port);
  });
  await createAccount();
  await withServer(async (port) => {
    // With an account, nothing outside /ui changes.
    await checkLocal(port);
    const cookie = (await signIn(port, "local")).cookie;
    assert.equal((await call(port, "GET", "/api/v1/health", tunnel({ cookie: `__Host-${cookie}` }))).status, 401);
  });
});

test("Abnahme 9: malformed, multi-byte and oversized cookies and credentials are refused cleanly", async () => {
  await createAccount();
  await withServer(async (port) => {
    for (const cookie of [
      "bastra_ui",
      "bastra_ui=",
      "bastra_ui=ü".repeat(10),
      `bastra_ui=${"A".repeat(42)}`,
      `bastra_ui=${"A".repeat(44)}`,
      `bastra_ui=${"A".repeat(43)}`,
      `bastra_ui=${"A".repeat(10_000)}`,
      Array.from({ length: 200 }, (_, i) => `c${i}=v`).join("; "),
      "=; ; ;=;bastra_ui==",
      "bastra_ui=%00%00",
    ]) {
      const res = await call(port, "GET", "/ui/graph", local(port, { cookie }));
      assert.ok(res.status === 401 || res.status === 431, `${cookie.slice(0, 30)}: ${res.status}`);
    }
    const post = (path: string, body: string | Buffer, extra: Record<string, string> = {}) =>
      call(port, "POST", path, local(port, { ...JSON_TYPE, ...extra }), body as string);
    for (const body of [
      "null",
      "false",
      "0",
      '""',
      "[]",
      '"text"',
      "123",
      "{",
      '{"username":1,"password":2}',
      '{"username":null,"password":null}',
      '{"username":{},"password":[]}',
      JSON.stringify({ username: USER, password: "ü".repeat(600) }),
      JSON.stringify({ username: "ü".repeat(500), password: PASSWORD }),
      JSON.stringify({ username: USER, password: "\ud800 lone surrogate password" }),
      JSON.stringify({ username: USER, password: "x".repeat(1025) }),
      JSON.stringify({ username: USER, password: "x".repeat(15_000) }),
      JSON.stringify({ username: USER, password: "x".repeat(20_000) }),
      JSON.stringify({ __proto__: { username: USER }, password: PASSWORD }),
    ]) {
      // The Mac's soft limit (5 a minute) is not what this test is about.
      stores().throttle.unlock();
      const res = await post("/ui/auth/login", body);
      assert.ok([400, 401, 413].includes(res.status), `login ${body.slice(0, 30)}: ${res.status} ${res.body}`);
      assert.doesNotMatch(res.body, /Error|at \w+ \(|stack/);
    }
    // Invalid UTF-8 on the wire.
    const bytes = Buffer.concat([
      Buffer.from('{"username":"daniel","password":"'),
      Buffer.from([0xff, 0xfe, 0xc3]),
      Buffer.from('xxxxxxxxxxxxxxxx"}'),
    ]);
    stores().throttle.unlock();
    assert.equal((await post("/ui/auth/login", bytes as unknown as string)).status, 401);
    // The same for the password change and setup bodies.
    stores().throttle.unlock();
    const mac = await signIn(port, "local");
    for (const body of [
      "null",
      "0",
      "[]",
      '{"current":1,"next":2}',
      JSON.stringify({ current: PASSWORD, next: "ü".repeat(600) }),
    ]) {
      stores().throttle.unlock();
      const res = await post("/ui/auth/password", body, { cookie: mac.cookie, "x-bastra-csrf": mac.csrf });
      assert.ok([400, 401].includes(res.status), `password ${body.slice(0, 30)}: ${res.status} ${res.body}`);
    }
    assert.equal((await graph(port, mac.cookie)).status, 200, "a refused change keeps the session");
    // A multi-byte CSRF header is a clean 403.
    const res = await post("/ui/annotate", "{}", { cookie: mac.cookie, "x-bastra-csrf": "ä".repeat(43) });
    assert.equal(res.status, 403);
  });
  // Setup without an account: same malformed bodies, no account appears.
  resetAuth();
  await withServer(async (port) => {
    for (const body of ["null", "false", "0", "[]", '{"username":1,"password":2}']) {
      const res = await call(port, "POST", "/ui/auth/setup", local(port, JSON_TYPE), body);
      assert.equal(res.status, 400, `setup ${body}: ${res.status} ${res.body}`);
    }
    assert.equal(stores().accounts.status().state, "none");
  });
});

test("Abnahme 10: export and logs carry no password, password check value or session hash", async () => {
  await createAccount();
  const written: string[] = [];
  const saved = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  const capture =
    (target: typeof saved.out) =>
    (chunk: unknown, ...rest: unknown[]): boolean => {
      written.push(String(chunk));
      return (target as (...args: unknown[]) => boolean)(chunk, ...rest);
    };
  process.stdout.write = capture(saved.out) as typeof process.stdout.write;
  process.stderr.write = capture(saved.err) as typeof process.stderr.write;
  const dir = await mkdtemp(join(tmpdir(), "bastra-ui-auth-export-"));
  try {
    let cookie = "";
    await withServer(async (port) => {
      cookie = (await signIn(port, "public", true)).cookie;
      await call(
        port,
        "POST",
        "/ui/auth/login",
        tunnel({ ...JSON_TYPE, origin: PUBLIC_ORIGIN }),
        JSON.stringify({ username: USER, password: "a wrong password, long" })
      );
      const mac = await signIn(port, "local");
      await call(
        port,
        "POST",
        "/ui/auth/password",
        local(port, { ...JSON_TYPE, cookie: mac.cookie, "x-bastra-csrf": mac.csrf }),
        JSON.stringify({ current: PASSWORD, next: NEW_PASSWORD })
      );
    });
    const file = join(dir, "export.json");
    stores().db.exportJson(file);
    const text = await readFile(file, "utf8");
    const hash = String(
      (stores().db.sqlite.prepare("SELECT password_hash FROM ui_account").get() as { password_hash: string })
        .password_hash
    );
    for (const secret of [PASSWORD, NEW_PASSWORD, hash, "$argon2id$", tokenOf(cookie), sha256(tokenOf(cookie))]) {
      assert.ok(!text.includes(secret), `export contains ${secret.slice(0, 12)}…`);
    }
    assert.equal((await stat(file)).mode & 0o077, 0, "export readable by the owner only");
    const logged = written.join("");
    for (const secret of [PASSWORD, NEW_PASSWORD, "a wrong password, long", hash, tokenOf(cookie)]) {
      assert.ok(!logged.includes(secret), `console output contains ${secret.slice(0, 12)}…`);
    }
    // The telemetry log this test process writes to (test-env.mjs points it at a throwaway dir).
    const logDir = process.env.BASTRA_LOG_PATH;
    if (logDir) {
      for (const name of await readdir(logDir, { recursive: true }).catch(() => [] as string[])) {
        const content = await readFile(join(logDir, String(name)), "utf8").catch(() => "");
        for (const secret of [PASSWORD, NEW_PASSWORD, "a wrong password, long", tokenOf(cookie)])
          assert.ok(!content.includes(secret), `log ${name} contains ${secret.slice(0, 12)}…`);
      }
    }
  } finally {
    process.stdout.write = saved.out;
    process.stderr.write = saved.err;
    await rm(dir, { recursive: true, force: true });
  }
});
