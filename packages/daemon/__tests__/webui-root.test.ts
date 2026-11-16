/**
 * The UI v2 is the web UI at /ui/ (16.11.2026). Pins the switch against the
 * real shipped folders: the root and /ui/index.html serve the UI v2, the
 * preview address of the development branch is an unknown path (404), files of
 * the first UI are gone, the engines the UI v2 hosts (webui/js/) are served at
 * /ui/engines/, and nothing outside those two folders is reachable. The access
 * gates key on the /ui prefix.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/webui-root.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleWebUi, resolveWebUiDir } from "../src/webui.js";
import { localAccountPath } from "../src/local-account-access.js";

interface Res {
  status: number;
  location?: string;
  type?: string;
  body: string;
}

async function withUi(fn: (get: (path: string) => Promise<Res>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "webui-root-"));
  const settingsPath = join(dir, "cli-settings.json");
  await writeFile(settingsPath, JSON.stringify({ ui: { enabled: true } }));
  const server = createServer((req, res) => {
    void handleWebUi(req, res, req.url ?? "/", resolveWebUiDir(), settingsPath);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const get = (path: string) =>
    new Promise<Res>((resolve, reject) => {
      const rq = request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            type: res.headers["content-type"],
            body,
          })
        );
      });
      rq.on("error", reject);
      rq.end();
    });
  try {
    await fn(get);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
}

test("/ui/ and /ui/index.html serve the UI v2 with its CSP", async () => {
  await withUi(async (get) => {
    for (const path of ["/ui/", "/ui/index.html"]) {
      const res = await get(path);
      assert.equal(res.status, 200, path);
      assert.match(res.type ?? "", /^text\/html/);
      assert.match(res.body, /<script type="module" src="js\/main\.js"><\/script>/, `${path} is the UI v2`);
      assert.match(res.body, /<html data-tasks-enabled="(true|false)" data-lang="(de|en)"/);
    }
    assert.equal((await get("/ui")).location, "/ui/");
  });
});

test("the development preview address is an unknown path like any other", async () => {
  await withUi(async (get) => {
    for (const path of [
      "/ui/v22",
      "/ui/v22/",
      "/ui/v22/index.html",
      "/ui/v22/index.html?view=orbit",
      "/ui/v22/js/main.js",
    ]) {
      const res = await get(path);
      assert.equal(res.status, 404, path);
      assert.equal(res.location, undefined, path);
    }
  });
});

test("the engines the UI v2 hosts are served from its folder", async () => {
  await withUi(async (get) => {
    for (const path of [
      "/ui/js/main.js",
      "/ui/engines/simulation.js",
      "/ui/engines/renderer.js",
      "/ui/engines/managers/orbit-view.js",
      "/ui/engines/managers/semantic-view.js",
      "/ui/engines/managers/weather.js",
    ]) {
      const res = await get(path);
      assert.equal(res.status, 200, path);
      assert.match(res.type ?? "", /^text\/javascript/, path);
    }
  });
});

test("files of the first UI are gone", async () => {
  await withUi(async (get) => {
    for (const path of [
      "/ui/js/app.js",
      "/ui/js/tasks.js",
      "/ui/js/settings.js",
      "/ui/css/app.css",
      "/ui/vendor/ctxmenu.js",
      "/ui/mindspace-lab.html",
      "/ui/mindspace-lab-center.html",
    ]) {
      assert.equal((await get(path)).status, 404, path);
    }
  });
});

test("nothing outside the UI folder is reachable", async () => {
  await withUi(async (get) => {
    for (const path of [
      "/ui/..%2Fpackage.json",
      "/ui/..%2F..%2Fpackage.json",
      "/ui/engines/..%2F..%2F..%2Fpackage.json",
      "/ui/engines/..%2Fv22%2Findex.html",
      "/ui/engines/..%2F..%2Fsrc%2Fwebui.ts",
      "/ui/%2e%2e/%2e%2e/package.json",
      "/ui/..%2F..%2Fsrc%2Fwebui.ts",
    ]) {
      const res = await get(path);
      assert.ok(res.status === 403 || res.status === 404, `${path} → ${res.status}`);
      assert.ok(!res.body.includes("@bastra-recall/daemon"), path);
    }
  });
});

test("the account gate covers the web UI root and its files", () => {
  for (const path of ["/ui", "/ui/", "/ui/index.html", "/ui/engines/renderer.js"])
    assert.equal(localAccountPath(path), true, path);
});
