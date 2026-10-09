/**
 * An answer to a model recommendation has to be the answer to THE
 * recommendation the user saw, and it has to land whole or not at all. These
 * are the counter-review's reproductions (PR #1118), kept as tests:
 *
 *   - a consent given for recommendation A must not pull recommendation B
 *     (new CLI, old daemon still showing A);
 *   - model and answer are one write, not two: no half switch on a full disk,
 *     no model B next to "rec-A/switched" after two overlapping processes;
 *   - the test call does not follow a redirect;
 *   - a model pinned in THIS shell does not stop the answer from being recorded
 *     for the daemon that asked;
 *   - a corrupt settings file is refused, not overwritten;
 *   - a recommendation without an entry for this tier is "no offer", not a crash.
 *
 * Ollama is a loopback fake and the `ollama` binary is injected.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/model-decision-binding.test.ts
 */
import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRecommendation } from "../src/cli/hardware.js";
import type { ModelsDeps } from "../src/cli/models-cmd.js";
import {
  currentModelOffer,
  formatModelNotice,
  formatModelSessionBlock,
  pendingModelNotice,
  type ModelOffer,
} from "../src/model-recommendation.js";
import { readSettings } from "../src/settings.js";

const rec = (id: string, model: string, sizeGB = 1): ModelRecommendation => {
  const entry = { model, sizeGB, improves: `Synthetic ${id}.` };
  return { id, models: { baseline: entry, enhanced: entry, high: entry } };
};
const REC_A = rec("release-A", "shown-A:4b");
const REC_B = rec("release-B", "unseen-B:12b", 8);
const EXISTING = JSON.stringify({ embedding: { provider: "ollama" }, generation: { model: "old:4b" }, api: { token: "invented-token" } });

let server: Server;
let redirectTarget: Server;
let redirectedPosts = 0;
let chatMode: "ok" | "redirect" = "ok";
let dir: string;
let cmdModels: typeof import("../src/cli/models-cmd.js").cmdModels;
let enableGenerationModel: typeof import("../src/cli/ollama.js").enableGenerationModel;
let ollamaUrl: string;
const fakeCli = { find: () => "/fake/bin/ollama", pull: () => { throw new Error("no pull in these fixtures"); } };

before(async () => {
  redirectTarget = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      redirectedPosts++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: { content: "ok" } }));
    });
  });
  await new Promise<void>((r) => redirectTarget.listen(0, "127.0.0.1", r));
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/version") {
        res.end('{"version":"0.0.0-fake"}');
      } else if (req.url === "/api/tags") {
        res.end(JSON.stringify({ models: ["old:4b", "new:4b", "shown-A:4b", "unseen-B:12b", "fixture-A:4b", "fixture-B:4b"].map((name) => ({ name })) }));
      } else if (req.url === "/api/chat" && chatMode === "redirect") {
        res.writeHead(307, { location: `http://127.0.0.1:${(redirectTarget.address() as { port: number }).port}/api/chat` });
        res.end();
      } else {
        res.end(JSON.stringify({ message: { content: "ok" } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  ollamaUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.BASTRA_OLLAMA_URL = ollamaUrl;
  ({ cmdModels } = await import("../src/cli/models-cmd.js"));
  ({ enableGenerationModel } = await import("../src/cli/ollama.js"));
  dir = await mkdtemp(join(tmpdir(), "bastra-model-binding-"));
});

after(async () => {
  delete process.env.BASTRA_OLLAMA_URL;
  for (const s of [server, redirectTarget]) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

let n = 0;
async function settingsFile(content: string = EXISTING): Promise<string> {
  const path = join(dir, `settings-${n++}.json`);
  await writeFile(path, content);
  return path;
}

/** The test-env preload drops stdout strings; this keeps them for assertions. */
async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const real = { out: process.stdout.write, err: process.stderr.write };
  let out = "";
  const grab = ((c: unknown) => { out += String(c); return true; }) as typeof process.stdout.write;
  process.stdout.write = grab;
  process.stderr.write = grab;
  try {
    return { result: await fn(), out };
  } finally {
    process.stdout.write = real.out;
    process.stderr.write = real.err;
  }
}

/** The command a text tells the reader to run for `verb`, as argv after `bastra`. */
function shownCommand(text: string, verb: "switch" | "later" | "dismiss"): string[] {
  const m = new RegExp(`bastra (models ${verb}[^\`\\n]*?)(?:\`| {3}|$)`, "m").exec(text);
  assert.ok(m, `the text names no '${verb}' command:\n${text}`);
  return m[1].trim().split(/\s+/);
}

const shownOffer = (r: ModelRecommendation): ModelOffer => ({
  id: r.id, ...r.models.baseline!, current: "old:4b", envOverride: null,
});

/** Runs what the user was shown for recommendation `shown`, on a CLI that ships `shipped`. */
function runShown(verb: "switch" | "later" | "dismiss", shown: ModelRecommendation, shipped: ModelRecommendation | null, path: string, extra: Partial<ModelsDeps> = {}) {
  const positional = shownCommand(formatModelSessionBlock(shownOffer(shown)), verb);
  const enabled: string[] = [];
  return quiet(() =>
    cmdModels({
      sub: verb,
      positional,
      settingsPath: path,
      deps: {
        recommendation: shipped,
        ramGB: 16,
        enable: (async (m: string, o: never, p: string) => { enabled.push(m); return enableGenerationModel(m, o, p, fakeCli); }) as never,
        ...extra,
      },
    }),
  ).then((r) => ({ ...r, enabled }));
}

// ── P1: the consent is bound to what was shown ───────────────────────────────

test("P1 stale consent: the command shown for recommendation A does not pull recommendation B", async () => {
  const path = await settingsFile();
  const { result, out, enabled } = await runShown("switch", REC_A, REC_B, path);
  assert.equal(result, 1);
  assert.deepEqual(enabled, [], "nothing is pulled, tested or stored");
  assert.equal(await readFile(path, "utf8"), EXISTING, "the settings file is untouched");
  assert.match(out, /release-A/);
  assert.match(out, /Nothing was changed/);
});

test("P1 stale consent: `later` and `dismiss` are not booked onto a recommendation the user never saw", async () => {
  for (const verb of ["later", "dismiss"] as const) {
    const path = await settingsFile();
    const { result } = await runShown(verb, REC_A, REC_B, path);
    assert.equal(result, 1);
    assert.equal(await readFile(path, "utf8"), EXISTING);
  }
  // …nor onto nothing: the CLI ships no recommendation any more.
  const path = await settingsFile();
  assert.equal((await runShown("dismiss", REC_A, null, path)).result, 1);
  assert.equal(await readFile(path, "utf8"), EXISTING);
});

test("P1 stale consent: a bare `bastra models switch` names no recommendation and is refused", async () => {
  for (const verb of ["switch", "later", "dismiss"]) {
    const path = await settingsFile();
    const { result, out } = await quiet(() =>
      cmdModels({ sub: verb, positional: ["models", verb], settingsPath: path, deps: { recommendation: REC_B, ramGB: 16, enable: (async () => { throw new Error("must not switch"); }) as never } }),
    );
    assert.equal(result, 2);
    assert.match(out, new RegExp(`bastra models ${verb} release-B`), "the refusal names the full command for the current recommendation");
    assert.equal(await readFile(path, "utf8"), EXISTING);
  }
});

test("P1: the same recommendation on both sides goes through, bound by id and model", async () => {
  const path = await settingsFile();
  assert.deepEqual(shownCommand(formatModelSessionBlock(shownOffer(REC_A)), "switch"), ["models", "switch", "release-A", "shown-A:4b"]);
  assert.deepEqual(shownCommand(formatModelNotice(shownOffer(REC_A)), "dismiss"), ["models", "dismiss", "release-A"]);
  const { result, enabled } = await runShown("switch", REC_A, REC_A, path);
  assert.equal(result, 0);
  assert.deepEqual(enabled, ["shown-A:4b"]);
  const s = await readSettings(path);
  assert.equal(s.generation?.model, "shown-A:4b");
  assert.equal(s.modelRecommendation?.id, "release-A");
  assert.equal(s.modelRecommendation?.answer, "switched");
  assert.equal(s.api?.token, "invented-token", "other settings survive");
});

// ── P1: model and answer are one write ───────────────────────────────────────

test("P1 half switch: a full disk on the commit leaves the old model AND no answer", async () => {
  const path = await settingsFile();
  const originalWrite = fs.writeFile;
  fs.writeFile = (async (p: never, data: unknown, ...rest: never[]) => {
    if (typeof data === "string" && data.includes('"switched"')) throw Object.assign(new Error("fixture: disk full"), { code: "ENOSPC" });
    return (originalWrite as (...a: unknown[]) => Promise<void>)(p, data, ...rest);
  }) as typeof fs.writeFile;
  syncBuiltinESMExports();
  let run;
  try {
    run = await runShown("switch", REC_A, REC_A, path);
  } finally {
    fs.writeFile = originalWrite;
    syncBuiltinESMExports();
  }
  assert.equal(run.result, 1, "reported as a failure, not thrown");
  assert.match(run.out, /disk full/);
  assert.match(run.out, /Nothing was changed/);
  const s = await readSettings(path);
  assert.equal(s.generation?.model, "old:4b", "no new model without its answer");
  assert.equal(s.modelRecommendation, undefined);
});

test("P1 two overlapping processes end in one consistent pair of model and answer", async () => {
  const path = await settingsFile();
  const gate = join(dir, `gate-${n++}`);
  const worker = fileURLToPath(new URL("./fixtures/model-switch-worker.mts", import.meta.url));
  const run = (role: string) => {
    const p = spawn(process.execPath, ["--import", "tsx", worker, path, ollamaUrl, role, gate], { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    p.stdout.on("data", (x) => (log += x));
    p.stderr.on("data", (x) => (log += x));
    return new Promise<{ code: number | null; log: string }>((r) => p.on("exit", (code) => r({ code, log })));
  };
  const a = run("A");
  for (let i = 0; ; i++) {
    assert.ok(i < 1500, "process A never reached the gate");
    if (await access(`${gate}.ready`).then(() => true, () => false)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const b = await run("B");
  assert.equal(b.code, 0, b.log);
  await writeFile(gate, "resume");
  const ar = await a;
  assert.equal(ar.code, 0, ar.log);
  const s = await readSettings(path);
  // B committed last. What must never be there is B's model next to A's answer.
  assert.equal(s.generation?.model, "fixture-B:4b");
  assert.equal(s.modelRecommendation?.id, "rec-B");
  assert.equal(s.modelRecommendation?.answer, "switched");
});

// ── P2: the test call stays on the local server ──────────────────────────────

test("P2 redirect: a redirected test call is a failed test call — nothing is switched", async () => {
  const path = await settingsFile();
  chatMode = "redirect";
  redirectedPosts = 0;
  try {
    const { result: r } = await quiet(() => enableGenerationModel("new:4b", { dryRun: false, verify: true }, path, fakeCli));
    assert.equal(r.activated, false);
    assert.match(r.message, /did not answer a test call/);
    assert.equal(redirectedPosts, 0, "the redirect target never sees the request");
    assert.equal(await readFile(path, "utf8"), EXISTING);
  } finally {
    chatMode = "ok";
  }
});

test("P2: the test call runs against a local Ollama only", async () => {
  const { testCallFailure } = await import("../src/cli/ollama.js");
  // Refused before any request is made — the hostname is never resolved.
  assert.match((await testCallFailure("new:4b", "http://ollama.example.invalid:11434")) ?? "", /only runs against a local Ollama/);
  assert.equal(await testCallFailure("new:4b", ollamaUrl), null);
});

test("no credentials or home paths in what a failed switch prints", async () => {
  const { testCallFailure } = await import("../src/cli/ollama.js");
  // A remote URL with credentials: only the host is named.
  const remote = (await testCallFailure("new:4b", "http://alice:s3cretpw@ollama.example.invalid:11434")) ?? "";
  assert.match(remote, /not ollama\.example\.invalid:11434/);
  assert.doesNotMatch(remote, /alice|s3cretpw/);
  // A loopback URL with credentials: fetch refuses it and quotes the URL in
  // its error — that quote must not reach the message.
  const local = (await testCallFailure("new:4b", ollamaUrl.replace("http://", "http://alice:s3cretpw@"))) ?? "";
  assert.notEqual(local, "", "a URL with credentials is not a working test call");
  assert.doesNotMatch(local, /s3cretpw/);
  // The refusal of a corrupt settings file names no content of that file.
  const path = await settingsFile('{"api":{"token":"invented-token"},BROKEN');
  const { result: r } = await quiet(() => enableGenerationModel("new:4b", { dryRun: false, verify: true }, path, fakeCli));
  assert.doesNotMatch(r.message, /invented-token|BROKEN/);
  const { out } = await runShown("dismiss", REC_A, REC_A, path);
  assert.doesNotMatch(out, /invented-token|BROKEN/);
});

// ── P2: the answer does not depend on this shell's environment ───────────────

test("P2 env split: the model is pinned in this shell, the daemon asked — the answer is still recorded", async () => {
  const saved = process.env.BASTRA_EXPAND_MODEL;
  for (const verb of ["switch", "dismiss"] as const) {
    const path = await settingsFile();
    delete process.env.BASTRA_EXPAND_MODEL;
    const daemonView = { recommendation: REC_A, ramGB: 16, settingsPath: path };
    assert.equal((await pendingModelNotice(daemonView))?.current, "old:4b", "the daemon (no env) offers the switch");
    process.env.BASTRA_EXPAND_MODEL = "shown-A:4b";
    try {
      assert.equal(await currentModelOffer(daemonView), null, "in this shell the recommended model is already in effect");
      const { result } = await runShown(verb, REC_A, REC_A, path);
      assert.equal(result, 0);
    } finally {
      delete process.env.BASTRA_EXPAND_MODEL;
    }
    const s = await readSettings(path);
    assert.equal(s.modelRecommendation?.answer, verb === "switch" ? "switched" : "dismissed");
    if (verb === "switch") assert.equal(s.generation?.model, "shown-A:4b", "the stored choice is what the daemon reads");
    assert.equal(await pendingModelNotice(daemonView), null, "the daemon stops asking");
  }
  if (saved !== undefined) process.env.BASTRA_EXPAND_MODEL = saved;
});

// ── further edges ────────────────────────────────────────────────────────────

test("corrupt settings: the safe switch and the answers refuse instead of overwriting the file", async () => {
  const CORRUPT = '{"generation":{"model":"old:4b"},"api":{"token":"invented-token"},BROKEN';
  const path = await settingsFile(CORRUPT);
  const { result: r } = await quiet(() => enableGenerationModel("new:4b", { dryRun: false, verify: true }, path, fakeCli));
  assert.equal(r.activated, false);
  assert.match(r.message, /not valid JSON/);
  assert.equal(await readFile(path, "utf8"), CORRUPT);
  for (const verb of ["switch", "later", "dismiss"] as const) {
    const { result, out } = await runShown(verb, REC_A, REC_A, path);
    assert.equal(result, 1);
    assert.match(out, /Nothing was changed/);
    assert.equal(await readFile(path, "utf8"), CORRUPT);
  }
});

test("a recommendation without an entry for this tier is no offer, not a crash", async () => {
  const path = await settingsFile();
  const partial = { id: "partial", models: { baseline: REC_A.models.baseline } } as ModelRecommendation;
  assert.equal(await currentModelOffer({ recommendation: partial, ramGB: 32, settingsPath: path }), null);
  assert.equal(await pendingModelNotice({ recommendation: partial, ramGB: 24, settingsPath: path }), null);
  assert.equal((await currentModelOffer({ recommendation: partial, ramGB: 16, settingsPath: path }))?.model, "shown-A:4b");
});
