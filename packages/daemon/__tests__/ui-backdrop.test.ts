import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dispatchUiBackdrop, backdropName, BACKDROP_MAX_BYTES } from "../src/ui-backdrop.js";
import { gateLocalPost } from "../src/http-auth.js";
import { mutateSettings, readSettings, setUiEnabled } from "../src/settings.js";
import { applySettingChanges, parseStoredSettings } from "../src/settings-registry.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg-body")]);

async function serve(t: { after: (fn: () => Promise<void>) => void }, enabled = true) {
  const root = await mkdtemp(join(tmpdir(), "ui-backdrop-"));
  const settingsPath = join(root, "cli-settings.json"), dir = join(root, "backdrops");
  await mutateSettings(settingsPath, (s) => ({ ...s, ui: { enabled } }));
  const server = createServer((req, res) => { if (!dispatchUiBackdrop(req, res, req.method!, req.url!, { settingsPath, dir })) { res.writeHead(418); res.end(); } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, settingsPath, dir, root };
}

test("backdrop settings: presets, upload ids, dim bounds/steps, blur; the CLI/UI write keeps ui.enabled", async () => {
  const base = parseStoredSettings({ ui: { enabled: true } });
  assert.equal(applySettingChanges(base, { "ui.backdrop": "aurora" }).ui?.backdrop, "aurora");
  assert.equal(applySettingChanges(base, { "ui.backdrop": "up-0123456789abcdef" }).ui?.backdrop, "up-0123456789abcdef");
  for (const bad of ["../cli-settings.json", "up-../../x", "up-0123", "https://example.com/a.png", "Aurora", ""]) {
    assert.throws(() => applySettingChanges(base, { "ui.backdrop": bad }), /Invalid value/, bad);
  }
  const dim = applySettingChanges(base, { "ui.backdropDim": 65 });
  assert.equal(dim.ui?.backdropDim, 65);
  assert.equal(dim.ui?.enabled, true);
  for (const bad of [45, 100, 52, "80"]) assert.throws(() => applySettingChanges(base, { "ui.backdropDim": bad }), /Invalid value/, String(bad));
  assert.equal(applySettingChanges(base, { "ui.backdropBlur": true }).ui?.backdropBlur, true);
  // Invalid stored leaves are dropped, the ui block itself survives.
  assert.deepEqual(parseStoredSettings({ ui: { enabled: true, backdrop: "../x", backdropDim: 3 } }).ui, { enabled: true });
});

test("ui.enabled toggles keep the background image settings", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ui-backdrop-flag-")), "cli-settings.json");
  await mutateSettings(path, (s) => applySettingChanges({ ...s, ui: { enabled: true } }, { "ui.backdrop": "dusk", "ui.backdropDim": 70 }));
  await setUiEnabled(false, path); await setUiEnabled(true, path);
  assert.deepEqual((await readSettings(path)).ui, { enabled: true, backdrop: "dusk", backdropDim: 70 });
});

test("POST gate admits only image bodies on /ui/backdrop", () => {
  const p = { origin: "http://127.0.0.1:6723", host: "127.0.0.1:6723" };
  assert.equal(gateLocalPost({ ...p, contentType: "image/png", path: "/ui/backdrop?name=x" }), 200);
  assert.equal(gateLocalPost({ ...p, contentType: "image/svg+xml", path: "/ui/backdrop" }), 415);
  assert.equal(gateLocalPost({ ...p, contentType: "application/json", path: "/ui/backdrop" }), 415);
  assert.equal(gateLocalPost({ origin: "https://evil.example", host: p.host, contentType: "image/png", path: "/ui/backdrop" }), 403);
});

test("upload stores locally, serves by id only, and checks type, size and count", async (t) => {
  const { origin, settingsPath, dir } = await serve(t);
  const state0 = await (await fetch(origin + "/ui/backdrop")).json();
  assert.deepEqual(state0, { backdrop: "none", dim: 80, blur: false, uploads: [] });

  const up = await fetch(origin + "/ui/backdrop?name=" + encodeURIComponent("Mein Foto.png"), { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG });
  assert.equal(up.status, 200);
  const made = await up.json() as { id: string; name: string; url: string };
  assert.match(made.id, /^up-[0-9a-f]{16}$/);
  assert.equal(made.name, "Mein Foto");
  assert.equal(made.url, `/ui/backdrop/${made.id}`);
  assert.deepEqual((await readdir(dir)).sort(), [`${made.id}.png`, "uploads.json"]);

  const img = await fetch(origin + made.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal(img.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);

  // Selected upload is reported; a missing file falls back to "none".
  await mutateSettings(settingsPath, (s) => applySettingChanges(s, { "ui.backdrop": made.id, "ui.backdropBlur": true }));
  const st = await (await fetch(origin + "/ui/backdrop")).json() as { backdrop: string; blur: boolean; uploads: unknown[] };
  assert.equal(st.backdrop, made.id); assert.equal(st.blur, true); assert.equal(st.uploads.length, 1);
  await mutateSettings(settingsPath, (s) => applySettingChanges(s, { "ui.backdrop": "up-ffffffffffffffff" }));
  assert.equal((await (await fetch(origin + "/ui/backdrop")).json() as { backdrop: string }).backdrop, "none");

  // Type: declared and sniffed must agree, SVG/HTML never.
  const post = (type: string, body: Buffer | string) => fetch(origin + "/ui/backdrop", { method: "POST", headers: { "Content-Type": type }, body });
  assert.equal((await post("image/png", JPEG)).status, 415);
  assert.equal((await post("image/svg+xml", "<svg onload=alert(1)>")).status, 415);
  assert.equal((await post("text/html", "<script>")).status, 415);
  assert.equal((await post("image/jpeg", Buffer.from("not an image"))).status, 415);
  assert.equal((await post("image/jpeg", JPEG)).status, 200);
  // Size.
  assert.equal((await post("image/png", Buffer.concat([PNG, Buffer.alloc(BACKDROP_MAX_BYTES)]))).status, 413);
  assert.equal((await readdir(dir)).length, 3, "rejected uploads leave no file");
});

test("image route resolves nothing but known upload ids (path traversal)", async (t) => {
  const { origin, dir, root } = await serve(t);
  const made = await (await fetch(origin + "/ui/backdrop", { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG })).json() as { id: string };
  await writeFile(join(root, "secret.txt"), "secret-sentinel");
  // A hand-edited index row pointing outside the folder is ignored.
  const index = JSON.parse(await (await import("node:fs/promises")).readFile(join(dir, "uploads.json"), "utf8"));
  await writeFile(join(dir, "uploads.json"), JSON.stringify([...index, { id: "../secret", name: "x", ext: ".txt" }, { id: "up-aaaaaaaaaaaaaaaa", name: "x", ext: "/../../secret.txt" }]));
  for (const path of ["/ui/backdrop/..%2Fsecret.txt", "/ui/backdrop/%2e%2e%2fsecret.txt", "/ui/backdrop/up-aaaaaaaaaaaaaaaa", "/ui/backdrop/up-0000000000000000",
    `/ui/backdrop/${made.id}.png`, `/ui/backdrop/${made.id}/..`, "/ui/backdrop/uploads.json", "/ui/backdrop/"]) {
    const r = await fetch(origin + path);
    const text = await r.text();
    assert.ok(r.status === 404 || r.status === 418, `${path} → ${r.status}`);
    assert.ok(!text.includes("secret-sentinel"), path);
  }
  assert.equal((await fetch(origin + `/ui/backdrop/${made.id}`)).status, 200);
  assert.equal((await fetch(origin + `/ui/backdrop/${made.id}`, { method: "DELETE" })).status, 404);
});

test("upload count is capped and the display name is sanitized", async (t) => {
  const { origin } = await serve(t);
  for (let i = 0; i < 24; i++) assert.equal((await fetch(origin + "/ui/backdrop", { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG })).status, 200);
  assert.equal((await fetch(origin + "/ui/backdrop", { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG })).status, 409);
  assert.equal(backdropName("a\u0000b\nc.jpeg"), "abc");
  assert.equal(backdropName(""), "image");
  assert.equal(backdropName("x".repeat(200)).length, 80);
});

test("disabled UI answers 404 on every backdrop route", async (t) => {
  const { origin } = await serve(t, false);
  assert.equal((await fetch(origin + "/ui/backdrop")).status, 404);
  assert.equal((await fetch(origin + "/ui/backdrop", { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG })).status, 404);
});
