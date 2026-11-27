import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { postHookBody } from "../../packages/daemon/src/hook-transport.ts";
import {
  clearStatuslineOutagesForPort,
  recordStatuslineReachability,
} from "../../packages/daemon/src/hook-unreachable-notice.ts";
import { DEFAULT_CONFIG } from "../../packages/statusline/src/config/defaults.ts";
import { PowerlineRenderer } from "../../packages/statusline/src/powerline.ts";

function render(sessionId, style = "powerline") {
  const config = structuredClone(DEFAULT_CONFIG);
  config.display.style = style;
  config.display.lines = [{ segments: { model: { enabled: true }, bastra: { enabled: true } } }];
  return new PowerlineRenderer(config).generateStatusline({
    session_id: sessionId,
    model: { id: "sonnet", display_name: "Sonnet" },
  });
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("the Claude footer shows a confirmed outage for its session and clears on recovery", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-footer-offline-"));
  const previousStateDir = process.env.BASTRA_HOOK_STATE_DIR;
  process.env.BASTRA_HOOK_STATE_DIR = dir;
  t.after(async () => {
    if (previousStateDir === undefined) delete process.env.BASTRA_HOOK_STATE_DIR;
    else process.env.BASTRA_HOOK_STATE_DIR = previousStateDir;
    await rm(dir, { recursive: true, force: true });
  });
  let locale = "en-US";
  t.mock.method(Intl.DateTimeFormat.prototype, "resolvedOptions", () => ({ locale }));

  let respond = true;
  const server = createServer((_request, response) => {
    if (respond) {
      response.setHeader("Connection", "close");
      response.end("{}");
    }
  });
  const port = await listen(server);
  await close(server);
  t.after(async () => {
    if (server.listening) await close(server);
  });
  const url = `http://127.0.0.1:${port}`;
  const call = (lane, sessionId, timeout = 1_000) =>
    postHookBody(url, `/hook/${lane}`, { payload: { session_id: sessionId, bastra_client: "claude-code" } }, timeout);

  assert.doesNotMatch(await render("session"), /Recall offline/);
  await assert.rejects(call("session", "session"), { code: "ECONNREFUSED" });
  const offline = await render("session");
  assert.match(offline, /Sonnet/);
  assert.match(offline, /Recall offline/);
  assert.match(await render("session", "tui"), /Recall offline/);
  assert.doesNotMatch(await render("other"), /Recall offline/);

  locale = "de-DE";
  assert.match(await render("session"), /Recall nicht erreichbar/);
  await listen(server, port);
  respond = false;
  await assert.rejects(call("prompt", "other", 30), /timeout/);
  assert.doesNotMatch(await render("other"), /Recall nicht erreichbar/);
  await assert.rejects(call("prompt", "session", 30), /timeout/);
  assert.match(await render("session"), /Recall nicht erreichbar/);
  respond = true;
  assert.equal(await call("prompt", "session"), "{}");
  assert.doesNotMatch(await render("session"), /Recall offline|Recall nicht erreichbar/);

  await close(server);
  await assert.rejects(call("prompt", "session"), { code: "ECONNREFUSED" });
  const key = createHash("sha256").update("session").digest("hex").slice(0, 24);
  const marker = join(dir, "unreachable-notice", `offline-local-${port}-${key}`);
  const now = Date.now();
  const sameMillisecond = (now + 0.5) / 1_000;
  await utimes(marker, sameMillisecond, sameMillisecond);
  let clock = now;
  t.mock.method(Date, "now", () => clock);
  assert.match(await render("session"), /Recall nicht erreichbar/);
  const future = new Date(now + 2);
  await utimes(marker, future, future);
  assert.doesNotMatch(await render("session"), /Recall nicht erreichbar/);
  const prolongedOutage = new Date(now - 3_600_000);
  await utimes(marker, prolongedOutage, prolongedOutage);
  assert.match(await render("session"), /Recall nicht erreichbar/);

  // The local port is the daemon's identity. An unscoped notice (old hook
  // or remote tunnel) and a different local port must remain after startup.
  clock = now + 60_000;
  const other = "http://127.0.0.1:1";
  const remote = "https://recall.example";
  await recordStatuslineReachability("session", false, other);
  await recordStatuslineReachability("remote", false, remote);
  await recordStatuslineReachability("only-local", false, url);
  assert.match(await render("only-local"), /Recall nicht erreichbar/);
  await clearStatuslineOutagesForPort(port);
  assert.doesNotMatch(await render("only-local"), /Recall nicht erreichbar/);
  assert.match(await render("session"), /Recall nicht erreichbar/);
  assert.match(await render("remote"), /Recall nicht erreichbar/);
  await recordStatuslineReachability("session", true, other);
  assert.doesNotMatch(await render("session"), /Recall nicht erreichbar/);

  await listen(server, port);
  assert.equal(await call("prompt", "session"), "{}");
  assert.doesNotMatch(await render("session"), /Recall nicht erreichbar/);
});
