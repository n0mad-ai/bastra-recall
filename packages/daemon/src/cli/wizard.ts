/**
 * `bastra install` (no surface, on a terminal) — the guided setup wizard (#15).
 *
 * Selection lists instead of y/n text prompts: vault location (create the
 * default or pick a folder), AI clients (multiselect, detected ones
 * preselected), stop-hook (claude-code, default on), semantic recall (enable /
 * keyword-only), generation text model (hardware-tiered), Bastra Commons +
 * shared bridges (opt-in, default off), auto-update mode, product-doc capture,
 * and — only when this runs from an npx cache — the `bastra` command itself
 * (#317), which npx otherwise leaves off the PATH entirely.
 * Built on @clack/prompts; every prompt is cancellable (Ctrl-C → clean exit,
 * nothing written).
 *
 * The wizard is a front-end only: it collects choices, then drives the exact
 * same machinery as `bastra install all` (createVaultAt, adapter.install,
 * enableSemanticRecall) — no second install path. Scripted flows
 * (`install all`, `--yes`, non-TTY, `--dry-run`) never reach it; see
 * shouldRunWizard.
 */
import * as p from "@clack/prompts";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ADAPTERS } from "./registry.js";
import { ensureHookStub } from "./stub-install.js";
import {
  VERSION,
  resolveVault,
  defaultVaultPath,
  createVaultAt,
  probeVaultPresence,
  DEFAULT_VAULT_DISPLAY,
  probeDaemon,
  type VaultPresence,
} from "./helpers.js";
import { FORWARDER_SCRIPT_PATH } from "./paths.js";
import { ensureDaemonRunning, type DaemonStartOutcome } from "./daemon-start.js";
import { mapUrl } from "./map-cmd.js";
import { findExecutable } from "./exec.js";
import {
  CLI_DECLINED_NOTE,
  CLI_PACKAGE,
  decideCliOnPath,
  formatGlobalInstallOutcome,
  installCliGlobally,
} from "./cli-on-path.js";
import { RECALL_OFF_NOTE } from "./embeddings-cmd.js";
import { enableSemanticRecall, enableGenerationModel, probeOllama, ollamaModelPresent } from "./ollama.js";
import { detectHardware, recommendTextModel } from "./hardware.js";
import { cmdCommons } from "./commons.js";
import {
  resolveEmbeddingChoice,
  resolveGenerationModel,
  setSharedRecallEnabled,
  setUpdateMode,
  setDocsMode,
  setUiEnabled,
  DEFAULT_UPDATE_MODE,
  DEFAULT_DOCS_MODE,
  type UpdateMode,
  type DocsMode,
} from "../settings.js";
import type { InstallResult, ParsedArgs } from "./types.js";

/**
 * Pure gate — exported for tests. The wizard replaces the bare-`install`
 * "missing surface" error ONLY on an interactive terminal without automation
 * flags; every scripted invocation keeps today's deterministic behavior.
 */
export function shouldRunWizard(i: {
  surface: string | null;
  interactive: boolean;
  yes: boolean;
  dryRun: boolean;
}): boolean {
  return i.surface === null && i.interactive && !i.yes && !i.dryRun;
}

/** Filesystem traces that mean "this client exists on this machine". */
const SURFACE_TRACES: Record<string, string[]> = {
  "claude-code": [".claude.json", ".claude"],
  codex: [".codex", "/Applications/ChatGPT.app"],
  "claude-desktop": [
    "Library/Application Support/Claude",
    "/Applications/Claude.app",
  ],
  cursor: [".cursor", "/Applications/Cursor.app"],
};

export function detectSurfaces(home: string = homedir()): Record<string, boolean> {
  const present: Record<string, boolean> = {};
  for (const [surface, traces] of Object.entries(SURFACE_TRACES)) {
    present[surface] = traces.some((t) =>
      existsSync(isAbsolute(t) ? t : resolve(home, t)),
    );
  }
  return present;
}

export interface SurfaceChoice {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Pure options builder — exported for tests. Detected clients are
 * preselected; when nothing is detected (fresh machine, traces appear only
 * after first app launch) everything is preselected so plain-Enter still
 * yields a complete install.
 */
export function buildSurfaceChoices(present: Record<string, boolean>): {
  options: SurfaceChoice[];
  initialValues: string[];
} {
  const options = Object.entries(ADAPTERS).map(([surface, adapter]) => ({
    value: surface,
    label: adapter.description.replace(/\s*\(.*\)$/, ""),
    hint: present[surface] ? "detected" : "not detected",
  }));
  const detected = options.filter((o) => present[o.value]).map((o) => o.value);
  return { options, initialValues: detected.length > 0 ? detected : options.map((o) => o.value) };
}

/** "74 memories" / "1 memory" — used by the prompt and the log line. */
export function memoryCountPhrase(n: number): string {
  return `${n} ${n === 1 ? "memory" : "memories"}`;
}

export interface VaultOption {
  label: string;
  hint?: string;
}

/**
 * Wording of the default-vault option (#318) — pure, exported for tests.
 *
 * "Create ~/BastraVault" told the user the folder does not exist yet, and it
 * said so over a vault holding 74 memories. Someone reinstalling, or trying
 * again after a failed attempt, had no way to tell from this prompt that they
 * were pointing at an existing vault. Same choice either way — name what is
 * there instead. An empty or absent folder really is created, so "Create"
 * stays right for that case.
 */
export function defaultVaultOption(
  presence: VaultPresence,
  display: string = DEFAULT_VAULT_DISPLAY,
): VaultOption {
  if (!presence.exists || presence.memoryCount === 0) {
    return { label: `Create ${display}`, hint: "recommended" };
  }
  return { label: `Use ${display}`, hint: `${memoryCountPhrase(presence.memoryCount)} already there` };
}

/** `~`/relative → absolute, for the custom-vault text input. Exported for tests. */
export function expandUserPath(input: string, home: string = homedir()): string {
  const trimmed = input.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return resolve(home, trimmed.slice(2));
  return resolve(trimmed);
}

/**
 * Pure decision for the wizard's semantic-recall step — the wizard's analogue
 * of decideInstallRecallAction, same precedence (exported for tests):
 *   --ollama            → "on" (explicit flag = consent, never ask)
 *   provider effective or the running daemon is semantic → "already"
 *   --no-ollama         → "later" (explicit opt-out, never ask)
 *   otherwise           → "ask"
 */
export function decideWizardSemantic(i: {
  ollamaFlag: "auto" | "skip" | null;
  effectiveProvider: string;
  daemonSemanticOn: boolean;
}): "on" | "later" | "already" | "ask" {
  if (i.ollamaFlag === "auto") return "on";
  if (i.effectiveProvider !== "none" || i.daemonSemanticOn) return "already";
  if (i.ollamaFlag === "skip") return "later";
  return "ask";
}

function bailed(value: unknown): value is symbol {
  return p.isCancel(value);
}

const CANCEL_MSG = "Setup cancelled — nothing was changed.";

/**
 * The closing vault-map line — pure, exported for tests (the wizard itself is
 * the @clack shell around it). A map whose daemon never came up must not be
 * handed over as a link: that URL was the one the #322 reporter clicked.
 */
export function vaultMapOutcomeLine(
  daemon: DaemonStartOutcome,
  url: string,
): { level: "success" | "warn"; text: string } {
  if (daemon.ok) {
    return { level: "success", text: `Vault map: ${url} (read per request — no restart needed)` };
  }
  return {
    level: "warn",
    text:
      `Vault map: enabled, but the daemon did not start (${daemon.detail}).\n` +
      `The map needs it — open it later with: bastra map`,
  };
}

/** Injectable for tests only — the real ones write settings and start a daemon. */
export interface VaultMapStepIO {
  enableMap(): Promise<void>;
  ensureDaemon: typeof ensureDaemonRunning;
  url(): string;
}

/**
 * The setup's vault-map step: enable the map, bring the daemon up, and only
 * then say what the URL is good for. The order is the fix (#322) — /ui is a
 * daemon route, and this line is where the user first meets it and the only
 * place they click it from. A fresh install has no daemon yet: nothing
 * registers a LaunchAgent, and the forwarder spawns one on the first MCP call,
 * which is a client restart away. Exported with injectable IO so that order is
 * verifiable without a real daemon; the wizard renders the returned line.
 */
export async function vaultMapSetupStep(
  opts: { vaultPath?: string; onStarting?: () => void } = {},
  io: Partial<VaultMapStepIO> = {},
): Promise<{ level: "success" | "warn"; text: string }> {
  const enableMap = io.enableMap ?? (() => setUiEnabled(true));
  const ensureDaemon = io.ensureDaemon ?? ensureDaemonRunning;
  const url = io.url ?? mapUrl;

  await enableMap();
  const daemon = await ensureDaemon({ vaultPath: opts.vaultPath, onStarting: opts.onStarting });
  return vaultMapOutcomeLine(daemon, url());
}

export async function runInstallWizard(args: ParsedArgs): Promise<number> {
  p.intro(`bastra-recall ${VERSION} — guided setup`);

  // ── 1. vault ──────────────────────────────────────────────────────────────
  // Same resolution order as every other path: --vault flag > env > detected
  // from an existing registration. Only a truly unconfigured machine is asked.
  let vaultPath: string | null = null;
  let vaultNeedsCreate = false;
  // What is already at the chosen folder (#318) — decides the prompt's wording
  // and, later, whether "Vault created" is a true sentence.
  let vaultPresence: VaultPresence = { exists: false, memoryCount: 0 };
  const preResolved = await resolveVault({ dryRun: false, vaultPath: args.vaultPath });
  if ("path" in preResolved) {
    vaultPath = preResolved.path;
    p.log.info(`Memory vault: ${vaultPath} (already configured)`);
  } else {
    // Look before offering to create it (#318): an existing vault gets named,
    // never re-offered as a fresh folder.
    vaultPresence = await probeVaultPresence(defaultVaultPath());
    const where = await p.select({
      message: "Where should your memories live? (plain markdown files you can read and back up)",
      options: [
        { value: "default", ...defaultVaultOption(vaultPresence) },
        { value: "custom", label: "Pick a custom folder…" },
      ],
      initialValue: "default",
    });
    if (bailed(where)) { p.cancel(CANCEL_MSG); return 1; }
    if (where === "default") {
      vaultPath = defaultVaultPath();
    } else {
      const custom = await p.text({
        message: "Vault folder (created if missing)",
        placeholder: DEFAULT_VAULT_DISPLAY,
        validate: (v) => (v && v.trim().length > 0 ? undefined : "enter a folder path"),
      });
      if (bailed(custom)) { p.cancel(CANCEL_MSG); return 1; }
      vaultPath = expandUserPath(custom);
      // Echo the expanded absolute path NOW — a typo ('~/Documets/…') or a
      // CWD-relative surprise must be visible before anything acts on it
      // (Ctrl-C on the next question still aborts with nothing written).
      p.log.info(`Vault folder: ${vaultPath}`);
      // A typed path deserves the same honesty as the default one (#318).
      vaultPresence = await probeVaultPresence(vaultPath);
      if (vaultPresence.memoryCount > 0) {
        p.log.info(`${memoryCountPhrase(vaultPresence.memoryCount)} already there — they stay, nothing is overwritten.`);
      }
    }
    vaultNeedsCreate = true;
  }

  // ── 2. clients ────────────────────────────────────────────────────────────
  const { options, initialValues } = buildSurfaceChoices(detectSurfaces());
  const chosen = await p.multiselect({
    message: "Which AI clients should get the memory tool? (space to toggle, enter to confirm)",
    options,
    initialValues,
    required: true,
  });
  if (bailed(chosen)) { p.cancel(CANCEL_MSG); return 1; }

  // ── 2b. stop hook (Claude Code and Codex) ──────────────────────────────────
  // Live-validated (#48), so it now defaults ON, but stays a visible toggle: if
  // it ever gets noisy the user can turn it off here (or re-run
  // `bastra install claude-code --no-stop-hook`).
  let stopHook = args.withStopHook;
  const hookSurfaces = (chosen as string[]).filter((surface) => surface === "claude-code" || surface === "codex");
  if (hookSurfaces.length > 0) {
    const hookAns = await p.select({
      message: `Stop-hook for ${hookSurfaces.map((surface) => surface === "codex" ? "Codex/ChatGPT" : "Claude Code").join(" + ")}? (at the end of a turn, suggests what's worth saving to memory)`,
      options: [
        { value: "on", label: "Enable — recommended", hint: "silently writes save-suggestions to a file; no chat noise" },
        { value: "off", label: "Off", hint: `enable later: bastra install ${hookSurfaces[0]} --with-stop-hook` },
      ],
      initialValue: "on",
    });
    if (bailed(hookAns)) { p.cancel(CANCEL_MSG); return 1; }
    stopHook = hookAns === "on";
  }

  // ── 3. semantic recall ────────────────────────────────────────────────────
  // Same precedence as decideInstallRecallAction: --ollama/--no-ollama are
  // consent/opt-out and suppress the question; an already-effective provider
  // or a semantic RUNNING daemon (LaunchAgent env is invisible to this
  // shell) means there is nothing to ask.
  const choice = await resolveEmbeddingChoice();
  let daemonOn = false;
  if (args.ollama === null && choice.provider === "none") {
    try {
      const probe = await probeDaemon();
      daemonOn = probe.ok && probe.semanticRecall === "on";
    } catch { /* unreachable daemon = no signal */ }
  }
  let semantic = decideWizardSemantic({
    ollamaFlag: args.ollama,
    effectiveProvider: choice.provider,
    daemonSemanticOn: daemonOn,
  });
  if (semantic === "already") {
    p.log.info(
      choice.provider !== "none"
        ? `Semantic recall: already configured (${choice.provider}, source: ${choice.source})`
        : "Semantic recall: already ON in the running daemon",
    );
  } else if (semantic === "ask") {
    const answer = await p.select({
      message: "Semantic recall? (multilingual vector search on top of keyword search)",
      options: [
        {
          value: "on",
          label: "Enable — best recall quality",
          hint: "downloads the embeddinggemma model (~620 MB) via Ollama, installed with Homebrew if missing",
        },
        {
          value: "later",
          label: "Not now — keyword search only (BM25)",
          hint: "enable anytime: bastra embeddings on",
        },
      ],
      initialValue: "on",
    });
    if (bailed(answer)) { p.cancel(CANCEL_MSG); return 1; }
    semantic = answer as "on" | "later";
  }

  // ── 4. generation text model ──────────────────────────────────────────────
  // The text model rides on the Ollama server semantic recall uses. Offered when
  // recall is freshly being enabled ("on"), OR already configured ("already")
  // but no generation model is pulled yet — the common existing-user case (they
  // set up embeddings before this step existed). Below the 16 GB RAM tier the
  // recommendation is "none" and the step is skipped entirely.
  let textModel: string | null = null;
  let offerTextModel = semantic === "on";
  // Only when recall actually runs on Ollama: the doc2query/rerank model is dead
  // weight for an OpenAI-embedding install (the daemon's expander is Ollama-gated,
  // index.ts). "already" can also mean provider "openai", so gate on the provider
  // — not merely a coincidentally-running Ollama server.
  if (semantic === "already" && choice.provider === "ollama") {
    const probe = await probeOllama();
    if (probe.ok && !(await ollamaModelPresent(await resolveGenerationModel()))) {
      offerTextModel = true;
    }
  }
  if (offerTextModel) {
    const hw = detectHardware();
    const rec = recommendTextModel(hw.ramGB);
    if (rec.model) {
      const options: { value: string; label: string; hint?: string }[] = [
        { value: rec.model, label: `${rec.model} — recommended for ${hw.ramGB} GB`, hint: `~${rec.sizeGB} GB download` },
      ];
      if (rec.alt) {
        options.push({ value: rec.alt.model, label: `${rec.alt.model} — ${rec.alt.note}`, hint: `~${rec.alt.sizeGB} GB download` });
      }
      options.push({ value: "", label: "Skip — keyword + semantic recall only", hint: "add later: bastra models set <model>" });
      const ans = await p.select({
        message: "Text model for memory rewriting (doc2query + rerank)?",
        options,
        initialValue: rec.model,
      });
      if (bailed(ans)) { p.cancel(CANCEL_MSG); return 1; }
      textModel = (ans as string) || null;
    }
  }

  // ── 5. Bastra Commons — community recipe vault (read-only) ─────────────────
  // Folds a public, curated recipe repo into recall as a second read-only index.
  // Nothing of yours is shared: contributions go through PRs, never auto-egress.
  let commonsOn = false;
  {
    const ans = await p.select({
      message: "Bastra Commons? (community-curated engineering recipes, folded into recall read-only)",
      options: [
        { value: "off", label: "Not now", hint: "enable anytime: bastra commons enable" },
        { value: "on", label: "Enable", hint: "clones a public recipe repo (read-only); nothing of yours is shared" },
      ],
      initialValue: "off",
    });
    if (bailed(ans)) { p.cancel(CANCEL_MSG); return 1; }
    commonsOn = ans === "on";
  }

  // ── 6. shared learned-recall bridges (opt-in, contributes via PR) ──────────
  // Bridges live IN the Commons repo, so they only make sense once Commons is on.
  // Enabling loads the shared vocabulary-expansion pool; contributing your own
  // is a separate, explicit, PR-gated step — nothing auto-leaves the machine.
  let bridgesOn = false;
  if (commonsOn) {
    const ans = await p.select({
      message: "Shared learned-recall bridges? (widen recall with a community vocabulary pool from Commons)",
      options: [
        { value: "off", label: "Not now", hint: "enable anytime: bastra bridges enable" },
        { value: "on", label: "Enable", hint: "loads shared bridges read-only; sharing your own is separate & PR-gated" },
      ],
      initialValue: "off",
    });
    if (bailed(ans)) { p.cancel(CANCEL_MSG); return 1; }
    bridgesOn = ans === "on";
  }

  // ── 7. auto-update behavior ────────────────────────────────────────────────
  let updateMode: UpdateMode = DEFAULT_UPDATE_MODE;
  {
    const ans = await p.select({
      message: "Auto-update behavior?",
      options: [
        { value: "notify", label: "Notify me when an update is available", hint: "recommended" },
        { value: "auto", label: "Auto — install updates in the background" },
        { value: "off", label: "Off — never check" },
      ],
      initialValue: DEFAULT_UPDATE_MODE,
    });
    if (bailed(ans)) { p.cancel(CANCEL_MSG); return 1; }
    updateMode = ans as UpdateMode;
  }

  // ── 8. product-doc capture ─────────────────────────────────────────────────
  let docsMode: DocsMode = DEFAULT_DOCS_MODE;
  {
    const ans = await p.select({
      message: "Auto-capture product docs? (keep a user-facing doc current when a feature area is finished)",
      options: [
        { value: "off", label: "Off", hint: "recommended to start" },
        { value: "suggest", label: "Suggest — propose the doc, you confirm" },
        { value: "auto", label: "Auto — write docs without asking" },
      ],
      initialValue: DEFAULT_DOCS_MODE,
    });
    if (bailed(ans)) { p.cancel(CANCEL_MSG); return 1; }
    docsMode = ans as DocsMode;
  }

  // ── 9. vault map UI (#207) ─────────────────────────────────────────────────
  let uiOn = false;
  {
    const ans = await p.select({
      message: "Enable the vault map? (interactive graph of your memory at http://127.0.0.1:6723/ui — local only)",
      options: [
        { value: "on", label: "On — serve the map on /ui" },
        { value: "off", label: "Off", hint: "enable later: bastra config set ui.enabled true" },
      ],
      initialValue: "off",
    });
    if (bailed(ans)) { p.cancel(CANCEL_MSG); return 1; }
    uiOn = ans === "on";
  }

  // ── 10. the `bastra` command itself (#317) ─────────────────────────────────
  // Under npx there is no CLI on PATH when this finishes, and every next step
  // the docs name is a `bastra …` command. Asked here, executed at the very
  // end — and only on an explicit yes: installing globally without being told
  // to is not this installer's call. Same input as ensureStableForwarder, so
  // the two can never disagree about what an npx run is.
  const cliVerdict = decideCliOnPath({
    cliPath: FORWARDER_SCRIPT_PATH,
    resolvedBastra: findExecutable("bastra"),
  });
  let installCli = false;
  if (cliVerdict === "offer") {
    const ans = await p.select({
      message: "Install the 'bastra' command? (this run came from the npx cache — nothing is on your PATH yet)",
      options: [
        {
          value: "on",
          label: `Yes — npm install -g ${CLI_PACKAGE}@${VERSION}`,
          hint: "recommended: doctor, map, import and onboard are all 'bastra …' commands",
        },
        { value: "off", label: "No", hint: `run them with: npx ${CLI_PACKAGE} <command>` },
      ],
      initialValue: "on",
    });
    if (bailed(ans)) { p.cancel(CANCEL_MSG); return 1; }
    installCli = ans === "on";
  }

  // ── execute ───────────────────────────────────────────────────────────────
  if (vaultNeedsCreate) {
    const created = await createVaultAt(vaultPath!);
    if ("error" in created) {
      p.log.error(`Could not create ${vaultPath}: ${created.error}`);
      p.outro("Setup failed — nothing else was changed.");
      return 1;
    }
    // createVaultAt is idempotent, so this line also runs over a vault that was
    // already there — and "created" would then repeat the exact claim #318 is
    // about, one step later. Report what actually happened.
    p.log.success(
      vaultPresence.memoryCount > 0
        ? `Vault: ${created.path} (${memoryCountPhrase(vaultPresence.memoryCount)} already there — nothing overwritten)`
        : `Vault created: ${created.path}`,
    );
  }

  const surfaces = chosen as string[];

  // #350: the compiled hook client — asked here, before the spinner, because
  // registration prefers the stub only when the binary is already on disk.
  // A cancel at this question cancels the wizard like at every other one.
  if (surfaces.includes("claude-code") || surfaces.includes("codex")) {
    const CANCELLED = Symbol("cancelled");
    try {
      const stub = await ensureHookStub(
        { dryRun: false, mode: "ask", interactive: true },
        {
          ask: async (question, o) => {
            const a = await p.confirm({ message: question, initialValue: o.defaultYes ?? false });
            if (bailed(a)) throw CANCELLED;
            return a === true;
          },
          log: (line) => p.log.info(line.trim()),
        },
      );
      if (stub.status === "failed") p.log.warn(`hook client: ${stub.detail}`);
      else p.log.info(`hook client: ${stub.detail}`);
    } catch (err) {
      if (err !== CANCELLED) throw err;
      p.cancel(CANCEL_MSG);
      return 1;
    }
  }

  const results: { surface: string; r: InstallResult }[] = [];
  const s = p.spinner();
  s.start("Registering the memory tool…");
  let hadError = false;
  for (const surface of surfaces) {
    const adapter = ADAPTERS[surface];
    s.message(`Registering ${adapter.description}…`);
    try {
      const r = await adapter.install({
        dryRun: false,
        vaultPath,
        force: false,
        withStopHook: stopHook,
      });
      results.push({ surface, r });
      if (r.status === "error") hadError = true;
    } catch (err) {
      results.push({ surface, r: { status: "error", message: (err as Error).message } });
      hadError = true;
    }
  }
  s.stop(hadError ? "Registration finished with errors" : "Clients registered");
  for (const { surface, r } of results) {
    const line = `${surface}: ${r.message}${r.backupPath ? ` (backup: ${r.backupPath})` : ""}`;
    if (r.status === "error") p.log.error(line);
    else p.log.success(line);
  }

  const restart = surfaces.map((sf) => ADAPTERS[sf].description.replace(/\s*\(.*\)$/, "")).join(", ");
  if (hadError) {
    // Same contract as the classic path: semantic recall runs only at the end
    // of a SUCCESSFUL install — never bolt a ~620 MB download onto a failure.
    if (semantic === "on") {
      p.log.warn("Skipping semantic recall setup (registration failed) — after fixing, run: bastra embeddings on");
    }
    p.outro(`Finished with errors — fix the issue, then re-run: bastra install (log lines above)`);
    return 1;
  }

  // Tracks whether recall is actually usable before we bolt a text-model download
  // on top. Only the fresh-enable path can fail here; "already"/"later" start true.
  let semanticOk = semantic !== "on";
  if (semantic === "on") {
    // No spinner here on purpose: brew/ollama stream their own progress to
    // stdout (a ~620 MB download deserves a real progress bar, not a spinner).
    p.log.step("Setting up semantic recall — Ollama + embeddinggemma model (~620 MB)…");
    const r = await enableSemanticRecall({ dryRun: false });
    if (r.status === "error" || r.status === "unsupported") {
      p.log.warn(`${r.message}\nSetting saved — finish setup, then re-run: bastra embeddings on`);
    } else if (r.activated) {
      semanticOk = true;
      p.log.success(`Semantic recall: ${r.message}`);
    } else {
      // e.g. "env-override": nothing was provisioned — a green success here
      // would misreport a state where recall stays keyword-only.
      p.log.warn(`Semantic recall: ${r.message}`);
    }
  } else if (semantic === "later") {
    p.log.info(RECALL_OFF_NOTE);
  }

  // Text model rides on the Ollama server semantic recall uses. Skip it on the
  // fresh-enable path when that setup failed: the server can be up while the
  // embedding-model pull failed — recall is then broken, so a multi-GB text-model
  // download would be dead weight. The "already" path was gated up front.
  if (textModel && semanticOk) {
    p.log.step(`Pulling the text model ${textModel}…`);
    const gr = await enableGenerationModel(textModel, { dryRun: false });
    if (gr.activated) p.log.success(`Text model: ${gr.message}`);
    else p.log.warn(`Text model: ${gr.message}\nAdd it later: bastra models set ${textModel}`);
  }

  // Bastra Commons — clone + enable (read-only recall enrichment). cmdCommons
  // streams git progress to stdout (like the ollama pull above), so no spinner.
  let commonsOk = false;
  if (commonsOn) {
    p.log.step("Enabling Bastra Commons — cloning the community recipe repo…");
    const rc = await cmdCommons({ sub: "enable" });
    commonsOk = rc === 0;
    if (commonsOk) p.log.success("Bastra Commons: enabled (restart the daemon to load it)");
    else p.log.warn("Bastra Commons: could not enable — try later: bastra commons enable");
  }

  // Shared learned-recall bridges — a settings toggle only (the pool lives IN the
  // Commons clone). Enable only when that clone succeeded, else the daemon would
  // report shared-recall ON with an empty pool and the state would misrepresent disk.
  if (bridgesOn && commonsOk) {
    await setSharedRecallEnabled(true);
    p.log.success("Shared learned-recall: enabled (restart the daemon to load the bridge pool)");
  } else if (bridgesOn) {
    p.log.warn("Shared learned-recall: skipped (Commons couldn't be enabled) — after fixing: bastra commons enable && bastra bridges enable");
  }

  // Auto-update + product-doc capture: plain settings writes, applied on next boot.
  // Only persist a non-default choice (a default pick needs no file change).
  if (updateMode !== DEFAULT_UPDATE_MODE) {
    await setUpdateMode(updateMode);
    p.log.success(`Auto-update: ${updateMode}`);
  }
  if (docsMode !== DEFAULT_DOCS_MODE) {
    await setDocsMode(docsMode);
    p.log.success(`Product-doc capture: ${docsMode}`);
  }
  if (uiOn) {
    const line = await vaultMapSetupStep({
      vaultPath: vaultPath ?? undefined,
      onStarting: () => p.log.step("Starting the daemon so the vault map is reachable…"),
    });
    if (line.level === "success") p.log.success(line.text);
    else p.log.warn(line.text);
  }

  // The CLI itself (#317) — last, because its absence is the one thing the user
  // would otherwise discover only after the setup declared success. Runs solely
  // on the explicit yes above; declining still ends with a usable invocation,
  // and so does a failed npm install.
  if (cliVerdict === "offer") {
    if (installCli) {
      p.log.step(`Installing the 'bastra' command — npm install -g ${CLI_PACKAGE}@${VERSION}…`);
      const line = formatGlobalInstallOutcome(installCliGlobally());
      if (line.level === "success") p.log.success(line.text);
      else p.log.warn(line.text);
    } else {
      p.log.info(CLI_DECLINED_NOTE);
    }
  }

  p.outro(`Done. Restart ${restart} to pick up the memory tool.`);
  return 0;
}
