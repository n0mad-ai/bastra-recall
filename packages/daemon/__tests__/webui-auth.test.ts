// Web UI sign-in (#1198): the login page (js/login.js), the shared request rules (js/auth-client.js:
// CSRF header, 401 redirect, 403 retry), the header's account entry (js/account-menu.js) and login.html.
// The real modules run in a VM context with a fake DOM and a scripted daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { h, Node_ } from "./webui-report-dom.js";

const app = new URL("../webui/app/", import.meta.url);
const read = (path: string) => readFile(new URL(path, app), "utf8");
const strip = (src: string) => src.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "");
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

type Reply = { status: number; body?: unknown } | "network";
type Init = { method?: string; credentials?: string; headers?: Headers | Record<string, string>; body?: string };
type Call = { path: string; init?: Init };

/** A scripted daemon: replies per path in order; the last reply of a path repeats. */
function daemon(script: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const fetch = async (path: string, init?: Init) => {
    calls.push({ path, init });
    const queue = script[path.split("?")[0]!] ?? [];
    const reply = queue.length > 1 ? queue.shift()! : (queue[0] ?? { status: 200, body: {} });
    if (reply === "network") throw new TypeError("Failed to fetch");
    const res = { status: reply.status, ok: reply.status < 400, json: async () => reply.body, clone: () => res };
    return res;
  };
  return { fetch, calls };
}

const ORIGIN = "http://127.0.0.1:6723";

// ── login page ───────────────────────────────────────────────────────────────
async function loginPage(search: string, script: Record<string, Reply[]>) {
  const root = h("main", null);
  const d = daemon(script);
  const where: string[] = [];
  const ctx = runInNewContext(`${strip(await read("js/login.js"))}`, {
    h,
    clear: (el: Node_) => (el.replaceChildren(), el),
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}${JSON.stringify(vars)}` : key),
    document: { getElementById: () => root, title: "" },
    location: { search, origin: ORIGIN, replace: (u: string) => where.push(u) },
    fetch: d.fetch,
    URL,
    URLSearchParams,
    JSON,
    Number,
    Promise,
    TypeError,
  });
  void ctx;
  await settle();
  const form = () => root.all().find((n) => n.tagName === "FORM")!;
  const text = (cls: string) => root.find(cls)[0]?.textContent ?? "";
  return {
    root,
    where,
    calls: d.calls,
    posts: () =>
      d.calls
        .filter((c) => c.init?.method === "POST")
        .map((c) => ({ path: c.path, body: JSON.parse(c.init?.body ?? "null") })),
    status: () => text("auth__status"),
    title: () => text("dlg__title"),
    fill(values: string[]) {
      const inputs = root.find("auth__in");
      values.forEach((v, i) => (inputs[i]!.value = v));
    },
    check: (on: boolean) => {
      Object.assign(
        root.all().find((n) => n.attrs.id === "remember")!,
        { checked: on }
      );
    },
    async submit() {
      await form().listeners.submit![0]!({ preventDefault() {} });
      await settle();
    },
    inputs: () => root.find("auth__in").map((n) => n.attrs),
    forms: () => root.all().filter((n) => n.tagName === "FORM").length,
  };
}

const PRESENT = {
  status: 200,
  body: { account: "present", authenticated: false, access: "local", setupAllowed: false },
};

test("login: the form has labelled fields with the right autocomplete values", async () => {
  const p = await loginPage("", { "/ui/auth/state": [PRESENT] });
  assert.equal(p.title(), "auth.title");
  assert.deepEqual(
    p.inputs().map((a) => [a.name, a.type, a.autocomplete]),
    [
      ["username", "text", "username"],
      ["password", "password", "current-password"],
    ]
  );
  const labels = p.root.find("auth__label").map((n) => n.attrs.for);
  assert.deepEqual(labels, ["username", "password"]);
  assert.ok(p.root.find("auth__remember").length === 1, "the stay-signed-in checkbox is there");
  assert.equal(p.root.find("auth__status")[0]!.attrs["aria-live"], "polite");
});

test("login: success posts the credentials and goes to next", async () => {
  const p = await loginPage("?next=%2Fui%2F%23%2Fvault", {
    "/ui/auth/state": [PRESENT],
    "/ui/auth/login": [{ status: 200, body: { ok: true } }],
  });
  p.fill(["daniel", "correct horse battery"]);
  p.check(true);
  await p.submit();
  assert.deepEqual(p.posts(), [
    { path: "/ui/auth/login", body: { username: "daniel", password: "correct horse battery", remember: true } },
  ]);
  assert.deepEqual(p.where, ["/ui/#/vault"]);
});

const LOGIN_ERRORS: [string, Reply, string][] = [
  ["wrong credentials", { status: 401, body: { error: "invalid-credentials" } }, "auth.err.invalid"],
  [
    "locked with a wait",
    { status: 429, body: { error: "locked", retryAfterSeconds: 900 } },
    'auth.err.locked{"time":"auth.wait.minutes{\\"n\\":15}"}',
  ],
  [
    "locked, seconds",
    { status: 429, body: { error: "locked", retryAfterSeconds: 30 } },
    'auth.err.locked{"time":"auth.wait.seconds{\\"n\\":30}"}',
  ],
  [
    "locked, hours",
    { status: 429, body: { error: "locked", retryAfterSeconds: 7200 } },
    'auth.err.locked{"time":"auth.wait.hours{\\"n\\":2}"}',
  ],
  [
    "busy with a wait",
    { status: 429, body: { error: "busy", retryAfterSeconds: 3 } },
    'auth.err.busy{"time":"auth.wait.seconds{\\"n\\":3}"}',
  ],
  ["locked without a wait", { status: 429, body: { error: "locked" } }, "auth.err.lockedNow"],
  ["account damaged", { status: 503, body: { error: "account-damaged" } }, "auth.err.damaged"],
  ["server not reachable", "network", "auth.err.network"],
  ["unexpected answer", { status: 500, body: "x" }, "auth.err.generic"],
];
for (const [name, reply, message] of LOGIN_ERRORS)
  test(`login: ${name} shows a readable message and keeps the page usable`, async () => {
    const p = await loginPage("", { "/ui/auth/state": [PRESENT], "/ui/auth/login": [reply] });
    p.fill(["daniel", "pw"]);
    await p.submit();
    assert.equal(p.status(), message);
    assert.deepEqual(p.where, []);
    assert.equal(p.root.find("auth__submit")[0]!.disabled, false, "the button works again");
    assert.equal(p.root.find("auth__status")[0]!.classList.contains("is-err"), true);
  });

test("login: 409 (account vanished) reloads the state and shows what applies now", async () => {
  const p = await loginPage("", {
    "/ui/auth/state": [PRESENT, { status: 200, body: { account: "none", authenticated: false, setupAllowed: true } }],
    "/ui/auth/login": [{ status: 409, body: { error: "no-account" } }],
  });
  await p.submit();
  assert.equal(p.title(), "auth.setup.title");
});

test("login: an already signed-in visitor goes straight on", async () => {
  const p = await loginPage("?next=%2Fui%2Ftasks", {
    "/ui/auth/state": [{ status: 200, body: { account: "present", authenticated: true, access: "local" } }],
  });
  assert.deepEqual(p.where, ["/ui/tasks"]);
  assert.equal(p.forms(), 0);
});

test("login: state not reachable offers a retry, a damaged account blocks the form", async () => {
  const down = await loginPage("", { "/ui/auth/state": ["network"] });
  assert.equal(down.forms(), 0);
  assert.equal(down.root.find("dlg__text")[0]!.textContent, "auth.err.network");
  assert.equal(down.root.all().filter((n) => n.tagName === "BUTTON").length, 1, "retry button");
  const bad = await loginPage("", {
    "/ui/auth/state": [{ status: 200, body: { account: "damaged", authenticated: false } }],
  });
  assert.equal(bad.forms(), 0);
  assert.equal(bad.root.find("dlg__text")[0]!.textContent, "auth.err.damaged");
});

// ── setup ────────────────────────────────────────────────────────────────────
const NONE_LOCAL = {
  status: 200,
  body: { account: "none", authenticated: false, access: "local", setupAllowed: true },
};

test("setup: without an account, where it is allowed, the page shows the setup form", async () => {
  const p = await loginPage("", { "/ui/auth/state": [NONE_LOCAL] });
  assert.equal(p.title(), "auth.setup.title");
  assert.deepEqual(
    p.inputs().map((a) => [a.name, a.autocomplete]),
    [
      ["username", "username"],
      ["password", "new-password"],
      ["password2", "new-password"],
    ]
  );
  assert.ok(p.root.find("dlg__hint")[0]!.textContent.includes("auth.setup.hint"));
});

test("setup: success creates the account and goes to next", async () => {
  const p = await loginPage("", {
    "/ui/auth/state": [NONE_LOCAL],
    "/ui/auth/setup": [{ status: 200, body: { ok: true } }],
  });
  p.fill(["daniel", "a long enough password", "a long enough password"]);
  await p.submit();
  assert.deepEqual(p.posts(), [
    { path: "/ui/auth/setup", body: { username: "daniel", password: "a long enough password" } },
  ]);
  assert.deepEqual(p.where, ["/ui/"]);
});

const SETUP_ERRORS: [string, Reply, string][] = [
  ["too short", { status: 400, body: { error: "invalid-password", problem: "too-short" } }, "auth.pw.too-short"],
  ["too long", { status: 400, body: { error: "invalid-password", problem: "too-long" } }, "auth.pw.too-long"],
  ["not text", { status: 400, body: { error: "invalid-password", problem: "not-text" } }, "auth.pw.not-text"],
  ["unknown problem", { status: 400, body: { error: "invalid-password", problem: "?" } }, "auth.pw.invalid"],
  ["bad username", { status: 400, body: { error: "invalid-username", problem: "x" } }, "auth.setup.badUsername"],
  ["not reachable", "network", "auth.err.network"],
  ["forbidden", { status: 403, body: {} }, "auth.err.generic"],
];
for (const [name, reply, message] of SETUP_ERRORS)
  test(`setup: ${name} shows its message`, async () => {
    const p = await loginPage("", { "/ui/auth/state": [NONE_LOCAL], "/ui/auth/setup": [reply] });
    p.fill(["daniel", "pw", "pw"]);
    await p.submit();
    assert.equal(p.status(), message);
    assert.deepEqual(p.where, []);
  });

test("setup: two different passwords are not sent", async () => {
  const p = await loginPage("", { "/ui/auth/state": [NONE_LOCAL] });
  p.fill(["daniel", "one", "two"]);
  await p.submit();
  assert.equal(p.status(), "auth.setup.mismatch");
  assert.deepEqual(p.posts(), []);
});

test("setup: an account that appeared meanwhile (409) leads to the sign-in with a note", async () => {
  const p = await loginPage("", {
    "/ui/auth/state": [NONE_LOCAL, PRESENT],
    "/ui/auth/setup": [{ status: 409, body: { error: "account-exists" } }],
  });
  p.fill(["daniel", "pw", "pw"]);
  await p.submit();
  assert.equal(p.title(), "auth.title");
  assert.equal(p.status(), "auth.setup.exists");
});

test("setup: no account and setup not allowed (over the internet) shows only the hint", async () => {
  const p = await loginPage("", {
    "/ui/auth/state": [
      { status: 200, body: { account: "none", authenticated: false, access: "public", setupAllowed: false } },
    ],
  });
  assert.equal(p.forms(), 0);
  assert.equal(p.title(), "auth.setup.remoteTitle");
  assert.equal(p.root.find("dlg__text")[0]!.textContent, "auth.setup.remoteText");
  assert.deepEqual(p.posts(), []);
});

// ── next ─────────────────────────────────────────────────────────────────────
const NEXT: [string, string | null, string][] = [
  ["a /ui/ page", "/ui/tasks", "/ui/tasks"],
  ["with query and hash", "/ui/?q=a%20b#/vault", "/ui/?q=a%20b#/vault"],
  ["missing", null, "/ui/"],
  ["empty", "", "/ui/"],
  ["another path", "/api/v1/memories", "/ui/"],
  ["just /ui without slash", "/ui", "/ui/"],
  ["absolute URL", "https://evil.example/ui/", "/ui/"],
  ["protocol-relative", "//evil.example/ui/", "/ui/"],
  ["double slash inside", "/ui//evil.example", "/ui/"],
  ["slash-backslash", "/\\evil.example", "/ui/"],
  ["backslash after /ui/", "/ui/\\evil.example", "/ui/"],
  ["backslash first", "\\\\evil.example", "/ui/"],
  ["javascript scheme", "javascript:alert(1)", "/ui/"],
  ["data scheme", "data:text/html,x", "/ui/"],
  ["scheme in front of path", "https:/ui/", "/ui/"],
  ["leading space", " /ui/x", "/ui/"],
  ["tab inside the slashes", "/ui/\t/evil.example", "/ui/"],
  ["newline", "/ui/x\n/evil", "/ui/"],
  ["dot segments out of /ui/", "/ui/../api/v1/memories", "/ui/"],
  ["dot segments staying in /ui/", "/ui/a/../tasks", "/ui/tasks"],
  ["back to the sign-in page", "/ui/login?next=/ui/", "/ui/"],
  ["auth routes", "/ui/auth/state", "/ui/"],
  ["different case", "/UI/tasks", "/ui/"],
];
for (const [name, value, expected] of NEXT)
  test(`login: next is handled safely (${name})`, async () => {
    const search = value === null ? "" : `?next=${encodeURIComponent(value)}`;
    const p = await loginPage(search, {
      "/ui/auth/state": [PRESENT],
      "/ui/auth/login": [{ status: 200, body: { ok: true } }],
    });
    p.fill(["daniel", "pw"]);
    await p.submit();
    assert.deepEqual(p.where, [expected]);
  });

// ── request rules (CSRF header, 401 redirect, 403 retry) ─────────────────────
async function client(script: Record<string, Reply[]>, loc = { pathname: "/ui/", search: "", hash: "" }) {
  const d = daemon(script);
  const assigned: string[] = [];
  const sandbox: Record<string, unknown> = {
    fetch: d.fetch,
    Headers,
    JSON,
    Promise,
    Set,
    TypeError,
    location: {
      ...loc,
      assigned,
      assign: (u: string) => assigned.push(u),
    },
  };
  runInNewContext(strip(await read("js/auth-client.js")), sandbox);
  const f = sandbox.fetch as (p: string, i?: Init) => Promise<{ status: number }>;
  const csrfOf = (c: Call) => (c.init?.headers instanceof Headers ? c.init.headers.get("x-bastra-csrf") : null);
  return {
    f,
    calls: d.calls,
    csrfOf,
    assigned: () => assigned,
    stateCalls: () => d.calls.filter((c) => c.path === "/ui/auth/state").length,
  };
}
const STATE = (csrf: string): Reply => ({ status: 200, body: { account: "present", authenticated: true, csrf } });
const WRITE = {
  method: "POST",
  credentials: "same-origin",
  headers: { "Content-Type": "application/json" },
  body: "{}",
};

test("requests: every write to /ui carries X-Bastra-CSRF from the state, fetched once", async () => {
  const c = await client({ "/ui/auth/state": [STATE("c1")], "/ui/annotate": [{ status: 200 }] });
  for (const [path, method] of [
    ["/ui/annotate", "POST"],
    ["/ui/backdrop/x", "DELETE"],
    ["/ui/areas", "PUT"],
    ["/ui/x", "PATCH"],
  ])
    await c.f(path!, { ...WRITE, method });
  const writes = c.calls.filter((x) => x.path !== "/ui/auth/state");
  assert.equal(writes.length, 4);
  assert.deepEqual(writes.map(c.csrfOf), ["c1", "c1", "c1", "c1"]);
  assert.equal(c.stateCalls(), 1);
  assert.equal((writes[0]!.init!.headers as Headers).get("content-type"), "application/json", "other headers stay");
  assert.equal(writes[0]!.init?.body, "{}");
});

test("requests: reads, foreign hosts and the sign-in routes get no CSRF header and no state fetch", async () => {
  const c = await client({});
  await c.f("/ui/graph");
  await c.f("/ui/search?q=a", { credentials: "same-origin" });
  await c.f("https://api.open-meteo.com/v1/forecast", { credentials: "omit" });
  await c.f("/ui/auth/login", WRITE);
  await c.f("/ui/auth/setup", WRITE);
  assert.equal(c.stateCalls(), 0);
  assert.deepEqual(c.calls.map(c.csrfOf), [null, null, null, null, null]);
});

test("requests: no state answer means the write goes out unchanged", async () => {
  const c = await client({ "/ui/auth/state": ["network"] });
  await c.f("/ui/annotate", WRITE);
  assert.equal(c.calls.at(-1)!.init, WRITE);
});

test("requests: 401 auth-required sends the page to the sign-in once, with the current page as next", async () => {
  const c = await client(
    {
      "/ui/graph": [{ status: 401, body: { error: "auth-required" } }],
      "/ui/health": [{ status: 401, body: { error: "auth-required" } }],
    },
    { pathname: "/ui/", search: "?a=1", hash: "#/vault" }
  );
  assert.equal((await c.f("/ui/graph")).status, 401, "the caller still sees the answer");
  await c.f("/ui/health");
  assert.deepEqual(c.assigned(), ["/ui/login?next=%2Fui%2F%3Fa%3D1%23%2Fvault"]);
});

test("requests: a page outside /ui/ returns to /ui/ after the sign-in", async () => {
  const c = await client(
    { "/ui/graph": [{ status: 401, body: { error: "auth-required" } }] },
    { pathname: "/", search: "", hash: "" }
  );
  await c.f("/ui/graph");
  assert.deepEqual(c.assigned(), ["/ui/login?next=%2Fui%2F"]);
});

test("requests: other 401/403 answers do not redirect", async () => {
  const c = await client({
    "/ui/auth/password": [{ status: 401, body: { error: "invalid-credentials" } }],
    "/ui/settings/x": [{ status: 403, body: { error: "local-only" } }],
    "/ui/x": [{ status: 401, body: "not json" }],
    "/ui/auth/state": [STATE("c1")],
  });
  await c.f("/ui/auth/password", WRITE);
  await c.f("/ui/settings/x", WRITE);
  await c.f("/ui/x");
  assert.deepEqual(c.assigned(), []);
  assert.equal(c.calls.filter((x) => x.path === "/ui/settings/x").length, 1, "no retry for local-only");
});

test("requests: 403 csrf reloads the state and repeats the request once", async () => {
  const c = await client({
    "/ui/auth/state": [STATE("old"), STATE("new")],
    "/ui/annotate": [
      { status: 403, body: { error: "csrf" } },
      { status: 200, body: { ok: true } },
    ],
  });
  assert.equal((await c.f("/ui/annotate", WRITE)).status, 200);
  const sent = c.calls.filter((x) => x.path === "/ui/annotate");
  assert.deepEqual(sent.map(c.csrfOf), ["old", "new"]);
  assert.equal(c.stateCalls(), 2);
});

test("requests: a second csrf rejection is returned, not retried again", async () => {
  const c = await client({
    "/ui/auth/state": [STATE("a"), STATE("b")],
    "/ui/annotate": [{ status: 403, body: { error: "csrf" } }],
  });
  assert.equal((await c.f("/ui/annotate", WRITE)).status, 403);
  assert.equal(c.calls.filter((x) => x.path === "/ui/annotate").length, 2);
});

test("main.js loads the request rules before anything else", async () => {
  const main = await read("js/main.js");
  const firstImport = /^import .*$/m.exec(main)![0];
  assert.match(firstImport, /auth-client\.js/);
});

// ── account entry in the header ──────────────────────────────────────────────
async function account(state: unknown, script: Record<string, Reply[]> = {}) {
  const d = daemon(script);
  const refreshed: number[] = [];
  const where: string[] = [];
  let dialogBody: Node_ | null = null;
  const dlgBtn = (text: string, onClick: () => unknown, cls = "") => h("button", { cls, text, on: { click: onClick } });
  const sandbox = {
    h,
    clear: (el: Node_) => (el.replaceChildren(), el),
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}${JSON.stringify(vars)}` : key),
    authState: async () => state,
    refreshAuthState: async () => void refreshed.push(1),
    dialog: () => ({ body: (dialogBody = h("div", null)), close() {} }),
    btn: dlgBtn,
    status: () => h("span", null),
    setStatus: (el: Node_, text: string, kind = "") => {
      el.textContent = text;
      el.attrs.kind = kind;
    },
    fetch: d.fetch,
    location: { assign: (u: string) => where.push(u) },
    JSON,
    Promise,
    Array,
  };
  const mod = runInNewContext(`${strip(await read("js/account-menu.js"))}\n({ mountAccount })`, sandbox) as {
    mountAccount: () => Node_;
  };
  const slot = mod.mountAccount();
  await settle();
  const button = (text: string) => dialogBody!.all().find((n) => n.tagName === "BUTTON" && n.textContent === text)!;
  return { slot, d, refreshed, where, body: () => dialogBody!, button };
}

test("account entry: signed in shows the name and, in the dialog, sign-out, sign-out everywhere, change password", async () => {
  const a = await account(
    { account: "present", authenticated: true, username: "daniel", csrf: "c" },
    {
      "/ui/auth/logout": [{ status: 200, body: { ok: true } }],
      "/ui/auth/logout-all": [{ status: 200, body: { ok: true } }],
    }
  );
  const open = a.slot.find("acct__btn")[0]!;
  assert.equal(open.textContent, "daniel");
  await open.click();
  assert.ok(a.body().textContent.includes('auth.menu.signedInAs{"name":"daniel"}'));
  await a.button("auth.menu.logout").click();
  assert.deepEqual(
    a.d.calls.map((c) => c.path),
    ["/ui/auth/logout"]
  );
  assert.deepEqual(a.where, ["/ui/login"]);
  await a.button("auth.menu.logoutAll").click();
  assert.deepEqual(
    a.d.calls.map((c) => c.path),
    ["/ui/auth/logout", "/ui/auth/logout-all"]
  );
});

test("account entry: a failed sign-out stays on the page with a message", async () => {
  const a = await account(
    { account: "present", authenticated: true, username: "d", csrf: "c" },
    {
      "/ui/auth/logout": ["network"],
    }
  );
  await a.slot.find("acct__btn")[0]!.click();
  await a.button("auth.menu.logout").click();
  assert.deepEqual(a.where, []);
  assert.equal(a.body().find("kind")[0] ?? null, null);
  assert.ok(
    a
      .body()
      .all()
      .some((n) => n.textContent === "auth.err.network")
  );
});

test("account entry: changing the password sends current and new, then reloads the state and stays signed in", async () => {
  const a = await account(
    { account: "present", authenticated: true, username: "d", csrf: "c" },
    {
      "/ui/auth/password": [{ status: 200, body: { ok: true } }],
    }
  );
  await a.slot.find("acct__btn")[0]!.click();
  await a.button("auth.menu.password").click();
  const form = a
    .body()
    .all()
    .find((n) => n.tagName === "FORM")!;
  const inputs = form.all().filter((n) => n.tagName === "INPUT");
  assert.deepEqual(
    inputs.map((n) => n.attrs.autocomplete),
    ["current-password", "new-password", "new-password"]
  );
  assert.deepEqual(
    form
      .all()
      .filter((n) => n.tagName === "LABEL")
      .map((n) => n.attrs.for),
    inputs.map((n) => n.attrs.id)
  );
  inputs[0]!.value = "old password value";
  inputs[1]!.value = "new password value";
  inputs[2]!.value = "new password value";
  await form.listeners.submit![0]!({ preventDefault() {} });
  await settle();
  assert.deepEqual(JSON.parse(a.d.calls[0]!.init?.body ?? "null"), {
    current: "old password value",
    next: "new password value",
  });
  assert.equal(a.refreshed.length, 1);
  assert.deepEqual(a.where, [], "no redirect: the session goes on");
  assert.ok(
    a
      .body()
      .all()
      .some((n) => n.textContent === "auth.pwchange.done")
  );
  assert.equal(inputs[1]!.value, "", "the fields are cleared");
});

const PW_ERRORS: [string, Reply, string][] = [
  ["wrong current password", { status: 401, body: { error: "invalid-credentials" } }, "auth.pwchange.wrong"],
  ["too short", { status: 400, body: { error: "invalid-password", problem: "too-short" } }, "auth.pw.too-short"],
  ["not reachable", "network", "auth.err.network"],
];
for (const [name, reply, message] of PW_ERRORS)
  test(`account entry: password change, ${name}`, async () => {
    const a = await account(
      { account: "present", authenticated: true, username: "d", csrf: "c" },
      { "/ui/auth/password": [reply] }
    );
    await a.slot.find("acct__btn")[0]!.click();
    await a.button("auth.menu.password").click();
    const form = a
      .body()
      .all()
      .find((n) => n.tagName === "FORM")!;
    form
      .all()
      .filter((n) => n.tagName === "INPUT")
      .forEach((n) => (n.value = "x"));
    await form.listeners.submit![0]!({ preventDefault() {} });
    await settle();
    assert.ok(
      a
        .body()
        .all()
        .some((n) => n.textContent === message),
      message
    );
    assert.equal(a.refreshed.length, 0);
  });

test("account entry: two different new passwords are not sent", async () => {
  const a = await account({ account: "present", authenticated: true, username: "d", csrf: "c" });
  await a.slot.find("acct__btn")[0]!.click();
  await a.button("auth.menu.password").click();
  const form = a
    .body()
    .all()
    .find((n) => n.tagName === "FORM")!;
  const inputs = form.all().filter((n) => n.tagName === "INPUT");
  inputs[1]!.value = "one";
  inputs[2]!.value = "two";
  await form.listeners.submit![0]!({ preventDefault() {} });
  await settle();
  assert.deepEqual(a.d.calls, []);
});

test("account entry: without an account it is a quiet link to the setup page, and only where setup is allowed", async () => {
  const quiet = await account({ account: "none", authenticated: false, setupAllowed: true });
  const link = quiet.slot.find("acct__btn")[0]!;
  assert.equal(link.tagName, "A");
  assert.equal(link.attrs.href, "/ui/login");
  assert.equal(link.textContent, "auth.menu.setup");
  const remote = await account({ account: "none", authenticated: false, setupAllowed: false });
  assert.equal(remote.slot.children.length, 0);
});

test("account entry: nothing for a signed-out visitor, an unanswered state or an auth-less server", async () => {
  for (const state of [
    { account: "present", authenticated: false },
    { account: "damaged", authenticated: false },
    null,
  ]) {
    const a = await account(state);
    assert.equal(a.slot.children.length, 0, JSON.stringify(state));
  }
});

// ── login.html ───────────────────────────────────────────────────────────────
test("login.html: no inline script or handler, only files the page needs, all of them present", async () => {
  const html = await read("login.html");
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.deepEqual(scripts, ['<script type="module" src="js/login.js">']);
  assert.doesNotMatch(html, /<script[^>]*>[^<]+<\/script>/, "no inline script body");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "no inline event handler");
  assert.doesNotMatch(html, /\sstyle\s*=/i, "no inline style attribute (CSP style-src 'self')");
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*"(?:[a-z]+:)?\/\//i, "no external resource");
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
  assert.deepEqual(refs, [
    "img/favicon.ico",
    "img/favicon-32.png",
    "img/apple-touch-icon.png",
    "css/tokens.css",
    "css/base.css",
    "css/dialogs.css",
    "css/auth.css",
    "js/login.js",
  ]);
  for (const ref of refs) await access(new URL(ref, app));
  assert.match(html, /^<!doctype html>\s*<html>/i, "the daemon's data-lang injection finds <html");
});

test("login.js imports only files that exist and that the page may load", async () => {
  const seen = new Set<string>();
  const walk = async (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
    for (const m of (await read(file)).matchAll(/^import [^;]*?from "\.\/([^"]+)";/gm)) await walk(dir + m[1]);
  };
  await walk("js/login.js");
  assert.deepEqual(
    [...seen].sort(),
    [
      "js/login.js",
      "js/dom.js",
      "js/i18n.js",
      ...["en", "de", "views-en", "views-de", "oldviews-en", "oldviews-de", "auth-en", "auth-de"].map(
        (n) => `js/i18n/${n}.js`
      ),
    ].sort()
  );
});
