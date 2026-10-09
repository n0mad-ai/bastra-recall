/**
 * The safe switch makes no request to the raw configured Ollama URL: its probes
 * use the same local, token-free address as the test call. fetch is replaced
 * in a child process (fixtures/model-url-preflight.mts).
 *
 * Second counter-review of the model-recommendation notice (PR #1118, on
 * 1fc5ad07); its reproduction kept as a test. No Ollama, only invented files.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/model-switch-preflight.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { localOllamaTarget } from "../src/cli/ollama.js";
import { readSettings } from "../src/settings.js";
import { ORIGINAL, withDir } from "./fixtures/model-decision-helpers.js";
// ── P2: no request to the raw configured URL ─────────────────────────────────

function switchRequests(configured: string, settingsPath: string): { result: { activated: boolean; message: string }; requests: { url: string; redirect: string }[] } {
  const fixture = fileURLToPath(new URL("./fixtures/model-url-preflight.mts", import.meta.url));
  const r = spawnSync(process.execPath, ["--import", "tsx", fixture, configured, settingsPath], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
}

test("P2 preflight: a remote URL with a token gets no request at all from the safe switch", async () => {
  await withDir(async (_dir, path) => {
    const { result, requests } = switchRequests("http://ollama.example.invalid:11434/?token=invented-url-secret", path);
    assert.deepEqual(requests, [], "not the version probe, not the tags probe, not the test call");
    assert.equal(result.activated, false);
    assert.equal(
      result.message,
      "new:4b cannot be checked with a test call: the test call only runs against a local Ollama, not ollama.example.invalid:11434 — use 'bastra models set new:4b' to switch without it",
    );
    assert.equal(await readFile(path, "utf8"), ORIGINAL);
  });
});

test("P2 preflight: credentials in the URL — refused before the first request, never quoted", async () => {
  await withDir(async (_dir, path) => {
    for (const configured of ["http://alice:s3cretpw@127.0.0.1:11434", "http:\\\\alice:s3cretpw@127.0.0.1:11434", "alice:s3cretpw@127.0.0.1:11434", "http://alice:s3cretpw@"]) {
      const { result, requests } = switchRequests(configured, path);
      assert.deepEqual(requests, [], configured);
      assert.equal(result.activated, false);
      assert.doesNotMatch(result.message, /alice|s3cretpw/, configured);
    }
    assert.equal(await readFile(path, "utf8"), ORIGINAL);
  });
});

test("P2 preflight: a local URL with a query token — every request goes to the token-free address and refuses redirects", async () => {
  await withDir(async (_dir, path) => {
    const { result, requests } = switchRequests("http://127.0.0.1:11434/?token=invented-url-secret#frag", path);
    assert.equal(result.activated, true, result.message);
    assert.deepEqual(requests, [
      { url: "http://127.0.0.1:11434/api/version", redirect: "error" },
      { url: "http://127.0.0.1:11434/api/tags", redirect: "error" },
      { url: "http://127.0.0.1:11434/api/chat", redirect: "error" },
    ]);
    const s = await readSettings(path);
    assert.equal(s.generation?.model, "new:4b");
    assert.equal(s.modelRecommendation?.answer, "switched");
  });
});

test("the one address: parsed once, local only, without credentials, query or fragment", () => {
  assert.deepEqual(localOllamaTarget("http://localhost:11434/"), { ok: true, url: "http://localhost:11434" });
  assert.deepEqual(localOllamaTarget("http://[::1]:11434/ollama/?x=1#y"), { ok: true, url: "http://[::1]:11434/ollama" });
  assert.equal(localOllamaTarget("http://bob@127.0.0.1:11434").ok, false);
  assert.equal(localOllamaTarget("ftp://127.0.0.1").ok, false);
  assert.equal(localOllamaTarget("not a url").ok, false);
  assert.deepEqual(localOllamaTarget("https://ollama.example.invalid/?token=t"), { ok: false, reason: "the test call only runs against a local Ollama, not ollama.example.invalid" });
});
