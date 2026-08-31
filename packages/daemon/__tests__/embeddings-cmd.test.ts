/**
 * Tests for `bastra embeddings <on|off|status>` + the install-end prompt
 * guards + the doctor note (#79).
 *
 * Only paths that never spawn a subprocess or touch the network are exercised:
 * `on` is tested via the env-override short-circuit (persists, refuses to
 * download), the acting path stays untested like in ollama-ensure.test.ts.
 * Settings go to a temp file via the injectable settingsPath.
 *
 * Run: npx tsx --test packages/daemon/__tests__/embeddings-cmd.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cmdEmbeddings,
  decideInstallRecallAction,
  formatEmbeddingDoctorLines,
  RECALL_OFF_NOTE,
} from "../src/cli/embeddings-cmd.js";
import { getEmbeddingProvider, setEmbeddingProvider } from "../src/settings.js";

async function withTempFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-embed-cmd-"));
  try {
    return await fn(join(dir, "cli-settings.json"));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/**
 * Runs fn with BASTRA_EMBEDDING_PROVIDER set (or deleted), capturing stdout.
 * Also clears OPENAI_API_KEY / BASTRA_EMBEDDING_KEY for the duration — a key
 * leaked from the test machine's shell would flip the api-key tier and make
 * these assertions environment-dependent.
 */
async function withEnvAndStdout(
  envValue: string | null,
  fn: () => Promise<number>,
): Promise<{ rc: number; out: string }> {
  const prev: Record<string, string | undefined> = {
    BASTRA_EMBEDDING_PROVIDER: process.env.BASTRA_EMBEDDING_PROVIDER,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    BASTRA_EMBEDDING_KEY: process.env.BASTRA_EMBEDDING_KEY,
  };
  delete process.env.OPENAI_API_KEY;
  delete process.env.BASTRA_EMBEDDING_KEY;
  if (envValue === null) delete process.env.BASTRA_EMBEDDING_PROVIDER;
  else process.env.BASTRA_EMBEDDING_PROVIDER = envValue;
  const origWrite = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    const rc = await fn();
    return { rc, out };
  } finally {
    process.stdout.write = origWrite;
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ─── subcommand handlers ─────────────────────────────────────────────────────

test("embeddings off: persists none, prints the re-enable one-liner", async () => {
  await withTempFile(async (path) => {
    const { rc, out } = await withEnvAndStdout(null, () => cmdEmbeddings({ sub: "off", settingsPath: path }));
    assert.equal(rc, 0);
    assert.equal(await getEmbeddingProvider(path), "none");
    assert.match(out, /✓ embedding\.provider = none/);
    assert.match(out, /Re-enable: bastra embeddings on/);
  });
});

test("embeddings off: warns when an env override will shadow the setting", async () => {
  await withTempFile(async (path) => {
    const { rc, out } = await withEnvAndStdout("ollama", () => cmdEmbeddings({ sub: "off", settingsPath: path }));
    assert.equal(rc, 0);
    assert.match(out, /BASTRA_EMBEDDING_PROVIDER=ollama \(env\) overrides this/);
  });
});

test("embeddings on: setting is persisted even when env overrides (no download for a shadowed choice)", async () => {
  await withTempFile(async (path) => {
    // env=none blocks provisioning (ensureOllama env-override guard, no
    // subprocess/network) — but the user's declared intent must survive.
    const { rc, out } = await withEnvAndStdout("none", () => cmdEmbeddings({ sub: "on", settingsPath: path }));
    assert.equal(rc, 0);
    assert.equal(await getEmbeddingProvider(path), "ollama");
    assert.match(out, /✓ embedding\.provider = ollama/);
    assert.match(out, /overrides the config file/);
  });
});

test("embeddings status: default state names the default source and the OFF note", async () => {
  await withTempFile(async (path) => {
    const noDaemon = async () => ({ ok: false as const, detail: "unreachable" });
    const { rc, out } = await withEnvAndStdout(null, () => cmdEmbeddings({ sub: "status", settingsPath: path, probe: noDaemon }));
    assert.equal(rc, 0);
    assert.match(out, /effective provider: none/);
    assert.match(out, /resolved via: default \(nothing configured\)/);
    assert.match(out, /Enable: bastra embeddings on/);
  });
});

test("embeddings status: env override over a different file value is called out", async () => {
  await withTempFile(async (path) => {
    await setEmbeddingProvider("ollama", path);
    // env=openai without a key → effective none via env, requested=openai.
    const { out } = await withEnvAndStdout("openai", () => cmdEmbeddings({ sub: "status", settingsPath: path }));
    assert.match(out, /BASTRA_EMBEDDING_PROVIDER=openai \(env\) overrides embedding\.provider=ollama \(cli-settings\)/);
    assert.match(out, /openai is requested but no API key/);
  });
});

test("embeddings: unknown subcommand → usage + exit 2", async () => {
  await withTempFile(async (path) => {
    const { rc } = await withEnvAndStdout(null, () => cmdEmbeddings({ sub: "enable", settingsPath: path }));
    assert.equal(rc, 2);
  });
});

// ─── install-end prompt guards (pure decision, no TTY needed) ────────────────

test("install step: --no-ollama skips when no provider is effective", () => {
  const a = decideInstallRecallAction({ ollamaFlag: "skip", effectiveProvider: "none", interactive: true, yes: false, dryRun: false });
  assert.equal(a, "skip");
});

test("install step: --no-ollama with an already-effective provider stays silent (it skips provisioning, it disables nothing — e.g. `bastra update`'s hard-skip)", () => {
  const a = decideInstallRecallAction({ ollamaFlag: "skip", effectiveProvider: "ollama", interactive: true, yes: false, dryRun: false });
  assert.equal(a, "silent");
});

test("install step: --ollama provisions without asking (flag = consent)", () => {
  const a = decideInstallRecallAction({ ollamaFlag: "auto", effectiveProvider: "none", interactive: false, yes: true, dryRun: false });
  assert.equal(a, "provision");
});

test("install step: an already-effective provider (env or setting) stays silent", () => {
  for (const p of ["ollama", "openai"] as const) {
    const a = decideInstallRecallAction({ ollamaFlag: null, effectiveProvider: p, interactive: true, yes: false, dryRun: false });
    assert.equal(a, "silent");
  }
});

test("install step: non-TTY never prompts (never hangs) — hint instead", () => {
  const a = decideInstallRecallAction({ ollamaFlag: null, effectiveProvider: "none", interactive: false, yes: false, dryRun: false });
  assert.equal(a, "hint");
});

test("install step: --yes suppresses the prompt (non-interactive convention) — hint instead", () => {
  const a = decideInstallRecallAction({ ollamaFlag: null, effectiveProvider: "none", interactive: true, yes: true, dryRun: false });
  assert.equal(a, "hint");
});

test("install step: --dry-run never prompts and never writes — hint instead", () => {
  const a = decideInstallRecallAction({ ollamaFlag: null, effectiveProvider: "none", interactive: true, yes: false, dryRun: true });
  assert.equal(a, "hint");
});

test("install step: interactive TTY with no effective provider → ask once", () => {
  const a = decideInstallRecallAction({ ollamaFlag: null, effectiveProvider: "none", interactive: true, yes: false, dryRun: false });
  assert.equal(a, "prompt");
});

// ─── doctor note ─────────────────────────────────────────────────────────────

test("doctor: effective none → the exact OFF note, as a note (not a failure)", () => {
  const lines = formatEmbeddingDoctorLines({
    choice: { provider: "none", source: "none" },
    fileProvider: undefined,
    envValue: undefined,
    probe: null,
  });
  assert.equal(lines[0], "→ semantic recall");
  assert.equal(lines[1], `  note: ${RECALL_OFF_NOTE}`);
  // Pinned on substance, not on the sentence: the note must say what is off,
  // what it costs the user (#103's measured figures — the reason the default
  // stays opt-in is that the price is real, so the benefit has to be stated),
  // and how to turn it on. Rewording is fine; dropping one of the three is the
  // regression, because the prompt then asks for 620 MB and names no gain.
  assert.match(RECALL_OFF_NOTE, /Semantic recall is OFF/);
  assert.match(RECALL_OFF_NOTE, /61%/);
  assert.match(RECALL_OFF_NOTE, /80%/);
  assert.match(RECALL_OFF_NOTE, /bastra embeddings on/);
});

test("doctor: live semantic daemon overrides a shell-only none view", () => {
  const lines = formatEmbeddingDoctorLines({
    choice: { provider: "none", source: "none" },
    fileProvider: undefined,
    envValue: undefined,
    probe: null,
    daemon: {
      semanticRecall: "on",
      embeddingMode: "ollama-embeddinggemma",
      embeddingSource: "env",
    },
  });
  assert.ok(lines.includes("  ✓ ok: running daemon uses ollama-embeddinggemma (source: env)"));
  assert.ok(!lines.some((line) => line.includes("Semantic recall is OFF")));
});

test("doctor: configured ollama with the model missing → actionable warning", () => {
  const lines = formatEmbeddingDoctorLines({
    choice: { provider: "ollama", source: "cli-settings" },
    fileProvider: "ollama",
    envValue: undefined,
    probe: { ok: true, detail: "running (0.9.1)", hasModel: false },
  });
  assert.ok(lines.some((l) => /⚠ configured \(ollama, source: cli-settings\) but the embeddinggemma model is missing/.test(l)));
  assert.ok(lines.some((l) => /Fix: bastra embeddings on/.test(l)));
});

test("doctor: configured ollama but server unreachable → actionable warning with the probe detail", () => {
  const lines = formatEmbeddingDoctorLines({
    choice: { provider: "ollama", source: "env" },
    fileProvider: undefined,
    envValue: "ollama",
    probe: { ok: false, detail: "installed but server not running", hasModel: false },
  });
  assert.ok(lines.some((l) => /⚠ configured \(ollama, source: env\) but installed but server not running/.test(l)));
});

test("doctor: env overriding a different file value is mentioned", () => {
  const lines = formatEmbeddingDoctorLines({
    choice: { provider: "none", source: "env" },
    fileProvider: "ollama",
    envValue: "none",
    probe: null,
  });
  assert.ok(lines.some((l) => l === "  note: BASTRA_EMBEDDING_PROVIDER=none (env) overrides embedding.provider=ollama (cli-settings)"));
});

test("doctor: healthy ollama → quiet ok line, no warnings", () => {
  const lines = formatEmbeddingDoctorLines({
    choice: { provider: "ollama", source: "cli-settings" },
    fileProvider: "ollama",
    envValue: undefined,
    probe: { ok: true, detail: "running (0.9.1)", hasModel: true },
  });
  assert.ok(lines.some((l) => /✓ ok: ollama running \(0\.9\.1\), model embeddinggemma present \(source: cli-settings\)/.test(l)));
  assert.ok(!lines.some((l) => l.includes("⚠")));
});

test("install decision: running daemon with semantic recall ON silences the prompt (host-test find 2026-07-03)", () => {
  // Shell view says none (LaunchAgent env is invisible to the CLI), but the
  // running daemon reports semantic recall on — never prompt in that state.
  const a = decideInstallRecallAction({
    ollamaFlag: null,
    effectiveProvider: "none",
    interactive: true,
    yes: false,
    dryRun: false,
    daemonSemanticOn: true,
  });
  assert.equal(a, "silent");
});

test("install decision: unreachable daemon (no signal) keeps the prompt", () => {
  const a = decideInstallRecallAction({
    ollamaFlag: null,
    effectiveProvider: "none",
    interactive: true,
    yes: false,
    dryRun: false,
    daemonSemanticOn: false,
  });
  assert.equal(a, "prompt");
});

test("embeddings status: running daemon with semantic recall ON shows both views and suppresses the OFF note", async () => {
  await withTempFile(async (path) => {
    const daemonOn = async () => ({
      ok: true as const,
      detail: "vault_size=1",
      semanticRecall: "on",
      embeddingMode: "ollama-embeddinggemma",
      embeddingSource: "env",
    });
    const { rc, out } = await withEnvAndStdout(null, () => cmdEmbeddings({ sub: "status", settingsPath: path, probe: daemonOn }));
    assert.equal(rc, 0);
    assert.match(out, /running daemon: semantic recall on \(ollama-embeddinggemma, source: env\)/);
    assert.match(out, /daemon runs with its own environment/);
    assert.ok(!/Enable: bastra embeddings on/.test(out), "OFF note must be suppressed when the daemon is semantic");
  });
});
