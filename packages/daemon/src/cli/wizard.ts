import { hostPaths, type HostPathOptions } from "../platform-paths.js";
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
import { posix, win32 } from "node:path";
import { ADAPTERS, adapterDescription } from "./registry.js";
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
import { CLI_PACKAGE, decideCliOnPath, formatGlobalInstallOutcome, installCliGlobally } from "./cli-on-path.js";
import { embeddingsWordsIn } from "./embeddings-words.js";
import { installWordsIn } from "./install-words.js";
import { enableSemanticRecall, enableGenerationModel, probeOllama, ollamaModelPresent } from "./ollama.js";
import { detectHardware, recommendTextModel } from "./hardware.js";
import { cmdCommons } from "./commons.js";
import {
  resolveEmbeddingChoice,
  resolveGenerationModel,
  setSharedRecallEnabled,
  setUpdateMode,
  setDocsMode,
  getUiEnabled,
  setUiEnabled,
  DEFAULT_UPDATE_MODE,
  DEFAULT_DOCS_MODE,
  type UpdateMode,
  type DocsMode,
} from "../settings.js";
import type { InstallResult, ParsedArgs } from "./types.js";
import { askTaskChatConsent, finishTaskChatConsent } from "./task-chat-setup.js";
import { webUiOnByDefault } from "../local-account-access.js";
import { askSetupLanguage, saveSetupLanguage } from "./wizard-language.js";
import { wizardWords, type WizardWords } from "./wizard-words.js";

const EN = wizardWords("en");

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

/** Only registered adapters are selectable. ChatGPT shares the Codex adapter;
 * Zed has no installer adapter yet and must not be offered as a working target. */
export function surfaceTraces(opts: HostPathOptions = {}): Record<string, string[]> {
  const clients = hostPaths(opts);
  const platform = opts.platform ?? process.platform;
  return {
    "claude-code": [clients.claudeCodeConfig, clients.claudeCodeSettings.replace(/[\\/]settings\.json$/, "")],
    codex: [clients.codexDir, ...(platform === "darwin" ? ["/Applications/ChatGPT.app"] : [])],
    "claude-desktop": [clients.claudeDesktopDir, ...(platform === "darwin" ? ["/Applications/Claude.app"] : [])],
    cursor: [clients.cursorDir, ...(platform === "darwin" ? ["/Applications/Cursor.app"] : [])],
  };
}

export function detectSurfaces(
  home: string = homedir(),
  opts: Omit<HostPathOptions, "home"> & { exists?: (path: string) => boolean } = {}
): Record<string, boolean> {
  const exists = opts.exists ?? existsSync;
  return Object.fromEntries(
    Object.entries(surfaceTraces({ ...opts, home })).map(([surface, traces]) => [surface, traces.some(exists)])
  );
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
export function buildSurfaceChoices(
  present: Record<string, boolean>,
  w: WizardWords = EN
): {
  options: SurfaceChoice[];
  initialValues: string[];
} {
  const options = Object.entries(ADAPTERS).map(([surface, adapter]) => ({
    value: surface,
    label: adapter.description.replace(/\s*\(.*\)$/, ""),
    hint: present[surface] ? w.detected : w.notDetected,
  }));
  const detected = options.filter((o) => present[o.value]).map((o) => o.value);
  return { options, initialValues: detected.length > 0 ? detected : options.map((o) => o.value) };
}

/** "74 memories" / "1 memory" — used by the prompt and the log line. */
/**
 * The text-model step's choices for a machine with `ramGB`: the tier's
 * suggestion first and preselected, the heavier alternative where the tier has
 * one, and Skip. Null below the 16 GB tier — the step is not shown there.
 */
export function buildTextModelChoices(
  ramGB: number,
  w: WizardWords = EN,
  screenLanguage?: string
): {
  options: { value: string; label: string; hint?: string }[];
  initialValue: string;
} | null {
  const rec = recommendTextModel(ramGB, undefined, screenLanguage);
  if (!rec.model) return null;
  const options: { value: string; label: string; hint?: string }[] = [
    { value: rec.model, label: w.textModelRecommended(rec.model, ramGB), hint: w.download(rec.sizeGB) },
  ];
  if (rec.alt) {
    options.push({
      value: rec.alt.model,
      label: `${rec.alt.model} — ${rec.alt.note}`,
      hint: w.download(rec.alt.sizeGB),
    });
  }
  options.push({
    value: "",
    label: w.textModelSkip,
    hint: w.textModelSkipHint,
  });
  return { options, initialValue: rec.model };
}

export function memoryCountPhrase(n: number, w: WizardWords = EN): string {
  return w.memories(n);
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
  w: WizardWords = EN
): VaultOption {
  if (!presence.exists || presence.memoryCount === 0) {
    return { label: w.createVault(display), hint: w.recommended };
  }
  return { label: w.useVault(display), hint: w.alreadyThere(memoryCountPhrase(presence.memoryCount, w)) };
}

/** `~`/relative → absolute, for the custom-vault text input. Exported for tests. */
export function expandUserPath(
  input: string,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): string {
  const { resolve } = platform === "win32" ? win32 : posix;
  const trimmed = input.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || (platform === "win32" && trimmed.startsWith("~\\")))
    return resolve(home, trimmed.slice(2));
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

/**
 * The vault-map question — pure, exported for tests. The preselection is the
 * map's current state: a fresh macOS install starts on (the web UI is bound to
 * the vault owner's account there), elsewhere off, and a stored choice is kept
 * when the user just presses Enter.
 */
export function vaultMapQuestion(url: string, currentlyOn: boolean, accountBound: boolean, w: WizardWords = EN) {
  const enableLater = w.mapEnableLater;
  return {
    message: w.map(url),
    options: [
      {
        value: "on",
        label: w.mapOn,
        ...(accountBound ? { hint: w.mapOnHint } : {}),
      },
      {
        value: "off",
        label: w.off,
        hint: accountBound ? enableLater : w.mapNotBound(enableLater),
      },
    ],
    initialValue: currentlyOn ? "on" : "off",
  };
}

/**
 * The closing vault-map line — pure, exported for tests (the wizard itself is
 * the @clack shell around it). A map whose daemon never came up must not be
 * handed over as a link: that URL was the one the #322 reporter clicked.
 */
export function vaultMapOutcomeLine(
  daemon: DaemonStartOutcome,
  url: string,
  w: WizardWords = EN
): { level: "success" | "warn"; text: string } {
  if (daemon.ok) {
    return { level: "success", text: w.mapReady(url) };
  }
  return { level: "warn", text: w.mapNoDaemon(daemon.detail) };
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
  w: WizardWords = EN
): Promise<{ level: "success" | "warn"; text: string }> {
  // Only an off map is switched on: a map that is on by default stays a default.
  const enableMap =
    io.enableMap ??
    (async () => {
      if (!(await getUiEnabled())) await setUiEnabled(true);
    });
  const ensureDaemon = io.ensureDaemon ?? ensureDaemonRunning;
  const url = io.url ?? mapUrl;

  await enableMap();
  const daemon = await ensureDaemon({ vaultPath: opts.vaultPath, onStarting: opts.onStarting });
  return vaultMapOutcomeLine(daemon, url(), w);
}

/** Applies the vault-map answer. Off is stored only where the map is on (by
 *  default or by an earlier choice); On goes through the setup step. */
async function applyVaultMapChoice(
  on: boolean,
  wasOn: boolean,
  vaultPath: string | undefined,
  w: WizardWords
): Promise<void> {
  if (!on) {
    if (!wasOn) return;
    await setUiEnabled(false);
    p.log.info(w.mapOff);
    return;
  }
  const line = await vaultMapSetupStep({ vaultPath, onStarting: () => p.log.step(w.mapStarting) }, {}, w);
  if (line.level === "success") p.log.success(line.text);
  else p.log.warn(line.text);
}

export async function runInstallWizard(args: ParsedArgs): Promise<number> {
  p.intro(`bastra-recall ${VERSION} — guided setup`);

  // ── 0. language (#1602) — asked only while none is stored ─────────────────
  const language = await askSetupLanguage();
  if (bailed(language)) {
    p.cancel(EN.cancel);
    return 1;
  }
  const w = wizardWords(language.language);

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
    p.log.info(w.vaultConfigured(vaultPath));
  } else {
    // Look before offering to create it (#318): an existing vault gets named,
    // never re-offered as a fresh folder.
    vaultPresence = await probeVaultPresence(defaultVaultPath());
    const where = await p.select({
      message: w.vaultWhere,
      options: [
        { value: "default", ...defaultVaultOption(vaultPresence, DEFAULT_VAULT_DISPLAY, w) },
        { value: "custom", label: w.vaultCustom },
      ],
      initialValue: "default",
    });
    if (bailed(where)) {
      p.cancel(w.cancel);
      return 1;
    }
    if (where === "default") {
      vaultPath = defaultVaultPath();
    } else {
      const custom = await p.text({
        message: w.vaultFolder,
        placeholder: DEFAULT_VAULT_DISPLAY,
        validate: (v) => (v && v.trim().length > 0 ? undefined : w.vaultFolderNeeded),
      });
      if (bailed(custom)) {
        p.cancel(w.cancel);
        return 1;
      }
      vaultPath = expandUserPath(custom);
      // Echo the expanded absolute path NOW — a typo ('~/Documets/…') or a
      // CWD-relative surprise must be visible before anything acts on it
      // (Ctrl-C on the next question still aborts with nothing written).
      p.log.info(w.vaultFolderIs(vaultPath));
      // A typed path deserves the same honesty as the default one (#318).
      vaultPresence = await probeVaultPresence(vaultPath);
      if (vaultPresence.memoryCount > 0) {
        p.log.info(w.vaultKept(memoryCountPhrase(vaultPresence.memoryCount, w)));
      }
    }
    vaultNeedsCreate = true;
  }

  // ── 2. clients ────────────────────────────────────────────────────────────
  const { options, initialValues } = buildSurfaceChoices(detectSurfaces(), w);
  const chosen = await p.multiselect({
    message: w.clients,
    options,
    initialValues,
    required: true,
  });
  if (bailed(chosen)) {
    p.cancel(w.cancel);
    return 1;
  }

  // Independent, explicit account-wide messaging consent; all writes wait until execute.
  const chatConsent = await askTaskChatConsent({}, language.language, (chosen as string[]).includes("claude-code"));
  if (typeof chatConsent === "symbol") {
    p.cancel(w.cancel);
    return 1;
  }

  // ── 2b. stop hook (Claude Code and Codex) ──────────────────────────────────
  // Live-validated (#48), so it now defaults ON, but stays a visible toggle: if
  // it ever gets noisy the user can turn it off here (or re-run
  // `bastra install claude-code --no-stop-hook`).
  let stopHook = args.withStopHook;
  const hookSurfaces = (chosen as string[]).filter((surface) => surface === "claude-code" || surface === "codex");
  if (hookSurfaces.length > 0) {
    const hookAns = await p.select({
      message: w.stopHook(
        hookSurfaces.map((surface) => (surface === "codex" ? "Codex/ChatGPT" : "Claude Code")).join(" + ")
      ),
      options: [
        {
          value: "on",
          label: w.stopHookOn,
          hint: w.stopHookOnHint,
        },
        { value: "off", label: w.off, hint: w.stopHookOffHint(hookSurfaces[0]) },
      ],
      initialValue: "on",
    });
    if (bailed(hookAns)) {
      p.cancel(w.cancel);
      return 1;
    }
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
    } catch {
      /* unreachable daemon = no signal */
    }
  }
  let semantic = decideWizardSemantic({
    ollamaFlag: args.ollama,
    effectiveProvider: choice.provider,
    daemonSemanticOn: daemonOn,
  });
  if (semantic === "already") {
    p.log.info(choice.provider !== "none" ? w.semanticConfigured(choice.provider, choice.source) : w.semanticDaemon);
  } else if (semantic === "ask") {
    const answer = await p.select({
      message: w.semantic,
      options: [
        {
          value: "on",
          label: w.semanticOn,
          hint: w.semanticOnHint,
        },
        {
          value: "later",
          label: w.semanticLater,
          hint: w.semanticLaterHint,
        },
      ],
      initialValue: "on",
    });
    if (bailed(answer)) {
      p.cancel(w.cancel);
      return 1;
    }
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
    const choices = buildTextModelChoices(detectHardware().ramGB, w, language.language);
    if (choices) {
      const ans = await p.select({
        message: w.textModel,
        ...choices,
      });
      if (bailed(ans)) {
        p.cancel(w.cancel);
        return 1;
      }
      textModel = (ans as string) || null;
    }
  }

  // ── 5. Bastra Commons — community recipe vault (read-only) ─────────────────
  // Folds a public, curated recipe repo into recall as a second read-only index.
  // Nothing of yours is shared: contributions go through PRs, never auto-egress.
  let commonsOn = false;
  {
    const ans = await p.select({
      message: w.commons,
      options: [
        { value: "off", label: w.notNow, hint: w.commonsLaterHint },
        { value: "on", label: w.enable, hint: w.commonsOnHint },
      ],
      initialValue: "off",
    });
    if (bailed(ans)) {
      p.cancel(w.cancel);
      return 1;
    }
    commonsOn = ans === "on";
  }

  // ── 6. shared learned-recall bridges (opt-in, contributes via PR) ──────────
  // Bridges live IN the Commons repo, so they only make sense once Commons is on.
  // Enabling loads the shared vocabulary-expansion pool; contributing your own
  // is a separate, explicit, PR-gated step — nothing auto-leaves the machine.
  let bridgesOn = false;
  if (commonsOn) {
    const ans = await p.select({
      message: w.bridges,
      options: [
        { value: "off", label: w.notNow, hint: w.bridgesLaterHint },
        { value: "on", label: w.enable, hint: w.bridgesOnHint },
      ],
      initialValue: "off",
    });
    if (bailed(ans)) {
      p.cancel(w.cancel);
      return 1;
    }
    bridgesOn = ans === "on";
  }

  // ── 7. auto-update behavior ────────────────────────────────────────────────
  let updateMode: UpdateMode = DEFAULT_UPDATE_MODE;
  {
    const ans = await p.select({
      message: w.update,
      options: [
        { value: "notify", label: w.updateNotify, hint: w.recommended },
        { value: "auto", label: w.updateAuto },
        { value: "off", label: w.updateOff },
      ],
      initialValue: DEFAULT_UPDATE_MODE,
    });
    if (bailed(ans)) {
      p.cancel(w.cancel);
      return 1;
    }
    updateMode = ans as UpdateMode;
  }

  // ── 8. product-doc capture ─────────────────────────────────────────────────
  let docsMode: DocsMode = DEFAULT_DOCS_MODE;
  {
    const ans = await p.select({
      message: w.docs,
      options: [
        { value: "off", label: w.off, hint: w.docsOffHint },
        { value: "suggest", label: w.docsSuggest },
        { value: "auto", label: w.docsAuto },
      ],
      initialValue: DEFAULT_DOCS_MODE,
    });
    if (bailed(ans)) {
      p.cancel(w.cancel);
      return 1;
    }
    docsMode = ans as DocsMode;
  }

  // ── 9. vault map UI (#207) ─────────────────────────────────────────────────
  const uiBefore = await getUiEnabled();
  let uiOn = uiBefore;
  {
    const ans = await p.select(vaultMapQuestion(mapUrl(), uiBefore, webUiOnByDefault(), w));
    if (bailed(ans)) {
      p.cancel(w.cancel);
      return 1;
    }
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
      message: w.cli,
      options: [
        {
          value: "on",
          label: w.cliYes(`${CLI_PACKAGE}@${VERSION}`),
          hint: w.cliYesHint,
        },
        { value: "off", label: w.no, hint: w.cliNoHint(CLI_PACKAGE) },
      ],
      initialValue: "on",
    });
    if (bailed(ans)) {
      p.cancel(w.cancel);
      return 1;
    }
    installCli = ans === "on";
  }

  // ── execute ───────────────────────────────────────────────────────────────
  await saveSetupLanguage(language);
  if (vaultNeedsCreate) {
    const created = await createVaultAt(vaultPath!);
    if ("error" in created) {
      p.log.error(w.vaultFailed(vaultPath!, created.error));
      p.outro(w.setupFailed);
      return 1;
    }
    // createVaultAt is idempotent, so this line also runs over a vault that was
    // already there — and "created" would then repeat the exact claim #318 is
    // about, one step later. Report what actually happened.
    p.log.success(
      vaultPresence.memoryCount > 0
        ? w.vaultUsed(created.path, memoryCountPhrase(vaultPresence.memoryCount, w))
        : w.vaultCreated(created.path)
    );
  }

  const surfaces = chosen as string[];

  // #350: the compiled hook client — asked here, before the spinner, because
  // registration prefers the stub only when the binary is already on disk.
  // A cancel at this question cancels the wizard like at every other one.
  // #537 — the selection the stub step made, handed to every adapter instead of
  // each one probing the disk. Undefined when no hook surface was chosen.
  let useStub: boolean | undefined;
  if (surfaces.includes("claude-code") || surfaces.includes("codex")) {
    const CANCELLED = Symbol("cancelled");
    try {
      const stub = await ensureHookStub(
        { dryRun: false, mode: "ask", interactive: true, language: language.language },
        {
          ask: async (question, o) => {
            const a = await p.confirm({ message: question, initialValue: o.defaultYes ?? false });
            if (bailed(a)) throw CANCELLED;
            return a === true;
          },
          log: (line) => p.log.info(line.trim()),
        }
      );
      useStub = stub.useStub;
      if (stub.status === "failed") p.log.warn(w.hookClient(stub.detail));
      else p.log.info(w.hookClient(stub.detail));
    } catch (err) {
      if (err !== CANCELLED) throw err;
      p.cancel(w.cancel);
      return 1;
    }
  }

  const results: { surface: string; r: InstallResult }[] = [];
  const s = p.spinner();
  s.start(w.registering);
  let hadError = false;
  for (const surface of surfaces) {
    const adapter = ADAPTERS[surface];
    s.message(w.registeringOne(adapterDescription(adapter, language.language)));
    try {
      const r = await adapter.install(
        {
          dryRun: false,
          vaultPath,
          force: false,
          withStopHook: stopHook,
          withBootstrap: args.withBootstrap,
          useStub,
        },
        language.language
      );
      results.push({ surface, r });
      if (r.status === "error") hadError = true;
    } catch (err) {
      results.push({ surface, r: { status: "error", message: (err as Error).message } });
      hadError = true;
    }
  }
  s.stop(hadError ? w.registeredWithErrors : w.registered);
  for (const { surface, r } of results) {
    const line = `${surface}: ${r.message}${r.backupPath ? w.backup(r.backupPath) : ""}`;
    if (r.status === "error") p.log.error(line);
    else p.log.success(line);
  }

  const restart = surfaces.map((sf) => ADAPTERS[sf].description.replace(/\s*\(.*\)$/, "")).join(", ");
  if (hadError) {
    // Same contract as the classic path: semantic recall runs only at the end
    // of a SUCCESSFUL install — never bolt a ~620 MB download onto a failure.
    if (semantic === "on") {
      p.log.warn(w.semanticSkipped);
    }
    p.outro(w.finishedWithErrors);
    return 1;
  }

  if (typeof chatConsent === "boolean") p.log.info(await finishTaskChatConsent(chatConsent, {}, language.language));

  // Tracks whether recall is actually usable before we bolt a text-model download
  // on top. Only the fresh-enable path can fail here; "already"/"later" start true.
  let semanticOk = semantic !== "on";
  if (semantic === "on") {
    // No spinner here on purpose: brew/ollama stream their own progress to
    // stdout (a ~620 MB download deserves a real progress bar, not a spinner).
    p.log.step(w.semanticSetup);
    const r = await enableSemanticRecall({ dryRun: false, language: language.language });
    if (r.status === "error" || r.status === "unsupported") {
      p.log.warn(w.semanticSaved(r.message));
    } else if (r.activated) {
      semanticOk = true;
      p.log.success(w.semanticResult(r.message));
    } else {
      // e.g. "env-override": nothing was provisioned — a green success here
      // would misreport a state where recall stays keyword-only.
      p.log.warn(w.semanticResult(r.message));
    }
  } else if (semantic === "later") {
    p.log.info(embeddingsWordsIn(language.language).recallOff);
  }

  // Text model rides on the Ollama server semantic recall uses. Skip it on the
  // fresh-enable path when that setup failed: the server can be up while the
  // embedding-model pull failed — recall is then broken, so a multi-GB text-model
  // download would be dead weight. The "already" path was gated up front.
  if (textModel && semanticOk) {
    p.log.step(w.pulling(textModel));
    const gr = await enableGenerationModel(textModel, { dryRun: false, language: language.language });
    if (gr.activated) p.log.success(w.textModelResult(gr.message));
    else p.log.warn(w.textModelLater(gr.message, textModel));
  }

  // Bastra Commons — clone + enable (read-only recall enrichment). cmdCommons
  // streams git progress to stdout (like the ollama pull above), so no spinner.
  let commonsOk = false;
  if (commonsOn) {
    p.log.step(w.commonsCloning);
    const rc = await cmdCommons({ sub: "enable" });
    commonsOk = rc === 0;
    if (commonsOk) p.log.success(w.commonsOn);
    else p.log.warn(w.commonsFailed);
  }

  // Shared learned-recall bridges — a settings toggle only (the pool lives IN the
  // Commons clone). Enable only when that clone succeeded, else the daemon would
  // report shared-recall ON with an empty pool and the state would misrepresent disk.
  if (bridgesOn && commonsOk) {
    await setSharedRecallEnabled(true);
    p.log.success(w.bridgesOn);
  } else if (bridgesOn) {
    p.log.warn(w.bridgesSkipped);
  }

  // Auto-update + product-doc capture: plain settings writes, applied on next boot.
  // Only persist a non-default choice (a default pick needs no file change).
  if (updateMode !== DEFAULT_UPDATE_MODE) {
    await setUpdateMode(updateMode);
    p.log.success(w.updateSaved(updateMode));
  }
  if (docsMode !== DEFAULT_DOCS_MODE) {
    await setDocsMode(docsMode);
    p.log.success(w.docsSaved(docsMode));
  }
  await applyVaultMapChoice(uiOn, uiBefore, vaultPath ?? undefined, w);

  // The CLI itself (#317) — last, because its absence is the one thing the user
  // would otherwise discover only after the setup declared success. Runs solely
  // on the explicit yes above; declining still ends with a usable invocation,
  // and so does a failed npm install.
  if (cliVerdict === "offer") {
    if (installCli) {
      p.log.step(w.cliInstalling(`${CLI_PACKAGE}@${VERSION}`));
      const line = formatGlobalInstallOutcome(installCliGlobally());
      if (line.level === "success") p.log.success(line.text);
      else p.log.warn(line.text);
    } else {
      p.log.info(installWordsIn(language.language).cliDeclined);
    }
  }

  p.outro(w.done(restart));
  return 0;
}
