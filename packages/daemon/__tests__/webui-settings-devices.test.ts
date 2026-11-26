// Settings › Account and devices (#1198 S7): the real section module in a VM with a fake DOM and a
// scripted settings API, plus the CSRF coverage of the settings page (every write goes through the
// global fetch that auth-client.js wraps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { h, Node_ } from "./webui-report-dom.js";

const app = new URL("../webui/app/", import.meta.url);
const read = (path: string) => readFile(new URL(path, app), "utf8");
const strip = (src: string) => src.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "");
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

const me = {
  id: "s1",
  kind: "browser",
  origin: "local",
  label: "",
  userAgent: "Mozilla/5.0",
  createdAt: 1,
  lastSeenAt: 1_700_000_000_000,
  expiresAt: 1_700_086_400_000,
  current: true,
};
const phone = { ...me, id: "s2", kind: "device", origin: "public", label: "Pixel", current: false };
const data = (extra: Record<string, unknown> = {}) => ({
  account: "present",
  username: "daniel",
  publicOrigin: "https://recall.example.test",
  sessions: [me, phone],
  locks: [],
  ...extra,
});

async function section(first: unknown, after: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const settingsApi = async (path: string, body?: unknown) => {
    calls.push(JSON.parse(JSON.stringify({ path, body: body ?? null })));
    const key = path.replace("/ui/settings/devices", "") || "/";
    const reply = key === "/" ? first : after[key];
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const t = (key: string, vars?: Record<string, unknown>) => (vars ? `${key}${JSON.stringify(vars)}` : key);
  const mod = runInNewContext(`${strip(await read("js/sections/settings-devices.js"))}\n({ devicesBody })`, {
    h,
    clear: (el: Node_) => (el.replaceChildren(), el),
    t,
    addStrings() {},
    loadingInline: (text: string) => h("span", { text }),
    settingsApi,
    en: {},
    de: {},
    Number,
    Date,
    Array,
    Error,
    String,
    Promise,
  }) as { devicesBody: () => Node_ };
  const host = mod.devicesBody();
  await settle();
  const act = (name: string) => host.all().filter((n) => n.attrs["data-act"] === name);
  return { host, calls, act };
}

test("lists account, remote access, sessions and marks the own session; no end button for it", async () => {
  const s = await section(data());
  const text = s.host.textContent;
  assert.ok(text.includes("daniel"));
  assert.ok(text.includes("https://recall.example.test"));
  assert.ok(text.includes("dev.current"), "own session marked");
  assert.ok(text.includes("Pixel"));
  assert.ok(text.includes("dev.kind.device") && text.includes("dev.origin.public"));
  assert.equal(s.act("revoke").length, 1, "only the other session can be ended here");
  assert.equal(s.act("remote-off").length, 1);
  assert.equal(s.act("revoke-others").length, 1);
  assert.equal(s.act("revoke-public").length, 1);
});

test("actions post to their routes and show the fresh answer", async () => {
  const s = await section(data(), {
    "/revoke": data({ sessions: [me] }),
    "/remote-off": data({ publicOrigin: null, sessions: [me] }),
  });
  await s.act("revoke")[0]!.click();
  await settle();
  assert.deepEqual(s.calls[1], { path: "/ui/settings/devices/revoke", body: { id: "s2" } });
  assert.equal(s.act("revoke").length, 0);
  assert.equal(s.act("revoke-public").length, 0, "no internet session left");
  await s.act("remote-off")[0]!.click();
  await settle();
  assert.deepEqual(s.calls[2], { path: "/ui/settings/devices/remote-off", body: {} });
  assert.ok(s.host.textContent.includes("dev.remote.off"));
  assert.equal(s.act("remote-off").length, 0);
  assert.ok(s.host.textContent.includes("dev.remote.hint"), "enabling stays with the CLI");
});

test("locks are shown with failures and can be lifted", async () => {
  const lock = {
    scope: "source",
    source: "203.0.113.0",
    failures: 5,
    lockedUntil: 1_700_000_900_000,
    lastFailureAt: 1,
  };
  const s = await section(
    data({ locks: [lock, { scope: "account", failures: 3, lockedUntil: 0, lastFailureAt: 1 }] }),
    {
      "/unlock": data(),
    }
  );
  assert.ok(s.host.textContent.includes('dev.lock.source{"src":"203.0.113.0"}'));
  assert.ok(s.host.textContent.includes("dev.lock.account"));
  await s.act("unlock")[0]!.click();
  await settle();
  assert.deepEqual(s.calls[1], { path: "/ui/settings/devices/unlock", body: {} });
  assert.equal(s.act("unlock").length, 0);
});

test("without an account: hint with a link to the setup page, no session controls", async () => {
  const s = await section(data({ account: "none", username: undefined, sessions: [], publicOrigin: null }));
  const link = s.host.all().find((n) => n.tagName === "A")!;
  assert.equal(link.attrs.href, "/ui/login");
  assert.equal(s.act("revoke-others").length, 0);
  assert.ok(!s.host.textContent.includes("dev.sessions"));
});

test("an error is shown with a retry", async () => {
  const s = await section(new Error("HTTP 500"));
  assert.ok(s.host.textContent.includes("HTTP 500"));
  assert.ok(s.host.all().some((n) => n.tagName === "BUTTON"));
});

test("section is registered as a settings group with its catalog strings", async () => {
  const model = await read("js/sections/settings-model.js");
  assert.match(model, /id: "devices", keys: \[\], devices: true/);
  assert.match(await read("js/sections/settings.js"), /g\.devices \? devicesBody\(\)/);
});

// ── CSRF coverage of the settings page ──────────────────────────────────────
test("every settings write goes through the global fetch that auth-client.js wraps", async () => {
  // The settings page is an area of the main page (index.html), which loads main.js first, and main.js
  // loads auth-client.js before anything else; the sign-in page does not load the settings.
  const main = await read("js/main.js");
  const firstImport = main.split("\n").find((l) => l.startsWith("import"))!;
  assert.match(firstImport, /auth-client\.js/);
  const index = await read("index.html");
  assert.equal((index.match(/<script[^>]*src=/g) ?? []).length, 1, "one entry point");
  assert.match(index, /js\/main\.js/);
  assert.doesNotMatch(await read("login.html"), /settings/);
  // No settings code sends around the wrapper: no XHR/beacon/saved fetch, no form posts.
  const files = (await readdir(new URL("js/sections/", app))).filter((f) => f.startsWith("settings"));
  for (const file of [...files.map((f) => `js/sections/${f}`), "js/session-client.js"]) {
    const src = await read(file);
    assert.doesNotMatch(src, /XMLHttpRequest|sendBeacon|rawFetch|<form|\.submit\(/, file);
    assert.doesNotMatch(src, /import[^;]*\bfetch\b/, file);
  }
  // jsonRequest, the one writer of settings, calls the global fetch at call time.
  assert.match(await read("js/session-client.js"), /return fetch\(path,/);
});

test("auth-client adds X-Bastra-CSRF to the settings session and every settings write, not to reads", async () => {
  const sent: Array<{ path: string; csrf: string | null }> = [];
  const target: Record<string, unknown> = {
    location: { assign() {}, pathname: "/ui/", search: "", hash: "" },
    fetch: async (path: string, init?: { method?: string; headers?: Headers }) => {
      sent.push({ path, csrf: init?.headers ? new Headers(init.headers).get("X-Bastra-CSRF") : null });
      const body = path === "/ui/auth/state" ? { csrf: "tok" } : {};
      const res = { status: 200, ok: true, json: async () => body, clone: () => res };
      return res;
    },
  };
  const src = strip(await read("js/auth-client.js")).replace(/^installAuthFetch\(\);$/m, "");
  const mod = runInNewContext(`${src}\n({ installAuthFetch })`, { Headers, Set, URL, encodeURIComponent }) as {
    installAuthFetch: (t: unknown) => void;
  };
  mod.installAuthFetch(target);
  const f = target.fetch as (p: string, i?: unknown) => Promise<unknown>;
  await f("/ui/settings/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  await f("/ui/settings", { method: "POST", body: "{}" });
  await f("/ui/settings/devices/revoke", { method: "POST", body: "{}" });
  await f("/ui/assistant-address/refresh", { method: "POST", body: "{}" });
  await f("/ui/settings/devices");
  const writes = sent.filter((s) => s.path !== "/ui/auth/state");
  assert.deepEqual(
    writes.map((s) => s.csrf),
    ["tok", "tok", "tok", "tok", null]
  );
});
