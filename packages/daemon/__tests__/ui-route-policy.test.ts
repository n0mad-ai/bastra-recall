/**
 * #1198 S5 — invariants of the /ui route policy and the request classes.
 *
 * - Every /ui route literal in the routers has an explicit policy entry; a new
 *   route without one turns this test red.
 * - The tunnel's local-only list is exactly what the build plan names.
 * - The files reachable without a session are exactly what login.html links,
 *   what login.js imports (transitively) and the fonts tokens.css loads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { UI_LOGIN_ASSETS, UI_ROUTE_POLICY, uiRouteEntry, uiRoutePolicy } from "../src/ui-route-policy.js";
import { classifyUiRequest } from "../src/ui-auth-gate.js";
import { resolveWebUiDir } from "../src/webui.js";

const SRC = join(import.meta.dirname, "..", "src");
/** The three routers the plan names, plus the dispatchers they hand /ui paths to. */
const ROUTERS = [
  "http-ui-routes.ts",
  "settings-ui.ts",
  "http.ts",
  "http-graph-reads.ts",
  "task-ui-session.ts",
  "chat-history.ts",
  "ui-backdrop.ts",
  "http-assistant-address.ts",
  "ui-auth-routes.ts",
];

test("every /ui route literal in the routers has an explicit policy entry", async () => {
  const literals = new Set<string>();
  for (const file of ROUTERS) {
    const source = await readFile(join(SRC, file), "utf8");
    for (const m of source.matchAll(/["'`](?:(?:GET|POST|DELETE|PATCH|PUT) )?(\/ui[^"'`\s?$]*)/g)) literals.add(m[1]!);
  }
  // Paths built at run time (regular expressions, path segments).
  for (const extra of [
    "/ui/chat/conversations/abc",
    "/ui/graph/node",
    "/ui/graph/semantic",
    "/ui/backdrop/up-0123456789abcdef",
  ])
    literals.add(extra);
  assert.ok(literals.size > 40, `found only ${literals.size} literals`);
  const missing = [...literals]
    .map((path) => (path.endsWith("/") && path !== "/ui/" ? `${path}x` : path))
    .filter((path) => uiRouteEntry(path) === undefined);
  assert.deepEqual(missing, [], "classify these routes in src/ui-route-policy.ts");
});

test("through the tunnel these stay 403, with and without a session", () => {
  const localOnly = UI_ROUTE_POLICY.filter((e) => e.localOnly).map((e) => e.path);
  assert.deepEqual(localOnly.sort(), [
    "/ui/assistant-address",
    "/ui/auth/setup",
    "/ui/fs",
    "/ui/import-vault",
    "/ui/settings",
  ]);
  for (const path of [
    "/ui/settings",
    "/ui/settings/session",
    "/ui/assistant-address/refresh",
    "/ui/fs?dir=/",
    "/ui/import-vault",
  ])
    assert.equal(uiRoutePolicy(path.split("?")[0]!).localOnly, true, path);
  // No open entry may shadow a local-only one.
  assert.equal(uiRoutePolicy("/ui/auth/setup").localOnly, true);
});

test("only the sign-in routes and the sign-in page's files are open", () => {
  const open = UI_ROUTE_POLICY.filter((e) => e.access === "open" && !UI_LOGIN_ASSETS.includes(e)).map((e) => e.path);
  assert.deepEqual(open.sort(), ["/ui/auth/login", "/ui/auth/setup", "/ui/auth/state", "/ui/login"]);
  assert.deepEqual(
    UI_ROUTE_POLICY.filter((e) => e.background)
      .map((e) => e.path)
      .sort(),
    ["/ui/health", "/ui/import-count", "/ui/updates"]
  );
  for (const path of ["/ui/", "/ui/index.html", "/ui/js/main.js", "/ui/engines/x.js", "/ui/js/session-client.js"])
    assert.equal(uiRoutePolicy(path).access, "session", path);
});

test("the open static files are exactly what the sign-in page loads", async () => {
  const app = resolveWebUiDir();
  const read = (file: string) => readFile(join(app, file), "utf8");
  const needed = new Set<string>();
  const html = await read("login.html");
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) needed.add(m[1]!);
  const walk = async (file: string) => {
    if (needed.has(file) && file !== "js/login.js") return;
    needed.add(file);
    const dir = file.slice(0, file.lastIndexOf("/") + 1);
    for (const m of (await read(file)).matchAll(/^import [^;]*?from "\.\/([^"]+)";/gm)) await walk(dir + m[1]);
  };
  await walk("js/login.js");
  const fonts = new Set<string>();
  for (const css of [...needed].filter((f) => f.endsWith(".css")))
    for (const m of (await read(css)).matchAll(/url\(["']?\.\.\/(fonts\/[^"')]+)["']?\)/g)) fonts.add(m[1]!);
  const exact = UI_LOGIN_ASSETS.filter((e) => !e.prefix).map((e) => e.path.slice("/ui/".length));
  assert.deepEqual(exact.sort(), [...needed].sort());
  const prefixes = UI_LOGIN_ASSETS.filter((e) => e.prefix).map((e) => e.path);
  assert.deepEqual(prefixes, fonts.size > 0 ? ["/ui/fonts/"] : []);
  for (const font of fonts) assert.equal(uiRoutePolicy(`/ui/${font}`).access, "open", font);
});

function fakeRequest(url: string, headers: Record<string, string>, remoteAddress = "127.0.0.1"): IncomingMessage {
  return { url, headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

test("classifyUiRequest: only the exact tunnel shape is public-ui", () => {
  const origin = "https://recall.example.test";
  const tunnel = { host: "recall.example.test", "x-forwarded-proto": "https" };
  const cases: Array<[string, Record<string, string>, string, string, string?]> = [
    ["/ui/graph", tunnel, origin, "public-ui"],
    ["/ui", tunnel, origin, "public-ui"],
    ["/ui/login?next=%2Fui%2F", { ...tunnel, host: "RECALL.example.test" }, origin, "public-ui"],
    ["/ui/graph", { ...tunnel, "x-forwarded-proto": "http" }, origin, "reject"],
    ["/ui/graph", { host: "recall.example.test" }, origin, "reject"],
    ["/ui/graph", { ...tunnel, host: "recall.example.test:443" }, origin, "local-ui"],
    ["/ui/graph", tunnel, origin, "reject", "203.0.113.9"],
    ["/ui/graph", tunnel, "", "local-ui"],
    ["/ui/graph", tunnel, "http://recall.example.test", "local-ui"],
    ["/ui/graph", { host: "127.0.0.1:6723" }, origin, "local-ui"],
    ["/uix", tunnel, origin, "other"],
    ["/health", tunnel, origin, "other"],
    ["/api/v1/health", tunnel, origin, "other"],
    ["/hook/recall", tunnel, origin, "other"],
  ];
  for (const [url, headers, publicOrigin, expected, peer] of cases)
    assert.equal(
      classifyUiRequest(fakeRequest(url, headers, peer), publicOrigin),
      expected,
      `${url} ${JSON.stringify(headers)} ${peer ?? ""}`
    );
});
