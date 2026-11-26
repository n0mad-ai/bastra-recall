/**
 * #1198 S7 — device management in the settings: the list carries no hashes, a
 * revoke works at once on a test cookie, "remote off" clears ui.public_origin
 * and ends public sessions, the tunnel never reaches the routes, and without a
 * UI session the routes answer 401.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  JSON_TYPE,
  PUBLIC_ORIGIN,
  call,
  createAccount,
  local,
  resetAuth,
  signIn,
  tunnel,
  withServer,
  type Res,
} from "./ui-auth-harness.js";
import { getUiPublicOrigin } from "../src/settings.js";
import { uiAuthStores } from "../src/ui-auth-stores.js";

beforeEach(() => resetAuth());

/** A signed-in Mac browser with its own settings session: [UI cookie + CSRF] and [settings cookie + CSRF]. */
async function macClient(port: number) {
  const ui = await signIn(port, "local");
  const base = (extra: Record<string, string> = {}) => local(port, { cookie: ui.cookie, ...extra });
  const opened = await call(
    port,
    "POST",
    "/ui/settings/session",
    base({ ...JSON_TYPE, "x-bastra-csrf": ui.csrf }),
    "{}"
  );
  assert.equal(opened.status, 200, opened.body);
  const settingsCookie = opened.headers["set-cookie"]![0]!.split(";", 1)[0]!;
  const settingsCsrf = String(opened.json().csrf);
  const cookie = `${ui.cookie}; ${settingsCookie}`;
  return {
    ui,
    get: (path: string) => call(port, "GET", path, local(port, { cookie })),
    post: (path: string, body: unknown = {}) =>
      call(
        port,
        "POST",
        path,
        local(port, {
          cookie,
          ...JSON_TYPE,
          "x-bastra-csrf": ui.csrf,
          "x-bastra-settings-csrf": settingsCsrf,
        }),
        JSON.stringify(body)
      ),
  };
}

const sessionsOf = (res: Res) => res.json().sessions as Array<Record<string, unknown>>;

test("list: account, remote access, sessions without hashes, own session marked", async () => {
  await createAccount();
  await withServer(async (port) => {
    await signIn(port, "public", true);
    const mac = await macClient(port);
    const res = await mac.get("/ui/settings/devices");
    assert.equal(res.status, 200, res.body);
    const body = res.json();
    assert.equal(body.account, "present");
    assert.equal(body.username, "daniel");
    assert.equal(body.publicOrigin, PUBLIC_ORIGIN);
    const sessions = sessionsOf(res);
    assert.equal(sessions.length, 2);
    assert.equal(sessions.filter((s) => s.current).length, 1);
    assert.equal(sessions.find((s) => s.current)!.origin, "local");
    assert.equal(sessions.find((s) => !s.current)!.kind, "device");
    for (const s of sessions)
      assert.deepEqual(Object.keys(s).sort(), [
        "createdAt",
        "current",
        "expiresAt",
        "id",
        "kind",
        "label",
        "lastSeenAt",
        "origin",
        "userAgent",
      ]);
    assert.doesNotMatch(res.body, /token|hash|password/i);
    assert.doesNotMatch(res.body, new RegExp(mac.ui.cookie.split("=")[1]!));
  });
});

test("revoke acts at once on the test cookie; others and public sessions can be ended in bulk", async () => {
  await createAccount();
  await withServer(async (port) => {
    const pub = await signIn(port, "public");
    const other = await signIn(port, "local");
    const mac = await macClient(port);
    const stillIn = (cookie: string, access: "public" | "local") =>
      call(
        port,
        "GET",
        "/ui/auth/state",
        access === "public" ? tunnel({ cookie: `__Host-${cookie}` }) : local(port, { cookie })
      );
    assert.equal((await stillIn(other.cookie, "local")).json().authenticated, true);
    const listed = sessionsOf(await mac.get("/ui/settings/devices"));
    // End the internet session by its handle.
    const publicId = listed.find((s) => s.origin === "public")!.id;
    const gone = await mac.post("/ui/settings/devices/revoke", { id: publicId });
    assert.equal(gone.status, 200, gone.body);
    assert.equal(sessionsOf(gone).length, 2);
    const publicCookie = pub.cookie;
    const check = await call(port, "GET", "/ui/health", tunnel({ cookie: publicCookie }));
    assert.equal(check.status, 401, "revoked public cookie is dead");
    // All others.
    const others = await mac.post("/ui/settings/devices/revoke-others");
    assert.equal(others.status, 200, others.body);
    assert.equal(sessionsOf(others).length, 1);
    assert.equal(sessionsOf(others)[0]!.current, true);
    assert.equal((await stillIn(other.cookie, "local")).json().authenticated, false);
    assert.equal((await mac.get("/ui/settings/devices")).status, 200, "own session stays");
  });
});

test("remote off clears ui.public_origin and ends public sessions only", async () => {
  await createAccount();
  await withServer(async (port) => {
    const pub = await signIn(port, "public");
    const mac = await macClient(port);
    assert.equal(await getUiPublicOrigin(), PUBLIC_ORIGIN);
    const res = await mac.post("/ui/settings/devices/remote-off");
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json().publicOrigin, null);
    assert.equal(await getUiPublicOrigin(), "");
    assert.equal(sessionsOf(res).length, 1);
    assert.equal(sessionsOf(res)[0]!.origin, "local");
    // The tunnel host is no longer a public UI.
    assert.notEqual((await call(port, "GET", "/ui/health", tunnel({ cookie: pub.cookie }))).status, 200);
    assert.equal((await mac.get("/ui/settings/devices")).status, 200);
  });
});

test("locks: shown with failures and unlocked on request", async () => {
  await createAccount();
  await withServer(async (port) => {
    const mac = await macClient(port);
    for (let i = 0; i < 6; i++)
      await call(
        port,
        "POST",
        "/ui/auth/login",
        tunnel({ ...JSON_TYPE, origin: PUBLIC_ORIGIN }),
        JSON.stringify({ username: "daniel", password: "wrong password here", remember: false })
      );
    const res = await mac.get("/ui/settings/devices");
    const locks = res.json().locks as Array<Record<string, unknown>>;
    assert.ok(
      locks.some((l) => l.scope === "account" && Number(l.failures) > 0),
      res.body
    );
    assert.ok(
      locks.some((l) => l.scope === "source" && Number(l.lockedUntil) > 0),
      res.body
    );
    const cleared = await mac.post("/ui/settings/devices/unlock");
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.json().locks, []);
    assert.deepEqual(uiAuthStores()!.throttle.status(), []);
  });
});

test("input is checked; unknown actions are 404", async () => {
  await createAccount();
  await withServer(async (port) => {
    const mac = await macClient(port);
    assert.equal((await mac.post("/ui/settings/devices/revoke", {})).status, 400);
    assert.equal((await mac.post("/ui/settings/devices/revoke", { id: 5 })).status, 400);
    assert.equal((await mac.post("/ui/settings/devices/unlock", { x: 1 })).status, 400);
    assert.equal((await mac.post("/ui/settings/devices/nothing")).status, 404);
  });
});

test("without a UI session 401, through the public host always 403 (also with a session)", async () => {
  await createAccount();
  await withServer(async (port) => {
    const mac = await macClient(port);
    assert.equal((await call(port, "GET", "/ui/settings/devices", local(port))).status, 401);
    assert.equal((await call(port, "POST", "/ui/settings/devices/unlock", local(port, JSON_TYPE), "{}")).status, 401);
    const pub = await signIn(port, "public");
    for (const [method, path] of [
      ["GET", "/ui/settings/devices"],
      ["POST", "/ui/settings/devices/revoke"],
      ["POST", "/ui/settings/devices/revoke-others"],
      ["POST", "/ui/settings/devices/revoke-public"],
      ["POST", "/ui/settings/devices/unlock"],
      ["POST", "/ui/settings/devices/remote-off"],
    ] as const) {
      for (const cookie of [undefined, pub.cookie]) {
        const res = await call(
          port,
          method,
          path,
          tunnel({ ...JSON_TYPE, origin: PUBLIC_ORIGIN, ...(cookie ? { cookie, "x-bastra-csrf": pub.csrf } : {}) }),
          method === "POST" ? "{}" : undefined
        );
        assert.equal(res.status, 403, `${method} ${path} ${cookie ? "with" : "without"} session`);
      }
    }
    assert.equal((await mac.get("/ui/settings/devices")).status, 200, "local settings session unaffected");
  });
});

test("without an account the list is empty and offers account creation", async () => {
  await withServer(async (port) => {
    const opened = await call(port, "POST", "/ui/settings/session", local(port, JSON_TYPE), "{}");
    const cookie = opened.headers["set-cookie"]![0]!.split(";", 1)[0]!;
    const res = await call(port, "GET", "/ui/settings/devices", local(port, { cookie }));
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json().account, "none");
    assert.deepEqual(res.json().sessions, []);
  });
});
