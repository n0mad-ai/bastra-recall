import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ensureOllama, isLoopbackOllamaURL, systemdRunOllamaArgs } from "../src/cli/ollama.js";

// These cover the paths that must NEVER spawn a subprocess or download
// anything — the safety guards. We deliberately do not test the acting path
// (it would shell out to brew/ollama).

test("ensureOllama: --no-ollama skips, no detection, no mutation", async () => {
  const r = await ensureOllama({ dryRun: false, mode: "skip" });
  assert.equal(r.status, "skipped");
  assert.equal(r.activated, false);
});

test("ensureOllama: env BASTRA_EMBEDDING_PROVIDER=none blocks setup before any download", async () => {
  const prev = process.env.BASTRA_EMBEDDING_PROVIDER;
  process.env.BASTRA_EMBEDDING_PROVIDER = "none";
  try {
    // mode "auto" would otherwise act — the env guard must short-circuit first.
    const r = await ensureOllama({ dryRun: false, mode: "auto" });
    assert.equal(r.status, "env-override");
    assert.equal(r.activated, false);
  } finally {
    if (prev === undefined) delete process.env.BASTRA_EMBEDDING_PROVIDER;
    else process.env.BASTRA_EMBEDDING_PROVIDER = prev;
  }
});

test("systemdRunOllamaArgs: a named, --collect-ed --user unit — visible and stoppable, not an unref'd orphan", () => {
  assert.deepEqual(systemdRunOllamaArgs("/usr/bin/ollama"), [
    "--user",
    "--unit=bastra-ollama",
    "--collect",
    "--",
    "/usr/bin/ollama",
    "serve",
  ]);
  // The unit name is fixed — it's how `systemctl --user status/stop
  // bastra-ollama` finds it regardless of which ollama binary resolved.
  assert.equal(systemdRunOllamaArgs("/opt/homebrew/bin/ollama")[1], "--unit=bastra-ollama");
});

test("the systemd path re-probes before it risks a second server on 11434", () => {
  // The acting path shells out to systemd-run, so it is not run here (and there
  // is no systemd on macOS at all). What can be checked is the shape the brew
  // path already has: between the systemd attempt and the detached spawn there
  // must be a serverVersion() re-probe. `r.ok &&` short-circuits the poll when
  // systemd-run exits non-zero — the likely cause being a unit that already
  // exists and is serving — so without the re-probe that case spawns a rival.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "src", "cli", "ollama.ts"), "utf8");
  const start = src.indexOf('if (autostart && process.platform === "linux")');
  assert.ok(start > 0, "the Linux autostart branch is unfindable");
  const spawnIdx = src.indexOf("spawn(ollamaPath", start);
  assert.ok(spawnIdx > start, "the detached fallback no longer follows the Linux branch");
  const between = src.slice(start, spawnIdx);
  assert.ok(
    /if \(await serverVersion\(\)\) return/.test(between),
    "no re-probe between the systemd attempt and the detached spawn",
  );
  // And the acting part stays behind the platform gate — macOS never enters it.
  const body = src.slice(src.indexOf("async function ensureServing"));
  assert.ok(
    body.indexOf("systemdRunOllamaArgs(ollamaPath") > body.indexOf('process.platform === "linux"'),
    "the systemd invocation is not behind the linux gate",
  );
});

test("the detached fallback keeps macOS's precise diagnosis", () => {
  // The generic wording is for platforms where brew was never the supervisor;
  // on darwin brew services IS the only one we try, so the log keeps saying so.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "src", "cli", "ollama.ts"), "utf8");
  assert.ok(src.includes('process.platform === "darwin" ? "brew services unavailable"'));
});

test("isLoopbackOllamaURL: daemon autostart only ever targets a LOCAL server", () => {
  assert.equal(isLoopbackOllamaURL("http://localhost:11434"), true);
  assert.equal(isLoopbackOllamaURL("http://127.0.0.1:11434"), true);
  assert.equal(isLoopbackOllamaURL("http://[::1]:11434"), true);
  assert.equal(isLoopbackOllamaURL("http://ollama.lan:11434"), false);
  assert.equal(isLoopbackOllamaURL("https://api.example.com"), false);
  assert.equal(isLoopbackOllamaURL("not a url"), false);
});
