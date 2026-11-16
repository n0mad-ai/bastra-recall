import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dispatchSettingsUi } from "../src/settings-ui.js";
import { mutateSettings, readSettings } from "../src/settings-file.js";

test("local settings session/CSRF, atomic validation and secret masking", async (t) => {
  const path = join(await mkdtemp(join(tmpdir(), "settings-ui-")), "cli-settings.json");
  await mutateSettings(path, (s) => ({
    ...s,
    ui: { enabled: true },
    api: { token: "secret-sentinel" },
    assistant: { name: "jarvis", displayName: "Jarvis" },
  }));
  let restarts = 0;
  const server = createServer((req, res) => {
    if (
      !dispatchSettingsUi(req, res, req.method!, req.url!, {
        path,
        restart: async () => {
          restarts++;
        },
      })
    ) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await fetch(origin + "/ui/settings")).status, 401);
  assert.equal(
    (
      await fetch(origin + "/ui/settings/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: "{}",
      })
    ).status,
    403
  );
  const session = await fetch(origin + "/ui/settings/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: "{}",
  });
  const cookie = session.headers.get("set-cookie")!.split(";")[0],
    token = ((await session.json()) as { csrf: string }).csrf;
  const headers = {
    "Content-Type": "application/json",
    Origin: origin,
    Cookie: cookie,
    "X-Bastra-Settings-CSRF": token,
  };
  const read = await fetch(origin + "/ui/settings", { headers });
  const text = await read.text();
  assert.equal(read.status, 200);
  assert.ok(!text.includes("secret-sentinel"));
  const entries = (JSON.parse(text) as { entries: Array<{ key: string; value: unknown; managed?: boolean }> }).entries;
  const name = entries.find((e) => e.key === "assistant.name");
  assert.equal(name?.value, "Jarvis", "the name row shows the spelling the user typed");
  assert.equal(name?.managed, true, "it is saved through the address endpoint");
  assert.ok(!entries.some((e) => e.key === "assistant.displayName"), "no separate display-name row");
  for (const key of ["assistant.name", "assistant.displayName"]) {
    const bypass = await fetch(origin + "/ui/settings", {
      method: "POST",
      headers,
      body: JSON.stringify({ changes: { [key]: "Ruby" } }),
    });
    assert.equal(bypass.status, 400, key);
  }
  assert.equal((await readSettings(path)).assistant?.displayName, "Jarvis");
  assert.equal(
    (
      await fetch(origin + "/ui/settings", {
        method: "POST",
        headers: { ...headers, "X-Bastra-Settings-CSRF": "bad" },
        body: JSON.stringify({ changes: { "docs.language": "de" } }),
      })
    ).status,
    403
  );
  const invalid = await fetch(origin + "/ui/settings", {
    method: "POST",
    headers,
    body: JSON.stringify({ changes: { "docs.language": "de", "tasks.enabled": "secret-sentinel" } }),
  });
  assert.equal(invalid.status, 400);
  assert.ok(!(await invalid.text()).includes("secret-sentinel"));
  assert.equal((await readSettings(path)).docs, undefined);
  const write = await fetch(origin + "/ui/settings", {
    method: "POST",
    headers,
    body: JSON.stringify({ changes: { "docs.language": "de", "api.token": "new-secret-sentinel" } }),
  });
  assert.equal(write.status, 200);
  assert.ok(!(await write.text()).includes("new-secret-sentinel"));
  assert.equal((await readSettings(path)).docs?.language, "de");
  assert.equal((await fetch(origin + "/ui/settings/restart", { method: "POST", headers, body: "{}" })).status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restarts, 1);
  assert.equal(
    (await fetch(origin + "/ui/settings", { headers: { ...headers, "X-Forwarded-For": "127.0.0.1" } })).status,
    403
  );
});

test("full settings sessions: a new browser displaces the least recently used idle session, never one in use", async (t) => {
  const path = join(await mkdtemp(join(tmpdir(), "settings-ui-lru-")), "cli-settings.json");
  await mutateSettings(path, (s) => ({ ...s, ui: { enabled: true } }));
  const server = createServer((req, res) => {
    if (!dispatchSettingsUi(req, res, req.method!, req.url!, { path })) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Start past the 15-minute TTL so sessions of earlier tests in this process have expired.
  const realNow = Date.now;
  let now = realNow() + 20 * 60_000;
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
    return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const open = () =>
    fetch(origin + "/ui/settings/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: "{}",
    });
  const grant = async () => {
    const r = await open();
    assert.equal(r.status, 200);
    return { Cookie: r.headers.get("set-cookie")!.split(";")[0] };
  };
  const oldest = await grant();
  now += 1000;
  const active = await grant();
  now += 1000;
  for (let i = 0; i < 250; i++) {
    const r = await open();
    if (r.status === 429) break;
    assert.equal(r.status, 200);
  }
  assert.equal((await open()).status, 429, "slots used within the idle window keep the capacity guard");
  now += 11 * 60_000;
  assert.equal(
    (await fetch(origin + "/ui/settings", { headers: active })).status,
    200,
    "an open settings page keeps its session"
  );
  assert.equal((await open()).status, 200, "a new browser gets in once the oldest slot has been idle long enough");
  assert.equal(
    (await fetch(origin + "/ui/settings", { headers: oldest })).status,
    401,
    "the least recently used session gave way"
  );
  assert.equal(
    (await fetch(origin + "/ui/settings", { headers: active })).status,
    200,
    "the session in use stays valid"
  );
});
