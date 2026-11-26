/**
 * #1198 S5 — the sign-in gate end to end against the real HTTP server:
 * isolated app database and vault, tunnel requests simulated with the headers
 * cloudflared adds (Host = public host, X-Forwarded-Proto: https,
 * X-Forwarded-For, CF-Connecting-IP).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  API_TOKEN,
  JSON_TYPE,
  PASSWORD,
  PUBLIC_HOST,
  PUBLIC_ORIGIN,
  USER,
  call,
  cookieOf,
  createAccount,
  local,
  resetAuth,
  setPublicOrigin,
  signIn,
  tunnel,
  withServer,
} from "./ui-auth-harness.js";

/** Every /ui data route of the routers, with a harmless body for writes. */
const DATA_ROUTES: Array<[string, string, string?]> = [
  ["GET", "/ui/health"],
  ["GET", "/ui/graph"],
  ["GET", "/ui/graph/node?id=a1"],
  ["GET", "/ui/graph/semantic"],
  ["GET", "/ui/annotations"],
  ["GET", "/ui/import-count"],
  ["GET", "/ui/updates?since=0"],
  ["GET", "/ui/areas"],
  ["GET", "/ui/onboarding"],
  ["GET", "/ui/telemetry?days=7"],
  ["GET", "/ui/search?q=title"],
  ["GET", "/ui/chat/conversations"],
  ["GET", "/ui/backdrop"],
  ["GET", "/ui/vault-image"],
  ["GET", "/ui/js/main.js"],
  ["POST", "/ui/annotate", '{"id":"a1","kind":"note"}'],
  ["POST", "/ui/import", "{}"],
  ["POST", "/ui/skills", "{}"],
  ["POST", "/ui/areas", "{}"],
  ["POST", "/ui/chat", '{"q":"x"}'],
  ["POST", "/ui/improve-text", '{"text":"x"}'],
  ["POST", "/ui/save-memory", '{"title":"x"}'],
  ["POST", "/ui/memory/edit", '{"id":"a1"}'],
  ["POST", "/ui/memory/archive", '{"id":"a1"}'],
  ["POST", "/ui/memory/restore", '{"id":"a1"}'],
  ["POST", "/ui/tasks/session", "{}"],
  ["POST", "/ui/auth/logout", "{}"],
  ["POST", "/ui/auth/logout-all", "{}"],
  ["POST", "/ui/auth/password", "{}"],
];

/** Public 403 with and without a session. */
const LOCAL_ONLY: Array<[string, string, string?]> = [
  ["GET", "/ui/settings"],
  ["POST", "/ui/settings/session", "{}"],
  ["GET", "/ui/settings/models"],
  ["GET", "/ui/assistant-address"],
  ["POST", "/ui/assistant-address/refresh", "{}"],
  ["GET", "/ui/fs"],
  ["POST", "/ui/import-vault", "{}"],
  ["POST", "/ui/auth/setup", "{}"],
];

const login = (port: number, headers: Record<string, string>, password = PASSWORD, remember = false) =>
  call(port, "POST", "/ui/auth/login", headers, JSON.stringify({ username: USER, password, remember }));

const publicWrite = (extra: Record<string, string> = {}) => tunnel({ ...JSON_TYPE, origin: PUBLIC_ORIGIN, ...extra });

beforeEach(() => resetAuth());

test("without an account: the Mac keeps its UI and may set up; the tunnel is closed", async () => {
  await withServer(async (port) => {
    const state = await call(port, "GET", "/ui/auth/state", local(port));
    assert.equal(state.status, 200);
    assert.deepEqual(state.json(), { account: "none", authenticated: false, access: "local", setupAllowed: true });
    assert.equal((await call(port, "GET", "/ui/health", local(port))).status, 200, "local UI as before");
    for (const path of ["/ui/auth/state", "/ui/login", "/ui/health", "/ui/"]) {
      const res = await call(port, "GET", path, tunnel());
      assert.equal(res.status, 403, `tunnel ${path}`);
    }
    // Forwarded with the token is not a direct local request: no setup.
    const proxied = local(port, { "x-forwarded-for": "127.0.0.1", authorization: `Bearer ${API_TOKEN}` });
    assert.equal((await call(port, "GET", "/ui/auth/state", proxied)).json().setupAllowed, false);
    const body = JSON.stringify({ username: USER, password: PASSWORD });
    assert.equal((await call(port, "POST", "/ui/auth/setup", { ...proxied, ...JSON_TYPE }, body)).status, 403);
    assert.equal((await call(port, "POST", "/ui/auth/setup", publicWrite(), body)).status, 403);
    assert.equal((await login(port, local(port, JSON_TYPE))).status, 409, "no-account");
  });
});

test("setup on the Mac: validation, cookie, never twice", async () => {
  await withServer(async (port) => {
    const setup = (body: unknown) => call(port, "POST", "/ui/auth/setup", local(port, JSON_TYPE), JSON.stringify(body));
    const short = await setup({ username: USER, password: "short" });
    assert.equal(short.status, 400);
    assert.deepEqual(short.json(), { error: "invalid-password", problem: "too-short" });
    const badName = await setup({ username: " x", password: PASSWORD });
    assert.equal(badName.status, 400);
    assert.equal(badName.json().error, "invalid-username");
    const ok = await setup({ username: USER, password: PASSWORD });
    assert.equal(ok.status, 200);
    assert.match(ok.headers["set-cookie"]![0]!, /^bastra_ui=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/ui$/);
    const state = await call(port, "GET", "/ui/auth/state", local(port, { cookie: cookieOf(ok) }));
    const body = state.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.username, USER);
    assert.equal(body.setupAllowed, false);
    assert.match(String(body.csrf), /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual((await setup({ username: "other", password: PASSWORD })).json(), { error: "account-exists" });
  });
});

test("with an account: every /ui data route needs a session, locally and through the tunnel", async () => {
  await createAccount();
  await withServer(async (port) => {
    for (const [method, path, body] of DATA_ROUTES) {
      for (const [where, headers] of [
        ["local", local(port, JSON_TYPE)],
        ["public", publicWrite()],
      ] as const) {
        const res = await call(port, method, path, headers, body);
        assert.equal(res.status, 401, `${where} ${method} ${path}: ${res.body}`);
        assert.deepEqual(res.json(), { error: "auth-required" });
        assert.doesNotMatch(res.body, /Body of a1|Title of a1/);
      }
    }
    // A page navigation goes to the sign-in page with a relative next.
    for (const [path, next] of [
      ["/ui/", "/ui/"],
      ["/ui", "/ui/"],
      ["/ui/?view=map", "/ui/?view=map"],
    ]) {
      const res = await call(port, "GET", path, local(port, { accept: "text/html,*/*" }));
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.location, `/ui/login?next=${encodeURIComponent(next)}`);
    }
    const state = await call(port, "GET", "/ui/auth/state", tunnel());
    assert.deepEqual(state.json(), { account: "present", authenticated: false, access: "public", setupAllowed: false });
    assert.equal(state.headers["strict-transport-security"], "max-age=31536000");
    const page = await call(port, "GET", "/ui/login?next=%2Fui%2F", tunnel());
    assert.equal(page.status, 200, "sign-in page is open");
    assert.match(page.body, /<html data-tasks-enabled="(true|false)" data-lang="(en|de)"/);
    assert.match(String(page.headers["content-security-policy"]), /script-src 'self'/);
    assert.equal((await call(port, "GET", "/ui/js/login.js", tunnel())).status, 200, "its script too");
    assert.equal((await call(port, "GET", "/ui/js/i18n/auth-en.js", tunnel())).status, 200);
  });
});

test("tunnel sign-in: exact Origin, __Host- cookie, session works, local-only routes stay 403", async () => {
  await createAccount();
  await withServer(async (port) => {
    for (const origin of [
      undefined,
      "null",
      "https://evil.example",
      `http://${PUBLIC_HOST}`,
      `${PUBLIC_ORIGIN}:8443`,
    ]) {
      const headers = tunnel(JSON_TYPE);
      if (origin !== undefined) headers.origin = origin;
      assert.equal((await login(port, headers)).status, 403, `origin ${origin}`);
    }
    const wrong = await login(port, publicWrite(), "wrong password, long enough");
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.json(), { error: "invalid-credentials" });
    const ok = await login(port, publicWrite(), PASSWORD, true);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["strict-transport-security"], "max-age=31536000");
    assert.match(
      ok.headers["set-cookie"]![0]!,
      /^__Host-bastra_ui=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/
    );
    const cookie = cookieOf(ok);
    const state = (await call(port, "GET", "/ui/auth/state", tunnel({ cookie }))).json();
    assert.equal(state.sessionKind, "device");
    const graph = await call(port, "GET", "/ui/graph", tunnel({ cookie }));
    assert.equal(graph.status, 200);
    assert.match(graph.body, /Title of a1/);
    for (const [method, path, body] of LOCAL_ONLY) {
      const res = await call(port, method, path, publicWrite({ cookie, "x-bastra-csrf": String(state.csrf) }), body);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.deepEqual(res.json(), { error: "local-only" });
    }
  });
});

test("CSRF and Origin on writes with a session", async () => {
  await createAccount();
  await withServer(async (port) => {
    const { cookie, csrf } = await signIn(port, "public");
    const annotate = (headers: Record<string, string>) =>
      call(port, "POST", "/ui/annotate", headers, '{"id":"a1","kind":"note","note":"n"}');
    assert.deepEqual((await annotate(publicWrite({ cookie }))).json(), { error: "csrf" });
    assert.equal((await annotate(publicWrite({ cookie, "x-bastra-csrf": "x".repeat(43) }))).status, 403);
    assert.equal((await annotate(publicWrite({ cookie, "x-bastra-csrf": "ü" }))).status, 403);
    const noOrigin = tunnel({ ...JSON_TYPE, cookie, "x-bastra-csrf": csrf });
    assert.equal((await annotate(noOrigin)).status, 403, "missing Origin");
    assert.equal((await annotate({ ...noOrigin, origin: "null" })).status, 403, "Origin null");
    assert.equal((await annotate(publicWrite({ cookie, "x-bastra-csrf": csrf }))).status, 200);
    // Locally the same rule applies once a session exists.
    const mac = await signIn(port, "local");
    const macAnnotate = (extra: Record<string, string>) =>
      call(port, "POST", "/ui/annotate", local(port, { ...JSON_TYPE, cookie: mac.cookie, ...extra }), "{}");
    assert.equal((await macAnnotate({})).status, 403);
    assert.notEqual((await macAnnotate({ "x-bastra-csrf": mac.csrf })).status, 403);
  });
});

test("a session belongs to its door: local cookies fail through the tunnel and back", async () => {
  await createAccount();
  await withServer(async (port) => {
    const pub = await signIn(port, "public");
    const mac = await signIn(port, "local");
    const token = (cookie: string) => cookie.slice(cookie.indexOf("=") + 1);
    assert.equal((await call(port, "GET", "/ui/graph", local(port, { cookie: pub.cookie }))).status, 401);
    const asLocal = `bastra_ui=${token(pub.cookie)}`;
    assert.equal((await call(port, "GET", "/ui/graph", local(port, { cookie: asLocal }))).status, 401);
    assert.equal((await call(port, "GET", "/ui/graph", tunnel({ cookie: mac.cookie }))).status, 401);
    const asPublic = `__Host-bastra_ui=${token(mac.cookie)}`;
    assert.equal((await call(port, "GET", "/ui/graph", tunnel({ cookie: asPublic }))).status, 401);
    assert.equal((await call(port, "GET", "/ui/graph", local(port, { cookie: mac.cookie }))).status, 200);
    // #1264 unchanged: forwarded with a local Host and no token, also with a cookie.
    for (const forwarded of [{ "x-forwarded-for": "203.0.113.9" }, { "x-forwarded-proto": "https" }] as Array<
      Record<string, string>
    >) {
      const res = await call(port, "GET", "/ui/graph", local(port, { cookie: mac.cookie, ...forwarded }));
      assert.equal(res.status, 401);
      assert.deepEqual(res.json(), { error: "unauthorized" });
    }
  });
});

test("only the tunnel shape counts as public; other routes keep their gates", async () => {
  await createAccount();
  await withServer(async (port) => {
    const { cookie } = await signIn(port, "public");
    // Without X-Forwarded-Proto: https, a public Host is refused outright.
    for (const proto of [undefined, "http", "HTTPS", "https, http"]) {
      const headers = tunnel({ cookie });
      if (proto === undefined) delete headers["x-forwarded-proto"];
      else headers["x-forwarded-proto"] = proto;
      assert.equal((await call(port, "GET", "/ui/graph", headers)).status, 403, `proto ${proto}`);
    }
    for (const [method, path] of [
      ["GET", "/health"],
      ["POST", "/hook/recall"],
      ["GET", "/hook/taxonomy"],
      ["GET", "/curator/state"],
      ["GET", "/vault/count"],
    ]) {
      const res = await call(
        port,
        method!,
        path!,
        tunnel({ ...JSON_TYPE, cookie }),
        method === "POST" ? "{}" : undefined
      );
      assert.equal(res.status, 403, `${method} ${path}`);
    }
    // /api/v1 unchanged: direct local without token, the tunnel only with the bearer token.
    assert.equal((await call(port, "GET", "/api/v1/health", local(port))).status, 200);
    assert.equal((await call(port, "GET", "/api/v1/health", tunnel({ cookie }))).status, 401);
    assert.equal(
      (await call(port, "GET", "/api/v1/health", tunnel({ authorization: `Bearer ${API_TOKEN}` }))).status,
      200
    );
    // Remote access off: the public host is an ordinary foreign host again.
    await setPublicOrigin(null);
    assert.equal((await call(port, "GET", "/ui/graph", tunnel({ cookie }))).status, 403);
  });
});

test("logout, logout everywhere and password change", async () => {
  await createAccount();
  await withServer(async (port) => {
    const a = await signIn(port, "public");
    const b = await signIn(port, "local");
    const out = await call(
      port,
      "POST",
      "/ui/auth/logout",
      publicWrite({ cookie: a.cookie, "x-bastra-csrf": a.csrf }),
      "{}"
    );
    assert.equal(out.status, 200);
    assert.match(
      out.headers["set-cookie"]![0]!,
      /^__Host-bastra_ui=; Secure; HttpOnly; SameSite=Strict; Path=\/; Max-Age=0$/
    );
    assert.equal((await call(port, "GET", "/ui/graph", tunnel({ cookie: a.cookie }))).status, 401);
    assert.equal((await call(port, "GET", "/ui/graph", local(port, { cookie: b.cookie }))).status, 200);

    const c = await signIn(port, "public");
    const all = await call(
      port,
      "POST",
      "/ui/auth/logout-all",
      local(port, { ...JSON_TYPE, cookie: b.cookie, "x-bastra-csrf": b.csrf }),
      "{}"
    );
    assert.equal(all.status, 200);
    assert.equal((await call(port, "GET", "/ui/graph", local(port, { cookie: b.cookie }))).status, 401);
    assert.equal((await call(port, "GET", "/ui/graph", tunnel({ cookie: c.cookie }))).status, 401);

    const d = await signIn(port, "local");
    const e = await signIn(port, "public");
    const change = (body: unknown) =>
      call(
        port,
        "POST",
        "/ui/auth/password",
        local(port, { ...JSON_TYPE, cookie: d.cookie, "x-bastra-csrf": d.csrf }),
        JSON.stringify(body)
      );
    assert.deepEqual((await change({ current: PASSWORD, next: "short" })).json(), {
      error: "invalid-password",
      problem: "too-short",
    });
    assert.deepEqual(
      (await change({ current: "wrong password, long enough", next: "another long passphrase" })).json(),
      {
        error: "invalid-credentials",
      }
    );
    const changed = await change({ current: PASSWORD, next: "another long passphrase" });
    assert.equal(changed.status, 200);
    const fresh = cookieOf(changed);
    assert.equal((await call(port, "GET", "/ui/graph", local(port, { cookie: fresh }))).status, 200);
    assert.equal((await call(port, "GET", "/ui/graph", local(port, { cookie: d.cookie }))).status, 401);
    assert.equal((await call(port, "GET", "/ui/graph", tunnel({ cookie: e.cookie }))).status, 401);
    assert.equal((await login(port, publicWrite())).status, 401, "old password no longer works");
    assert.equal((await login(port, publicWrite(), "another long passphrase")).status, 200);
  });
});

test("password guessing through the tunnel: 429 with Retry-After, the Mac still signs in", async () => {
  await createAccount();
  await withServer(async (port) => {
    for (let i = 0; i < 5; i++)
      assert.equal((await login(port, publicWrite(), `wrong password number ${i}`)).status, 401);
    const locked = await login(port, publicWrite());
    assert.equal(locked.status, 429);
    assert.equal(locked.json().error, "locked");
    assert.ok(Number(locked.headers["retry-after"]) > 0);
    assert.equal(locked.json().retryAfterSeconds, Number(locked.headers["retry-after"]));
    // Another public source is not locked yet; the Mac is never locked by public failures.
    assert.equal((await login(port, publicWrite({ "cf-connecting-ip": "198.51.100.4" }))).status, 200);
    assert.equal((await login(port, local(port, JSON_TYPE))).status, 200);
    // Malformed and oversized input is a clean refusal.
    assert.equal((await call(port, "POST", "/ui/auth/login", local(port, JSON_TYPE), "{not json")).status, 400);
    const huge = JSON.stringify({ username: USER, password: "x".repeat(20_000) });
    assert.equal((await call(port, "POST", "/ui/auth/login", local(port, JSON_TYPE), huge)).status, 413);
  });
});
