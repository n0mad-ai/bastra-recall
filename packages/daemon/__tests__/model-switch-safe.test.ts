/**
 * The safe model switch (`enableGenerationModel` with `verify`): pull, one
 * short real call, and only then the setting. Whatever fails on the way, the
 * stored model is the one that was stored before.
 *
 * Ollama is a loopback fake and the `ollama` binary is injected — nothing here
 * pulls a model or calls one.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/model-switch-safe.test.ts
 */
import { test, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, setGenerationModel } from "../src/settings.js";

const fake = {
  pulled: [] as string[],
  /** What /api/chat answers: an HTTP status and the model's text. */
  chat: { status: 200, content: "ok" },
  chatCalls: [] as string[],
};

let server: Server;
let dir: string;
let settingsPath: string;
// Imported after BASTRA_OLLAMA_URL points at the fake: ollama.ts reads it once.
let enableGenerationModel: typeof import("../src/cli/ollama.js").enableGenerationModel;

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/api/version") return json(200, { version: "0.0.0-fake" });
      if (req.url === "/api/tags") return json(200, { models: fake.pulled.map((name) => ({ name })) });
      if (req.url === "/api/chat") {
        fake.chatCalls.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string }).model);
        return json(fake.chat.status, { message: { content: fake.chat.content } });
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.BASTRA_OLLAMA_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ({ enableGenerationModel } = await import("../src/cli/ollama.js"));
  dir = await mkdtemp(join(tmpdir(), "bastra-model-switch-"));
  settingsPath = join(dir, "cli-settings.json");
});

after(async () => {
  delete process.env.BASTRA_OLLAMA_URL;
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

beforeEach(async () => {
  fake.pulled = ["old:4b"];
  fake.chat = { status: 200, content: "ok" };
  fake.chatCalls = [];
  await setGenerationModel("old:4b", settingsPath);
});

/** The injected `ollama` binary: a pull either lands the model or fails. */
function cli(pull: "ok" | "fails" | "lands-nothing" = "ok") {
  const calls: string[] = [];
  return {
    calls,
    find: () => "/fake/bin/ollama",
    pull: (_bin: string, model: string) => {
      calls.push(model);
      if (pull === "fails") return { ok: false, signal: false, detail: "exit 1" };
      if (pull === "ok") fake.pulled.push(model);
      return { ok: true, signal: false, detail: "ok" };
    },
  };
}

const stored = async () => (await readSettings(settingsPath)).generation?.model;

test("switch: pulled, answered the test call → only then the setting changes", async () => {
  const c = cli();
  const r = await enableGenerationModel("new:4b", { dryRun: false, verify: true }, settingsPath, c);
  assert.equal(r.activated, true);
  assert.deepEqual(c.calls, ["new:4b"]);
  assert.deepEqual(fake.chatCalls, ["new:4b"], "the test call goes to the NEW model");
  assert.equal(await stored(), "new:4b");
  assert.ok(fake.pulled.includes("old:4b"), "the old model is not removed");
});

test("switch: the pull fails → nothing is changed, and the reason is reported", async () => {
  const r = await enableGenerationModel("new:4b", { dryRun: false, verify: true }, settingsPath, cli("fails"));
  assert.equal(r.activated, false);
  assert.match(r.message, /ollama pull new:4b` failed \(exit 1\)/);
  assert.deepEqual(fake.chatCalls, [], "no test call against a model that is not there");
  assert.equal(await stored(), "old:4b");
});

test("switch: the pull reports success but the model is not there → nothing is changed", async () => {
  const r = await enableGenerationModel("new:4b", { dryRun: false, verify: true }, settingsPath, cli("lands-nothing"));
  assert.equal(r.activated, false);
  assert.match(r.message, /not present after pull/);
  assert.equal(await stored(), "old:4b");
});

test("switch: the test call fails → nothing is changed, and the reason is reported", async () => {
  fake.chat = { status: 500, content: "" };
  const r = await enableGenerationModel("new:4b", { dryRun: false, verify: true }, settingsPath, cli());
  assert.equal(r.activated, false);
  assert.match(r.message, /new:4b is downloaded but did not answer a test call \(Ollama chat HTTP 500\)/);
  assert.equal(await stored(), "old:4b");
});

test("switch: an empty answer is not an answer → nothing is changed", async () => {
  fake.chat = { status: 200, content: "  " };
  const r = await enableGenerationModel("new:4b", { dryRun: false, verify: true }, settingsPath, cli());
  assert.equal(r.activated, false);
  assert.match(r.message, /empty answer/);
  assert.equal(await stored(), "old:4b");
});

test("switch: a model that is already pulled is still tested, but not pulled again", async () => {
  fake.pulled.push("new:4b");
  const c = cli();
  const r = await enableGenerationModel("new:4b", { dryRun: false, verify: true }, settingsPath, c);
  assert.equal(r.activated, true);
  assert.deepEqual(c.calls, []);
  assert.deepEqual(fake.chatCalls, ["new:4b"]);
});

test("no ollama binary → refused before anything is pulled or stored", async () => {
  const c = { ...cli(), find: () => null };
  const r = await enableGenerationModel("new:4b", { dryRun: false, verify: true }, settingsPath, c);
  assert.equal(r.activated, false);
  assert.match(r.message, /Ollama isn't running/);
  assert.equal(await stored(), "old:4b");
});

test("`bastra models set` / the installer are unchanged: without `verify` there is no test call", async () => {
  const r = await enableGenerationModel("new:4b", { dryRun: false }, settingsPath, cli());
  assert.equal(r.activated, true);
  assert.deepEqual(fake.chatCalls, []);
  assert.equal(await stored(), "new:4b");
});

test("installer: the suggested tev1:4b is pulled and stored once the user picked it", async () => {
  // What the wizard runs after the text-model step: enableGenerationModel(pick).
  const c = cli();
  const r = await enableGenerationModel("tev1:4b", { dryRun: false }, settingsPath, c);
  assert.equal(r.activated, true);
  assert.deepEqual(c.calls, ["tev1:4b"], "pulled through the ollama binary");
  assert.ok(fake.pulled.includes("tev1:4b"));
  assert.equal(await stored(), "tev1:4b");
});
