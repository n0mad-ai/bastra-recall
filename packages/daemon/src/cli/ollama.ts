/**
 * Ollama provisioning for `bastra embeddings on` and `bastra install` (#79).
 *
 * OSS-side, autonomous: detect Ollama + the embeddinggemma model, install it
 * via Homebrew (if missing), start it, pull the model, and persist
 * `embedding.provider=ollama` into ~/.bastra/cli-settings.json. We delegate
 * the *install* to Homebrew (we bundle no binary — that stays Pro); we own
 * the *lifecycle* so semantic recall works without the Mac app. `bastra
 * embeddings on` (the install path) stays macOS-only (#84 tracks Windows);
 * the daemon-boot autostart path (`ensureOllamaServerForDaemon`, used once
 * `embedding.provider=ollama` is already configured — e.g. a manual Linux
 * install) also supervises the server via `systemd --user` on Linux, the
 * platform-native analogue of brew services.
 *
 * Consent lives with the CALLERS (`bastra embeddings on` is the consent; the
 * install-end prompt asks before calling) — this module never prompts.
 *
 * Safety contract: never throws, never exits, never hangs. Every external
 * command has a timeout and a closed stdin (so a sudo prompt fails fast instead
 * of blocking a non-interactive run). ensureOllama persists the provider only
 * after the model is verified present (enableSemanticRecall persists upfront —
 * see there).
 */
import { spawn } from "node:child_process";
import { findExecutable, run } from "./exec.js";
import { getOllamaAutostart, setEmbeddingProvider, setGenerationModel } from "../settings.js";

const OLLAMA_URL = (process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434").replace(/\/+$/, "");
const EMBED_MODEL = process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma";

export interface EnsureResult {
  status:
    | "skipped"
    | "unsupported"
    | "env-override"
    | "already-active"
    | "would-install"
    | "activated"
    | "error";
  message: string;
  activated: boolean;
}

// mode is deliberately NOT nullable: "auto" acts without asking, so every
// caller must have collected consent (flag, prompt, or the subcommand itself).
export async function ensureOllama(opts: { dryRun: boolean; mode: "auto" | "skip" }): Promise<EnsureResult> {
  try {
    if (opts.mode === "skip") {
      return { status: "skipped", activated: false, message: "skipped (--no-ollama) — semantic recall uses BM25 keyword search" };
    }
    // env wins over the file at runtime — don't burn a 620 MB download on a
    // choice the daemon will shadow. Checked before everything else: the
    // explicit user override outranks "unsupported here" on every OS.
    const envProvider = (process.env.BASTRA_EMBEDDING_PROVIDER ?? "").toLowerCase();
    if (envProvider && envProvider !== "ollama") {
      return {
        status: "env-override",
        activated: false,
        message: `BASTRA_EMBEDDING_PROVIDER=${envProvider} (env) overrides the config file — not setting up Ollama. Unset it (or set it to ollama) first.`,
      };
    }

    const ollamaBin = findExecutable("ollama");
    const serverUp = ollamaBin ? await serverVersion() : null;
    const hasModel = serverUp ? await modelPresent() : false;
    const fullyReady = Boolean(ollamaBin && serverUp && hasModel);

    // Everything already present → activation is cheap (no download, works on
    // every OS — the platform gate below only guards the brew-install path).
    if (fullyReady) {
      if (!opts.dryRun) await setEmbeddingProvider("ollama");
      return {
        status: "already-active",
        activated: !opts.dryRun,
        message: `Ollama ready (${serverUp})${opts.dryRun ? "; would enable semantic recall" : "; semantic recall ON"}`,
      };
    }

    // Something is missing → needs brew install / serve / pull (macOS-only today).
    if (process.platform !== "darwin") {
      return {
        status: "unsupported",
        activated: false,
        message:
          "automatic Ollama setup is macOS-only today (Windows: #84). Manual: install + start Ollama (https://ollama.com), pull the embeddinggemma model, then re-run: bastra embeddings on",
      };
    }
    if (opts.dryRun) {
      return {
        status: "would-install",
        activated: false,
        message: "would: brew install ollama (if missing) → start service → pull embeddinggemma (~620 MB) → activate",
      };
    }

    // Cost disclosure on the acting path (the caller's prompt already named
    // the download; this line marks the moment work actually starts).
    process.stdout.write("  → setting up Ollama: Homebrew install (if needed) + ~620 MB model + local login service\n");

    const autostart = await getOllamaAutostart();
    const brewBin = findExecutable("brew");

    // 1. binary
    let ollamaPath = ollamaBin;
    if (!ollamaPath) {
      if (!brewBin) {
        return {
          status: "unsupported",
          activated: false,
          message: "Ollama not found and Homebrew unavailable — install Ollama from https://ollama.com, then `bastra config set embedding.provider ollama`",
        };
      }
      const r = run(brewBin, ["install", "ollama"], { timeoutMs: 300_000, showProgress: true });
      if (!r.ok) return err(`brew install ollama failed (${r.detail})`);
      ollamaPath = findExecutable("ollama");
      if (!ollamaPath) return err("brew reported success but `ollama` is not on PATH — restart your shell, then retry");
    }

    // 2. server
    const serve = await ensureServing(autostart, brewBin, ollamaPath);
    if (!serve.ok) {
      return err(`Ollama installed but the server didn't start (${serve.detail}) — try \`ollama serve\` manually`);
    }

    // 3. model
    if (!(await modelPresent())) {
      const r = run(ollamaPath, ["pull", EMBED_MODEL], { timeoutMs: 1_800_000, showProgress: true });
      if (r.signal) return err(`model download was interrupted — re-run \`bastra embeddings on\` when ready`);
      if (!r.ok) return err(`\`ollama pull ${EMBED_MODEL}\` failed (${r.detail})`);
      // Interrupted pulls can exit 0 with an incomplete model — verify.
      if (!(await modelPresent())) return err(`model not present after pull — re-run \`ollama pull ${EMBED_MODEL}\``);
    }

    // 4. persist — only now, model verified present
    await setEmbeddingProvider("ollama");
    return {
      status: "activated",
      activated: true,
      message: `Ollama ready (${serve.detail}); semantic recall ON — restart the daemon to apply (first recall re-indexes the vault once, may take a minute on large vaults)`,
    };
  } catch (e) {
    return err(`Ollama setup error: ${(e as Error).message}`);
  }
}

function err(message: string): EnsureResult {
  return { status: "error", activated: false, message: `${message} — semantic recall stays OFF (BM25 keyword search still works)` };
}

/**
 * The `bastra embeddings on` core, shared with the install-end prompt (#79):
 * persist embedding.provider=ollama FIRST (the user's choice must survive a
 * flaky download — status/doctor then show "configured but model missing"
 * instead of silent none), then run the provisioning path. `settingsPath` is
 * injectable for tests only.
 */
export async function enableSemanticRecall(
  opts: { dryRun: boolean },
  settingsPath?: string,
): Promise<EnsureResult & { persisted: boolean }> {
  let persisted = false;
  if (!opts.dryRun) {
    // Exception: an env override shadows the file at runtime — still persist
    // (it's the user's declared intent; doctor explains the override), but
    // ensureOllama will refuse to download for a shadowed choice.
    await setEmbeddingProvider("ollama", settingsPath);
    persisted = true;
  }
  const result = await ensureOllama({ dryRun: opts.dryRun, mode: "auto" });
  return { ...result, persisted };
}

/** Is a specific Ollama model already pulled? Best-effort via /api/tags. */
export async function ollamaModelPresent(name: string): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).some((m) => m.name === name || m.name === `${name}:latest`);
  } catch {
    return false;
  }
}

/**
 * Pull a generation (doc2query + rerank) text model and persist the choice to
 * cli-settings.json. The text model is an add-on to the Ollama server that the
 * semantic-recall step already provisions — so this does NOT install Ollama; it
 * requires a running server and fails clearly if there isn't one.
 *
 * Idempotent: an already-present model skips the pull. `settingsPath` is
 * injectable for tests.
 */
export async function enableGenerationModel(
  model: string,
  opts: { dryRun: boolean } = { dryRun: false },
  settingsPath?: string,
): Promise<EnsureResult> {
  if (opts.dryRun) {
    return { status: "would-install", activated: false, message: `would pull ${model} + persist generation.model` };
  }
  const probe = await probeOllama();
  if (!probe.ok) {
    return {
      status: "error",
      activated: false,
      message: `Ollama isn't running — enable semantic recall first (that installs + starts it), then set the text model`,
    };
  }
  const ollamaPath = findExecutable("ollama");
  if (!ollamaPath) {
    return { status: "error", activated: false, message: "`ollama` is not on PATH — install it, then re-run" };
  }
  if (!(await ollamaModelPresent(model))) {
    process.stdout.write(`  → pulling ${model} (text model for doc2query + rerank)\n`);
    const r = run(ollamaPath, ["pull", model], { timeoutMs: 1_800_000, showProgress: true });
    if (r.signal) return { status: "error", activated: false, message: `pull of ${model} was interrupted — re-run when ready` };
    if (!r.ok) return { status: "error", activated: false, message: `\`ollama pull ${model}\` failed (${r.detail})` };
    if (!(await ollamaModelPresent(model))) return { status: "error", activated: false, message: `${model} not present after pull — re-run \`ollama pull ${model}\`` };
  }
  await setGenerationModel(model, settingsPath);
  return {
    status: "activated",
    activated: true,
    message: `text model ${model} ready + saved — restart the daemon to apply`,
  };
}

// ── Ollama HTTP probes ───────────────────────────────────────────────────────

async function serverVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    // Truthiness fallback (not ??): a 200 with version:"" still means reachable,
    // and every caller tests this with `if (await serverVersion())`.
    return data.version || "running";
  } catch {
    return null;
  }
}

async function modelPresent(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: { name?: string }[] };
    return (data.models ?? []).some((m) => {
      const n = m.name ?? "";
      return n === EMBED_MODEL || n.startsWith(`${EMBED_MODEL}:`);
    });
  } catch {
    return false;
  }
}

/** Pure arg builder for the Linux `systemd --user` autostart path — the
 *  platform-native analogue of `brew services start ollama`: a named,
 *  `--collect`-ed unit that `systemctl --user status/stop bastra-ollama`
 *  can see and manage, instead of an unref'd orphan with no supervisor.
 *  Kept pure (no spawn) so it's testable without shelling out. */
export function systemdRunOllamaArgs(ollamaPath: string): string[] {
  return ["--user", "--unit=bastra-ollama", "--collect", "--", ollamaPath, "serve"];
}

/** Loopback-Guard für den Daemon-Autostart: nur einen LOKALEN Ollama-Server
 *  starten — eine Remote-BASTRA_OLLAMA_URL kann der Daemon nicht "starten".
 *  Exported for unit tests. */
export function isLoopbackOllamaURL(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Daemon-Boot-Autostart: semantic recall ist auf Ollama konfiguriert, aber
 * der Server läuft nicht (z.B. Mac-App beendet, die ihr embedded Ollama
 * mitgenommen hat) → der Daemon zieht ihn selbst hoch. Probe-first
 * (Singleton-safe — dieselbe Semantik wie die Mac-App), respektiert
 * `ollama.autostart` (default true), nur für Loopback-URLs. Best-effort,
 * wirft nie — ohne Ollama bleibt Recall BM25-only und /health zeigt
 * "degraded" (#92).
 */
export async function ensureOllamaServerForDaemon(
  baseURL: string,
): Promise<{ started: boolean; detail: string }> {
  try {
    if (!isLoopbackOllamaURL(baseURL)) {
      return { started: false, detail: "remote ollama URL — not starting a local server" };
    }
    if (await serverVersion()) return { started: false, detail: "already running" };
    if (!(await getOllamaAutostart())) return { started: false, detail: "ollama.autostart off" };
    const bin = findExecutable("ollama");
    if (!bin) return { started: false, detail: "ollama binary not found on a trusted PATH" };
    const r = await ensureServing(true, findExecutable("brew"), bin);
    return { started: r.ok, detail: r.detail };
  } catch (err) {
    return { started: false, detail: (err as Error).message };
  }
}

/** Public, read-only probe for `bastra doctor`/`status`. Never throws. */
export async function probeOllama(): Promise<{ ok: boolean; detail: string; hasModel: boolean }> {
  const bin = findExecutable("ollama");
  if (!bin) return { ok: false, detail: "ollama not installed", hasModel: false };
  const ver = await serverVersion();
  if (!ver) return { ok: false, detail: "installed but server not running", hasModel: false };
  const model = await modelPresent();
  return { ok: true, detail: `running (${ver})`, hasModel: model };
}

// ── server lifecycle ─────────────────────────────────────────────────────────

async function ensureServing(
  autostart: boolean,
  brewBin: string | null,
  ollamaPath: string,
): Promise<{ ok: boolean; detail: string }> {
  // Already up (could be ours, the Pro app's, or a user's) — reuse it, don't
  // spawn a second server on the same port.
  if (await serverVersion()) return { ok: true, detail: "using already-running ollama on 11434" };

  // autostart on → persistent login agent via brew services (best for the
  // long-lived daemon). Falls back to a one-shot detached serve if brew
  // services is unavailable (e.g. headless/SSH, no GUI domain).
  if (autostart && brewBin) {
    const r = run(brewBin, ["services", "start", "ollama"], { timeoutMs: 30_000 });
    if (r.ok && (await pollServer(15_000))) return { ok: true, detail: "started via brew services (login agent)" };
  }

  // brew services may have launched the agent but bound slowly — re-probe once
  // before spawning a competing instance (avoids an EADDRINUSE race on 11434).
  if (await serverVersion()) return { ok: true, detail: "started via brew services (login agent)" };

  // Linux: systemd --user is the persistent-agent equivalent to brew services
  // on the one platform where a real service manager is standardly available.
  // A named, --collect-ed unit is supervised and stoppable (`systemctl --user
  // status/stop bastra-ollama`) instead of an unref'd orphan with no owner.
  if (autostart && process.platform === "linux") {
    const systemdRunBin = findExecutable("systemd-run");
    if (systemdRunBin) {
      const r = run(systemdRunBin, systemdRunOllamaArgs(ollamaPath), { timeoutMs: 10_000 });
      if (r.ok && (await pollServer(15_000))) {
        return { ok: true, detail: "started via systemd --user (bastra-ollama.service)" };
      }
    }
  }

  // one-shot detached serve (autostart off, or no supervisor is available)
  const child = spawn(ollamaPath, ["serve"], { detached: true, stdio: "ignore" });
  child.unref();
  if (await pollServer(15_000)) {
    return { ok: true, detail: autostart ? "started (detached — no supervisor available)" : "started (one-shot, autostart off)" };
  }
  return { ok: false, detail: "server not reachable within 15s" };
}

async function pollServer(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await serverVersion()) return true;
    await sleep(500);
  }
  return false;
}

// ── exec helpers ─────────────────────────────────────────────────────────────
// findExecutable() + run() live in exec.ts (shared with update.ts, #91).

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
