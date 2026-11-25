// #1561: `GET /ui/skills` had no caller left — the map only declares skills
// (POST), and `bastra skills` lists them. The GET branch is gone: it answers
// like any unknown /ui route, while POST still declares a skill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
import { mutateSettings, settingsFilePath } from "../src/settings-file.js";
import { listSkills } from "../src/skills-registry.js";

async function call(port: number, method: string, path: string, payload?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
  });
  return { status: res.status, body: await res.text() };
}

test("#1561: GET /ui/skills is an unknown route, POST /ui/skills still declares", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ui-skills-route-"));
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  await mutateSettings(settingsFilePath(), (s) => ({ ...s, ui: { ...s.ui, enabled: true } }));
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
  });
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    await handle.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const port = handle.port!;

  const removed = await call(port, "GET", "/ui/skills");
  const unknown = await call(port, "GET", "/ui/no-such-route");
  assert.ok([404, 405].includes(removed.status), `GET /ui/skills answered ${removed.status}`);
  assert.deepEqual(removed, unknown, "same answer as any unknown /ui route");

  const declared = await call(port, "POST", "/ui/skills", { id: "wanted-note" });
  assert.equal(declared.status, 200);
  assert.equal((JSON.parse(declared.body) as { skill: { id: string } }).skill.id, "wanted-note");
  assert.deepEqual(
    (await listSkills()).map((s) => s.id),
    ["wanted-note"]
  );
});
