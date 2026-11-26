/**
 * #1198 S8 — acceptance before internet access, the tunnel side ("Abnahme vor
 * der Internet-Freigabe", points 1, 2, 4, 5 and 7), against the real HTTP
 * server with simulated cloudflared headers, plus the attacker probes of the
 * independent security review (host, path and header tricks).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import {
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
  signIn,
  tunnel,
  withServer,
} from "./ui-auth-harness.js";
import { uiAuthStores } from "../src/ui-auth-stores.js";

const VAULT_TEXT = /Body of a1|Title of a1|Summary of a1/;

/** Every /ui route that answers with vault, task or health data. */
const DATA_READS = [
  "/ui/health",
  "/ui/graph",
  "/ui/graph/node?id=a1",
  "/ui/graph/semantic",
  "/ui/annotations",
  "/ui/import-count",
  "/ui/updates?since=0",
  "/ui/areas",
  "/ui/onboarding",
  "/ui/telemetry?days=7",
  "/ui/search?q=title",
  "/ui/chat/conversations",
  "/ui/backdrop",
  "/ui/vault-image",
  "/ui/",
  "/ui/index.html",
  "/ui/js/main.js",
];

const publicWrite = (extra: Record<string, string> = {}) => tunnel({ ...JSON_TYPE, origin: PUBLIC_ORIGIN, ...extra });

const login = (port: number, headers: Record<string, string>, password = PASSWORD, username = USER) =>
  call(port, "POST", "/ui/auth/login", headers, JSON.stringify({ username, password, remember: false }));

/** A request written byte for byte, for duplicate headers and odd request lines. */
function raw(port: number, text: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let out = "";
    socket.on("data", (c) => (out += c.toString("latin1")));
    socket.on("end", () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(out)?.[1] ?? 0);
      resolve({ status, body: out.slice(out.indexOf("\r\n\r\n") + 4) });
    });
    socket.on("error", reject);
    socket.write(text.replace(/\n/g, "\r\n"));
  });
}

beforeEach(() => resetAuth());

test("Abnahme 1: without a session no /ui data route through the public host returns vault, task or health data", async () => {
  await createAccount();
  await withServer(async (port) => {
    for (const path of DATA_READS) {
      for (const accept of ["application/json", "text/html"]) {
        const res = await call(port, "GET", path, tunnel({ accept }));
        assert.ok(res.status === 401 || res.status === 302, `${path} (${accept}): ${res.status}`);
        assert.doesNotMatch(res.body, VAULT_TEXT, path);
        assert.doesNotMatch(res.body, /vault_size|"version"/, `${path}: no health payload`);
        if (res.status === 302) assert.match(String(res.headers.location), /^\/ui\/login\?next=%2Fui%2F/);
      }
    }
    // Tasks: neither a task session nor the task API without a UI session.
    for (const path of ["/ui/tasks/session", "/ui/tasks/api/task_list"]) {
      const res = await call(port, "POST", path, publicWrite(), "{}");
      assert.equal(res.status, 401, path);
    }
    // A forged, expired-looking or foreign cookie is no session either.
    for (const cookie of [
      `__Host-bastra_ui=${"A".repeat(43)}`,
      `bastra_ui=${"A".repeat(43)}`,
      "__Host-bastra_ui=",
      "__Host-bastra_ui=ä",
    ]) {
      const res = await call(port, "GET", "/ui/graph", tunnel({ cookie }));
      assert.equal(res.status, 401, cookie);
    }
  });
});

test("Abnahme 1: without an account the tunnel is closed entirely, setup included", async () => {
  await withServer(async (port) => {
    for (const path of ["/ui/", "/ui/graph", "/ui/health", "/ui/auth/state", "/ui/login"]) {
      assert.equal((await call(port, "GET", path, tunnel())).status, 403, path);
    }
    const body = JSON.stringify({ username: USER, password: PASSWORD });
    assert.equal((await call(port, "POST", "/ui/auth/setup", publicWrite(), body)).status, 403);
    // A tunnel request claiming a local Host is forwarded: token rule (#1264), no setup, no open UI.
    for (const host of ["127.0.0.1", `127.0.0.1:${port}`, "localhost", "[::1]"]) {
      const forged = tunnel({ ...JSON_TYPE, host, origin: `http://${host}` });
      assert.equal((await call(port, "GET", "/ui/graph", forged)).status, 401, host);
      assert.equal((await call(port, "POST", "/ui/auth/setup", forged, body)).status, 401, host);
    }
    assert.equal(uiAuthStores()!.accounts.status().state, "none", "no account was created");
  });
});

test("Abnahme 1: host, path and header tricks never reach data through the tunnel", async () => {
  await createAccount();
  await withServer(async (port) => {
    // Host spellings: only the exact host (case-insensitive) is public; the rest is foreign or forwarded.
    for (const host of [`${PUBLIC_HOST}.`, `${PUBLIC_HOST}:443`, `${PUBLIC_HOST}:8443`, `x.${PUBLIC_HOST}`, ""]) {
      const res = await call(port, "GET", "/ui/graph", tunnel({ host }));
      assert.ok(res.status === 403 || res.status === 401 || res.status === 400, `host "${host}": ${res.status}`);
      assert.doesNotMatch(res.body, VAULT_TEXT);
    }
    assert.equal((await call(port, "GET", "/ui/graph", tunnel({ host: PUBLIC_HOST.toUpperCase() }))).status, 401);
    // Path tricks: refused before any gate, or landing on a gated path.
    for (const path of [
      "/UI/graph",
      "//ui/graph",
      "/ui/../ui/graph",
      "/ui/%2e%2e/ui/graph",
      "/ui/fonts/../graph",
      "/ui/fonts/%2e%2e/index.html",
      "/ui/fonts/..%2f..%2fjs/main.js",
      "/ui/js/login.js/../main.js",
      "/ui/graph%00",
      "/ui/login/../graph",
      "/ui\\graph",
      "/ui/./graph",
      `/ui/${"a".repeat(12_000)}`,
    ]) {
      const res = await raw(
        port,
        `GET ${path} HTTP/1.1\nHost: ${PUBLIC_HOST}\nX-Forwarded-Proto: https\nX-Forwarded-For: 203.0.113.9\nConnection: close\n\n`
      );
      assert.ok([400, 401, 403, 404, 431].includes(res.status), `${path.slice(0, 40)}: ${res.status}`);
      assert.doesNotMatch(res.body, VAULT_TEXT);
    }
    // Absolute-form request line naming a local host.
    const absolute = await raw(
      port,
      `GET http://127.0.0.1:${port}/ui/graph HTTP/1.1\nHost: ${PUBLIC_HOST}\nX-Forwarded-Proto: https\nX-Forwarded-For: 203.0.113.9\nConnection: close\n\n`
    );
    assert.equal(absolute.status, 400);
    // Duplicate Host: the second (local) one must never make the request local.
    const twoHosts = await raw(
      port,
      `GET /ui/graph HTTP/1.1\nHost: ${PUBLIC_HOST}\nHost: 127.0.0.1\nX-Forwarded-Proto: https\nX-Forwarded-For: 203.0.113.9\nConnection: close\n\n`
    );
    assert.ok([400, 401, 403].includes(twoHosts.status), `two hosts: ${twoHosts.status}`);
    assert.doesNotMatch(twoHosts.body, VAULT_TEXT);
    // Duplicate X-Forwarded-Proto is not "https".
    const twoProtos = await raw(
      port,
      `GET /ui/auth/state HTTP/1.1\nHost: ${PUBLIC_HOST}\nX-Forwarded-Proto: https\nX-Forwarded-Proto: http\nX-Forwarded-For: 203.0.113.9\nConnection: close\n\n`
    );
    assert.equal(twoProtos.status, 403);
    // The sign-in page's open files serve exactly those files, nothing behind them.
    assert.equal((await call(port, "GET", "/ui/fonts/IBMPlexMono-400-latin.woff2", tunnel())).status, 200);
    assert.equal((await call(port, "GET", "/ui/js/login.js", tunnel())).status, 200);
    for (const path of ["/ui/js/login.js.map", "/ui/js/main.js", "/ui/fonts", "/ui/js/i18n/views-en.json"]) {
      assert.notEqual((await call(port, "GET", path, tunnel())).status, 200, path);
    }
  });
});

test("Abnahme 2: with a session the local-only routes stay 403; /hook, /health, /curator with the public host 403/404", async () => {
  await createAccount();
  await withServer(async (port) => {
    const { cookie, csrf } = await signIn(port, "public");
    const withSession = (extra: Record<string, string> = {}) =>
      publicWrite({ cookie, "x-bastra-csrf": csrf, ...extra });
    for (const [method, path] of [
      ["GET", "/ui/settings"],
      ["GET", "/ui/settings/devices"],
      ["POST", "/ui/settings/session"],
      ["POST", "/ui/settings/devices/unlock"],
      ["POST", "/ui/settings/devices/remote-off"],
      ["GET", "/ui/settingsX"],
      ["GET", "/ui/assistant-address"],
      ["POST", "/ui/assistant-address/refresh"],
      ["GET", "/ui/fs"],
      ["GET", "/ui/fs?path=/"],
      ["GET", "/ui/fsx"],
      ["POST", "/ui/import-vault"],
      ["POST", "/ui/auth/setup"],
    ]) {
      const res = await call(port, method!, path!, withSession(), method === "POST" ? "{}" : undefined);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.deepEqual(res.json(), { error: "local-only" });
    }
    for (const [method, path] of [
      ["GET", "/health"],
      ["POST", "/hook/recall"],
      ["GET", "/hook/onboarding"],
      ["GET", "/hook/import"],
      ["GET", "/hook/floors"],
      ["GET", "/curator/state"],
      ["POST", "/curator/run"],
      ["GET", "/vault/count"],
      ["GET", "/tools"],
      ["GET", "/code/refresh"],
    ]) {
      const res = await call(port, method!, path!, withSession(), method === "POST" ? "{}" : undefined);
      assert.ok(res.status === 403 || res.status === 404, `${method} ${path}: ${res.status}`);
      assert.doesNotMatch(res.body, VAULT_TEXT);
    }
    // The session itself works: data through the tunnel, private memories only with it.
    assert.equal((await call(port, "GET", "/ui/graph", tunnel({ cookie }))).status, 200);
    assert.equal((await call(port, "GET", "/ui/health", tunnel({ cookie }))).status, 200);
  });
});

test("Abnahme 4: foreign Origin, Origin null, missing Origin and missing or wrong CSRF are 403 through the tunnel", async () => {
  await createAccount();
  await withServer(async (port) => {
    const { cookie, csrf } = await signIn(port, "public");
    const write = (path: string, headers: Record<string, string>, body = "{}") =>
      call(port, "POST", path, headers, body);
    const base = tunnel({ ...JSON_TYPE, cookie, "x-bastra-csrf": csrf });
    const badOrigins: Array<string | undefined> = [
      undefined,
      "null",
      "https://evil.example",
      `https://x.${PUBLIC_HOST}`,
      `https://${PUBLIC_HOST}.evil.example`,
      `http://${PUBLIC_HOST}`,
      `${PUBLIC_ORIGIN}:8443`,
      `${PUBLIC_ORIGIN}/`,
      `${PUBLIC_ORIGIN}, ${PUBLIC_ORIGIN}`,
    ];
    for (const path of [
      "/ui/annotate",
      "/ui/auth/logout",
      "/ui/auth/password",
      "/ui/tasks/session",
      "/ui/auth/login",
    ]) {
      for (const origin of badOrigins) {
        const headers = { ...base };
        if (origin !== undefined) headers.origin = origin;
        const res = await write(path, headers);
        assert.equal(res.status, 403, `${path} origin ${origin}`);
      }
    }
    // Writes other than POST (DELETE skips the generic POST gate) need the exact Origin and CSRF too.
    const del = await call(port, "DELETE", "/ui/backdrop/abc", tunnel({ cookie, "x-bastra-csrf": csrf }));
    assert.equal(del.status, 403, "DELETE without Origin");
    for (const bad of [undefined, "", "x".repeat(43), csrf.slice(1), `${csrf}, ${csrf}`, "ä".repeat(43)]) {
      const headers = publicWrite({ cookie });
      if (bad !== undefined) headers["x-bastra-csrf"] = bad;
      const res = await write("/ui/annotate", headers, '{"id":"a1","kind":"note","note":"n"}');
      assert.equal(res.status, 403, `csrf ${JSON.stringify(bad)}`);
      assert.deepEqual(res.json(), { error: "csrf" });
    }
    // CSRF of another session does not fit this one.
    const other = await signIn(port, "public");
    const foreign = await write("/ui/annotate", publicWrite({ cookie, "x-bastra-csrf": other.csrf }));
    assert.deepEqual(foreign.json(), { error: "csrf" });
    // A non-JSON body (simple cross-site form) is refused before anything runs.
    const form = await call(
      port,
      "POST",
      "/ui/auth/logout",
      tunnel({ origin: PUBLIC_ORIGIN, cookie, "x-bastra-csrf": csrf, "content-type": "text/plain" }),
      "{}"
    );
    assert.equal(form.status, 415);
    assert.equal((await call(port, "GET", "/ui/graph", tunnel({ cookie }))).status, 200, "session survived");
  });
});

test("Abnahme 5: per-source lock, account lock, queue; the Mac and device sessions keep working", async () => {
  await createAccount();
  await withServer(async (port) => {
    const device = await call(
      port,
      "POST",
      "/ui/auth/login",
      publicWrite({ "cf-connecting-ip": "198.51.100.200" }),
      JSON.stringify({ username: USER, password: PASSWORD, remember: true })
    );
    const deviceCookie = cookieOf(device);
    // 5 failures from one source lock that source (IPv6 counts per /64).
    for (let i = 0; i < 5; i++) {
      const ip = `2001:db8:1:2::${i + 1}`;
      assert.equal(
        (await login(port, publicWrite({ "cf-connecting-ip": ip }), `wrong password number ${i}`)).status,
        401
      );
    }
    const sameNet = await login(port, publicWrite({ "cf-connecting-ip": "2001:db8:1:2:ffff::9" }));
    assert.equal(sameNet.status, 429, "same /64 is the same source");
    assert.equal(sameNet.json().error, "locked");
    // 20 failures over many sources close public sign-in for everyone.
    for (let i = 0; i < 15; i++) {
      const ip = `203.0.113.${100 + i}`;
      assert.equal(
        (await login(port, publicWrite({ "cf-connecting-ip": ip }), `wrong password again ${i}`)).status,
        401
      );
    }
    const fresh = await login(port, publicWrite({ "cf-connecting-ip": "192.0.2.77" }));
    assert.equal(fresh.status, 429, "account lock covers a never-seen source");
    assert.equal(fresh.json().error, "locked");
    assert.ok(Number(fresh.headers["retry-after"]) >= 3000, "at least about an hour");
    // A forged or missing CF-Connecting-IP does not get around it.
    for (const ip of ["", "not an ip", "127.0.0.1", "203.0.113.1, 198.51.100.1"]) {
      assert.equal((await login(port, publicWrite({ "cf-connecting-ip": ip }))).status, 429, `ip "${ip}"`);
    }
    // The password-change route is no side door for guessing.
    const change = await call(
      port,
      "POST",
      "/ui/auth/password",
      publicWrite({ cookie: deviceCookie, "x-bastra-csrf": await csrfOf(port, deviceCookie) }),
      JSON.stringify({ current: "guess guess guess guess", next: "another long passphrase" })
    );
    assert.equal(change.status, 429, "password change counts under the same locks");
    // The owner: the device session still works, the Mac still signs in.
    assert.equal((await call(port, "GET", "/ui/graph", tunnel({ cookie: deviceCookie }))).status, 200);
    assert.equal((await login(port, local(port, JSON_TYPE))).status, 200);
  });
});

async function csrfOf(port: number, cookie: string): Promise<string> {
  return String((await call(port, "GET", "/ui/auth/state", tunnel({ cookie }))).json().csrf);
}

test("Abnahme 5: parallel guesses queue one at a time and overflow answers 429 busy", async () => {
  await createAccount();
  await withServer(async (port) => {
    const answers = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        login(port, publicWrite({ "cf-connecting-ip": `198.51.100.${i + 1}` }), `parallel wrong password ${i}`)
      )
    );
    const busy = answers.filter((r) => r.status === 429);
    assert.ok(busy.length >= 1, `some refused: ${answers.map((r) => r.status).join(",")}`);
    for (const r of busy) {
      assert.equal(r.json().error, "busy");
      assert.ok(Number(r.headers["retry-after"]) >= 1);
    }
    assert.ok(answers.every((r) => r.status === 401 || r.status === 429));
    assert.ok(answers.filter((r) => r.status === 401).length <= 5, "at most one running plus four waiting");
  });
});

test("Abnahme 5: at most 30 public attempts a minute, also with the right password", async () => {
  await createAccount();
  await withServer(async (port) => {
    let first429 = -1;
    for (let i = 0; i < 32 && first429 < 0; i++) {
      const res = await login(port, publicWrite({ "cf-connecting-ip": `198.51.100.${i + 1}` }));
      if (res.status === 429) first429 = i;
      else assert.equal(res.status, 200);
    }
    assert.equal(first429, 30, "the 31st attempt in the minute is refused");
  });
});

test("Abnahme 5: known and unknown user name answer with the same text and about the same time", async () => {
  await createAccount();
  await withServer(async (port) => {
    const timed = async (username: string, i: number) => {
      const t0 = performance.now();
      const res = await login(
        port,
        publicWrite({ "cf-connecting-ip": `198.51.100.${i}` }),
        "wrong but long enough pw",
        username
      );
      return { ms: performance.now() - t0, res };
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 4; i++) {
      const a = await timed(USER, 10 + i);
      const b = await timed(`someone-else-${i}`, 20 + i);
      assert.equal(a.res.status, 401);
      assert.equal(b.res.status, 401);
      assert.equal(a.res.body, b.res.body);
      known.push(a.ms);
      unknown.push(b.ms);
    }
    const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
    const [k, u] = [median(known), median(unknown)];
    // Both run one full Argon2id check (~tens of ms); the difference stays far below that.
    assert.ok(Math.abs(k - u) < Math.max(k, u) * 0.5, `known ${k.toFixed(0)} ms, unknown ${u.toFixed(0)} ms`);
  });
});

test("Abnahme 7: no password in clear text — public-ui needs X-Forwarded-Proto https, Secure cookie, HSTS", async () => {
  await createAccount();
  await withServer(async (port) => {
    for (const proto of [undefined, "http", "https, http", "HTTPS", ""]) {
      const headers = publicWrite();
      if (proto === undefined) delete headers["x-forwarded-proto"];
      else headers["x-forwarded-proto"] = proto;
      const res = await login(port, headers);
      assert.equal(res.status, 403, `proto ${JSON.stringify(proto)}`);
      assert.equal(res.headers["set-cookie"], undefined);
      assert.equal((await call(port, "GET", "/ui/login", headers)).status, 403, "no sign-in page over plain http");
    }
    const ok = await login(port, publicWrite());
    assert.equal(ok.status, 200);
    const setCookie = ok.headers["set-cookie"]![0]!;
    assert.match(setCookie, /^__Host-bastra_ui=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Strict; Path=\/$/);
    assert.equal(ok.headers["strict-transport-security"], "max-age=31536000");
    // HSTS also on refusals through the tunnel, never on the Mac's plain http.
    assert.equal(
      (await call(port, "GET", "/ui/graph", tunnel())).headers["strict-transport-security"],
      "max-age=31536000"
    );
    assert.equal(
      (await call(port, "GET", "/ui/auth/state", local(port))).headers["strict-transport-security"],
      undefined
    );
    // Answers with data or the CSRF value are never stored by a cache in between.
    const cookie = cookieOf(ok);
    for (const path of ["/ui/auth/state", "/ui/graph", "/ui/login", "/ui/"]) {
      const res = await call(port, "GET", path, tunnel({ cookie }));
      assert.equal(res.headers["cache-control"], "no-store", path);
    }
  });
});
