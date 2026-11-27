/**
 * Recall Pulse: the Android app (WebView shell, user-agent token
 * `BastraRecallShell/<version>`) may use /ui only with `ui.android_app` on.
 * Off: 403 before any sign-in or data handling (notice page for pages,
 * `{"error":"pulse-required"}` for the rest). On, or without the token, /ui
 * behaves exactly as before — locally and through the public address.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  JSON_TYPE,
  PASSWORD,
  PUBLIC_ORIGIN,
  USER,
  call,
  createAccount,
  local,
  resetAuth,
  signIn,
  tunnel,
  withServer,
  type Res,
} from "./ui-auth-harness.js";
import { mutateSettings, settingsFilePath } from "../src/settings.js";
import { applySettingChanges } from "../src/settings-registry.js";
import { androidAppWordsIn } from "../src/ui-android-app-words.js";

beforeEach(() => resetAuth());

const SHELL_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/AP4A; wv) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 BastraRecallShell/0.1.0";
const BROWSER_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36";
const HTML = "text/html,application/xhtml+xml";
const COMMAND = "bastra config set ui.android_app true";
const LEAKS = /Body of a1|Title of a1|Summary of a1|daniel|csrf|account/i;

const setSettings = (changes: Record<string, unknown>) =>
  mutateSettings(settingsFilePath(), (current) => applySettingChanges(current, changes));

const loginBody = JSON.stringify({ username: USER, password: PASSWORD, remember: false });

type Door = "public" | "local";
const headersFor = (door: Door, port: number, extra: Record<string, string>) =>
  door === "public" ? tunnel(extra) : local(port, extra);
const writeHeaders = (door: Door, port: number, ua: string) =>
  headersFor(door, port, { ...JSON_TYPE, ...(door === "public" ? { origin: PUBLIC_ORIGIN } : {}), "user-agent": ua });

function assertNotice(res: Res, what: string): void {
  assert.equal(res.status, 403, what);
  assert.match(String(res.headers["content-type"]), /^text\/html/, what);
  assert.equal(res.headers["cache-control"], "no-store", what);
  assert.ok(res.body.includes("Recall Pulse"), `${what}: names Recall Pulse`);
  assert.ok(res.body.includes(COMMAND), `${what}: names the command`);
  assert.ok(!/<script/i.test(res.body), `${what}: no script`);
  assert.doesNotMatch(res.body, LEAKS, `${what}: nothing about the vault or the account`);
  assert.equal(res.headers["set-cookie"], undefined, what);
}

function assertPulseJson(res: Res, what: string): void {
  assert.equal(res.status, 403, what);
  assert.deepEqual(res.json(), { error: "pulse-required" }, what);
  assert.equal(res.headers["set-cookie"], undefined, what);
}

for (const door of ["public", "local"] as const) {
  test(`${door}: the Android app with the switch off gets the notice page or pulse-required, before sign-in`, async () => {
    await createAccount();
    await withServer(async (port) => {
      const get = (path: string, accept: string, extra: Record<string, string> = {}) =>
        call(port, "GET", path, headersFor(door, port, { accept, "user-agent": SHELL_UA, ...extra }));
      for (const path of ["/ui/login", "/ui/", "/ui", "/ui/index.html"]) assertNotice(await get(path, HTML), path);
      for (const path of ["/ui/graph", "/ui/auth/state", "/ui/health", "/ui/js/main.js"])
        assertPulseJson(await get(path, "application/json"), path);
      assertPulseJson(
        await call(port, "POST", "/ui/auth/login", writeHeaders(door, port, SHELL_UA), loginBody),
        "login POST"
      );
      // A valid session from a normal browser does not open the door for the app either.
      const { cookie } = await signIn(port, door);
      assertPulseJson(await get("/ui/graph", "application/json", { cookie }), "graph with a session");
      assertNotice(await get("/ui/", HTML, { cookie }), "/ui/ with a session");
    });
  });

  test(`${door}: without the token, /ui answers exactly as before with the switch off`, async () => {
    await createAccount();
    await withServer(async (port) => {
      for (const ua of [BROWSER_UA, ""]) {
        const extra: Record<string, string> = ua ? { "user-agent": ua } : {};
        const page = await call(port, "GET", "/ui/login", headersFor(door, port, { accept: HTML, ...extra }));
        assert.equal(page.status, 200, `login page (${ua || "no UA"})`);
        const data = await call(
          port,
          "GET",
          "/ui/graph",
          headersFor(door, port, { accept: "application/json", ...extra })
        );
        assert.equal(data.status, 401, `graph without session (${ua || "no UA"})`);
      }
      const login = await call(port, "POST", "/ui/auth/login", writeHeaders(door, port, BROWSER_UA), loginBody);
      assert.equal(login.status, 200);
      assert.ok(login.headers["set-cookie"]);
    });
  });

  test(`${door}: with the switch on, the Android app behaves like a browser`, async () => {
    await createAccount();
    await withServer(async (port) => {
      await setSettings({ "ui.android_app": true });
      const page = await call(
        port,
        "GET",
        "/ui/login",
        headersFor(door, port, { accept: HTML, "user-agent": SHELL_UA })
      );
      assert.equal(page.status, 200);
      const nav = await call(port, "GET", "/ui/", headersFor(door, port, { accept: HTML, "user-agent": SHELL_UA }));
      assert.equal(nav.status, 302, "to the sign-in page as for any browser");
      const login = await call(port, "POST", "/ui/auth/login", writeHeaders(door, port, SHELL_UA), loginBody);
      assert.equal(login.status, 200);
      const cookie = String(login.headers["set-cookie"]?.[0]).split(";", 1)[0]!;
      const graph = await call(port, "GET", "/ui/graph", headersFor(door, port, { "user-agent": SHELL_UA, cookie }));
      assert.equal(graph.status, 200);
    });
  });
}

test("local without an account: the Mac's web UI stays open in a browser, the app is still refused", async () => {
  await withServer(async (port) => {
    assert.equal((await call(port, "GET", "/ui/graph", local(port, { "user-agent": BROWSER_UA }))).status, 200);
    assertPulseJson(await call(port, "GET", "/ui/graph", local(port, { "user-agent": SHELL_UA })), "graph");
  });
});

test("the notice page follows language.primary like the sign-in page", async () => {
  await withServer(async (port) => {
    await setSettings({ "language.primary": "de" });
    const res = await call(port, "GET", "/ui/login", tunnel({ accept: HTML, "user-agent": SHELL_UA }));
    assert.equal(res.status, 403);
    assert.match(res.body, /<html lang="de">/);
    assert.ok(res.body.includes(androidAppWordsIn("de").heading));
    assert.ok(res.body.includes(COMMAND));
  });
});

test("the notice words: English and German complete, English for an unset or unlisted language", () => {
  const en = androidAppWordsIn(undefined);
  const de = androidAppWordsIn("de");
  assert.equal(androidAppWordsIn("ru"), en);
  assert.deepEqual(Object.keys(de), Object.keys(en));
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    assert.ok(en[key].trim() && de[key].trim(), key);
    assert.notEqual(de[key], en[key], key);
  }
});
