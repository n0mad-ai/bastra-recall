import { printRulebookDoctorNote } from "./rulebook-note.js";
import { printConflictCopiesNote } from "./conflict-copies-note.js";
import { printAssistantAddressNote } from "./doctor-address-note.js";
import {
  hasManagedAssistantAddress,
  addressRemovalNeedsConsent,
  removeAssistantAddress,
  notifyAssistantAddressDaemon,
  type AssistantAddressOptions,
} from "../assistant-address.js";
/** CLI command orchestration, including Codex/ChatGPT installation (#15). */
import { missingVaultReason } from "../vault-presence.js";
import { adapterDescription, resolveTargets } from "./registry.js";
import {
  VERSION,
  probeDaemon,
  resolveVault,
  decideFirstRunVaultAction,
  defaultVaultPath,
  createVaultAt,
} from "./helpers.js";
import { installSemanticRecallStep, printEmbeddingDoctorNote } from "./embeddings-cmd.js";
import { sweepSharedSkill } from "./skill.js";
import { removeRuntimeBase } from "./stable-runtime.js";
import { decideCliOnPath } from "./cli-on-path.js";
import { FORWARDER_SCRIPT_PATH } from "./paths.js";
import { findExecutable } from "./exec.js";
import { runInstallWizard, shouldRunWizard } from "./wizard.js";
import { cmdInstallExtension } from "./extension-install.js";
import { ensureHookStub } from "./stub-install.js";
import { confirm, isInteractive } from "./prompt.js";
import { getEmbeddingProvider, getSharedRecallEnabled, getSharedRecallLive, readSettings } from "../settings.js";
import { addressWords } from "../assistant-address-words.js";
import { installWords, installWordsIn, type InstallWords } from "./install-words.js";
import { doctorWordsIn, type DoctorWords } from "./doctor-words.js";
import { taskCliLanguage } from "./task-cli-words.js";
import { adapterDetailLabel, adapterDisplayLanguage } from "./adapter-words.js";
import { autostartWordsIn } from "./autostart-words.js";
import { canAutoSpawnAt } from "../forwarder-daemon-client.js";
import { bridgeLearningLines, readMintRuns } from "./bridges-note.js";
import { bridgesPath } from "../learned-recall/pool-path.js";
import { readLastMint } from "../learned-recall/mint-job.js";
import { defaultLogDir } from "../learned-recall/harvest.js";
import { showHelp } from "./help-text.js";
import { validateArgs } from "./flag-spec.js";
import { describeStale } from "../code-staleness.js";
import { autostartWarning, autostartService } from "./autostart.js";
import { stubFreshness, stubFreshnessLines } from "./stub-freshness.js";
import { affectsFilesLines, defaultAffectsFilesIo } from "./affects-files-note.js";
import { defaultDerivedClaimsIo, derivedClaimsLines } from "./derived-claims-note.js";
import { clientMemoryLines, findClientMemoryDirs } from "./client-memory.js";
import { printFeaturesNote, type FeatureState } from "./features-note.js";
import { fetchToolsFromDaemon, printDeliveryNote } from "./doctor-delivery.js";
import { printSessionStartNote } from "./doctor-session-probe.js";
import { cmdDoctorReplay } from "./doctor-replay.js";
import { configuredState, daemonOriginLines } from "./daemon-origin-note.js";
import { installCodeAwarenessStep } from "./code-cmd.js";
import { enabledRepos } from "../code-graph/enabled-repos.js";
import { GRAPHIFY_PIN, probeTool } from "../code-graph/graphify-tool.js";
import { graphDirOf, loadGraph } from "../code-graph/reader.js";
import { externalRefLines } from "../code-graph/external-refs.js";
import { isStale, readManifest } from "../code-graph/manifest.js";
import { coverageMapStatus } from "../code-graph/coverage-map.js";
import { scanFileState } from "../code-graph/build.js";
import { refreshStatusLines } from "../code-graph/refresh-status.js";
import { fetchRefreshStatus } from "./code-refresh-client.js";
import type { InstallOpts, ParsedArgs } from "./types.js";

export function showVersion(): void {
  process.stdout.write(`${VERSION}\n`);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: null,
    surface: null,
    dryRun: false,
    vaultPath: null,
    showHelp: false,
    showVersion: false,
    json: false,
    quiet: false,
    yes: false,
    fix: false,
    // Stop save-eval hook is registered by default since #48 (live-validated,
    // silent file-relay — no chat noise). Opt out with --no-stop-hook.
    withStopHook: true,
    staged: false,
    force: false,
    ollama: null,
    origin: null,
    answers: null,
    extension: false,
    stub: null,
    exclude: [],
    follow: false,
    since: null,
    source: null,
    lines: null,
    stats: false,
    conventions: false,
    includeEval: false,
    replay: false,
    days: null,
    compare: null,
    positional: [],
    errors: [],
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") result.showHelp = true;
    else if (a === "--version" || a === "-v") result.showVersion = true;
    else if (a === "--dry-run") result.dryRun = true;
    else if (a === "--json") result.json = true;
    else if (a === "-q" || a === "--quiet") result.quiet = true;
    else if (a === "--yes" || a === "-y") result.yes = true;
    else if (a === "--fix") result.fix = true;
    else if (a === "--with-stop-hook")
      result.withStopHook = true; // kept for compat — now the default
    else if (a === "--no-stop-hook") result.withStopHook = false;
    else if (a === "--with-bootstrap") result.withBootstrap = true;
    else if (a === "--no-bootstrap") result.withBootstrap = false;
    else if (a === "--staged") result.staged = true;
    else if (a === "--force") result.force = true;
    else if (a === "--exclude") {
      const v = argv[++i];
      if (v) result.exclude.push(v);
    } else if (a.startsWith("--exclude=")) {
      const v = a.slice("--exclude=".length);
      if (v) result.exclude.push(v);
    } else if (a === "--follow" || a === "-f") result.follow = true;
    else if (a === "--stats") result.stats = true;
    else if (a === "--conventions") result.conventions = true;
    else if (a === "--include-eval") result.includeEval = true;
    else if (a === "--replay") result.replay = true;
    else if (a === "--days") {
      result.days = argv[++i] ?? null;
    } else if (a.startsWith("--days=")) {
      result.days = a.slice("--days=".length);
    } else if (a === "--compare") {
      result.compare = argv[++i] ?? null;
    } else if (a.startsWith("--compare=")) {
      result.compare = a.slice("--compare=".length);
    } else if (a === "--since") {
      result.since = argv[++i] ?? null;
    } else if (a.startsWith("--since=")) {
      result.since = a.slice("--since=".length);
    } else if (a === "--source") {
      result.source = argv[++i] ?? null;
    } else if (a.startsWith("--source=")) {
      result.source = a.slice("--source=".length);
    } else if (a === "--lines") {
      result.lines = argv[++i] ?? null;
    } else if (a.startsWith("--lines=")) {
      result.lines = a.slice("--lines=".length);
    } else if (a === "--extension") result.extension = true;
    else if (a === "--stub") result.stub = "yes";
    else if (a === "--no-stub") result.stub = "skip";
    else if (a === "--ollama") result.ollama = "auto";
    else if (a === "--no-ollama") result.ollama = "skip";
    else if (a === "--vault") {
      result.vaultPath = argv[++i] ?? null;
    } else if (a.startsWith("--vault=")) {
      result.vaultPath = a.slice("--vault=".length);
    } else if (a === "--origin") {
      result.origin = argv[++i] ?? null;
    } else if (a.startsWith("--origin=")) {
      result.origin = a.slice("--origin=".length);
    } else if (a === "--answers") {
      result.answers = argv[++i] ?? null;
    } else if (a.startsWith("--answers=")) {
      result.answers = a.slice("--answers=".length);
    } else if (a.startsWith("--")) {
      // Not a warning anymore — validateArgs below turns it into a usage error
      // that never reaches dispatch (#536).
    } else {
      positional.push(a);
    }
  }

  result.command = positional[0] ?? null;
  result.surface = positional[1] ?? null;
  result.positional = positional;
  result.errors = validateArgs(argv);
  return result;
}

function resolveVaultPath(cliVault: string | null): string | null {
  return cliVault ?? process.env.BASTRA_VAULT_PATH ?? null;
}

export const FIRST_RUN_VAULT_QUESTION = installWordsIn("en").firstRunQuestion;

/**
 * First-run vault step (#178): on a fresh machine there is nothing to
 * auto-detect, so without this the headline onboarding command errors once
 * per surface. Runs ONCE before the per-surface loop. Returns the created
 * vault path (the caller feeds it through opts.vaultPath — the same route a
 * --vault value takes), or an exit code when install must stop (refusal or
 * failed creation → the unchanged non-zero error semantics). `io` is
 * injectable for tests only (there is no TTY on CI); `w` are the words in
 * language.primary, English when not given.
 */
export async function installVaultFirstRunStep(
  i: { vaultConfigured: boolean; interactive: boolean; yes: boolean; dryRun: boolean },
  io: {
    ask?: (question: string, opts: { defaultYes?: boolean }) => Promise<boolean>;
    create?: (path: string) => Promise<{ path: string } | { error: string }>;
  } = {},
  w: InstallWords = installWordsIn("en")
): Promise<{ vaultPath: string | null; exit: number | null }> {
  const action = decideFirstRunVaultAction(i);
  // "error" = non-TTY/--yes without a vault: do nothing here — the per-surface
  // loop reports today's deterministic error, so scripts see exactly what they
  // saw before.
  if (action === "proceed" || action === "error") return { vaultPath: null, exit: null };
  if (action === "would-create") {
    process.stdout.write(w.wouldPromptVault);
    return { vaultPath: null, exit: null };
  }
  // action === "prompt" — ask once, default Yes.
  const accepted = await (io.ask ?? confirm)(w.firstRunQuestion, { defaultYes: true });
  if (!accepted) {
    process.stderr.write(w.vaultRequired(w.vaultPathRequired));
    return { vaultPath: null, exit: 1 };
  }
  const created = await (io.create ?? createVaultAt)(defaultVaultPath());
  if ("error" in created) {
    process.stderr.write(w.couldNotCreateDefault(created.error));
    process.stderr.write(w.vaultRequired(w.vaultPathRequired));
    return { vaultPath: null, exit: 1 };
  }
  process.stdout.write(w.created(created.path));
  return { vaultPath: created.path, exit: null };
}

/**
 * A vault path that does not exist, caught at install time.
 *
 * `--vault <path>` is the user naming the folder, so a missing one is created —
 * the same createVaultAt the first-run offer uses. A path that came from the
 * environment or an existing registration is NOT created: when it is missing the
 * likeliest cause is a drive that is not mounted, and an empty directory on the
 * mountpoint is exactly what would make the daemon serve nothing. That case is
 * named, and install goes on — the daemon does boot on a missing vault path and
 * answers with vault_missing (vault-presence.ts), which is the whole point of
 * saying it out loud here rather than leaving it to a silent empty result.
 * Returns an exit code when install must stop, else null.
 */
export async function installVaultPresenceStep(
  i: { flagPath: string | null; resolvedPath: string | null; dryRun: boolean },
  io: { create?: (path: string) => Promise<{ path: string } | { error: string }>; out?: (s: string) => void } = {},
  w: InstallWords = installWordsIn("en")
): Promise<number | null> {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const path = i.resolvedPath;
  const reason = missingVaultReason(path);
  if (!path || !reason) return null;
  if (i.flagPath && i.flagPath === path) {
    if (i.dryRun) {
      out(w.wouldCreateVault(path));
      return null;
    }
    const created = await (io.create ?? createVaultAt)(path);
    if ("error" in created) {
      process.stderr.write(w.couldNotCreateVault(path, created.error));
      return 1;
    }
    out(w.created(created.path));
    return null;
  }
  out(w.notCreating(reason));
  return null;
}

/** Script output (--json) stays English; the terminal follows language.primary. */
function scriptOutputLanguage(language: string, scriptOutput: boolean): string {
  return scriptOutput ? "en" : language;
}

function terminalAdapterLanguage(language: string, scriptOutput = false): string | undefined {
  return adapterDisplayLanguage(language, scriptOutput || !process.stdout.isTTY);
}

export async function cmdInstall(args: ParsedArgs): Promise<number> {
  // `bastra install --help` must document, never act — without this it would
  // fall through to the wizard (TTY) or the missing-surface error (script).
  // dispatch() now guards every command the same way (#330); this stays as the
  // direct-call guard, since cmdInstall is also reached from cmdUpdate.
  if (args.showHelp) {
    await showHelp("install");
    return 0;
  }

  // `--extension` (#218): the .mcpb Desktop Extension path — claude-desktop
  // only; Desktop's own dialog owns the final Install click.
  if (args.extension) {
    if (args.surface !== "claude-desktop") {
      process.stderr.write((await installWords()).extensionOnlyDesktop);
      return 2;
    }
    return cmdInstallExtension(args);
  }

  // Bare `bastra install` on a terminal → guided setup (selection lists for
  // vault, clients, semantic recall). Scripted invocations (a named surface,
  // --yes, --dry-run, non-TTY) never enter the wizard and keep the exact
  // pre-wizard behavior below.
  if (shouldRunWizard({ surface: args.surface, interactive: isInteractive(), yes: args.yes, dryRun: args.dryRun })) {
    return runInstallWizard(args);
  }

  const language = await taskCliLanguage().catch(() => "en");
  const w = installWordsIn(language);
  const screenLanguage = terminalAdapterLanguage(language);
  const targets = resolveTargets(args.surface, screenLanguage);
  if ("error" in targets) {
    process.stderr.write(w.error(targets.error));
    return 2;
  }

  const vaultPath = resolveVaultPath(args.vaultPath);
  const opts: InstallOpts = {
    dryRun: args.dryRun,
    vaultPath,
    force: args.yes,
    withStopHook: args.withStopHook,
    withBootstrap: args.withBootstrap,
  };

  // First-run vault guard (#178) — before the loop, so the offer never
  // repeats per surface.
  const preResolve = await resolveVault(opts);
  const firstRun = await installVaultFirstRunStep(
    {
      vaultConfigured: !("error" in preResolve),
      interactive: isInteractive(),
      yes: args.yes,
      dryRun: args.dryRun,
    },
    {},
    w
  );
  if (firstRun.exit !== null) return firstRun.exit;
  if (firstRun.vaultPath) opts.vaultPath = firstRun.vaultPath;
  const vaultStep = await installVaultPresenceStep(
    {
      flagPath: args.vaultPath,
      resolvedPath: opts.vaultPath ?? ("path" in preResolve ? preResolve.path : null),
      dryRun: args.dryRun,
    },
    {},
    w
  );
  if (vaultStep !== null) return vaultStep;

  // #350/#15: the compiled hook client for Claude Code and Codex. Runs before the
  // adapters plan their hook entries, and since #537 it is the single place that
  // decides WHICH client they register (opts.useStub). Nothing here fails the
  // install — the node client serves the same daemon lanes, just slower.
  if (targets.some((a) => a.surface === "claude-code" || a.surface === "codex")) {
    const stub = await ensureHookStub({
      dryRun: args.dryRun,
      mode: args.stub ?? "ask",
      interactive: isInteractive(),
      language: screenLanguage,
    });
    // #537: the ADAPTERS must not re-derive this from the disk. `--no-stub`
    // against an already downloaded binary used to register every Claude and
    // Codex hook on that binary anyway, because each adapter asked existsSync
    // instead of asking what was decided here.
    opts.useStub = stub.useStub;
    process.stdout.write(w.hookClient(stub.status === "failed", stub.detail));
  }

  let hadError = false;
  for (const adapter of targets) {
    process.stdout.write(`→ ${adapter.surface} (${adapterDescription(adapter, screenLanguage)})\n`);
    process.stdout.write(w.config(adapter.configPath));
    try {
      const r = await adapter.install(opts, screenLanguage);
      process.stdout.write(`  ${w.status(r.status)}: ${r.message}\n`);
      if (r.backupPath) process.stdout.write(w.backup(r.backupPath));
      if (r.status === "error") hadError = true;
    } catch (err) {
      hadError = true;
      process.stdout.write(w.surfaceError((err as Error).message));
    }
    process.stdout.write("\n");
  }
  if (hadError) return 1;

  // Semantic recall is a global concern (one daemon, one embedding engine), so
  // it runs ONCE at the end of a successful install — not per surface (#79).
  // Prompts only on a TTY without --yes and only when no provider is effective;
  // an Ollama failure never fails the install: surface registration is the job.
  await installSemanticRecallStep({ dryRun: args.dryRun, yes: args.yes, ollama: args.ollama, language });
  // Code awareness (#573): an optional companion, asked once, never blocking.
  await installCodeAwarenessStep({ dryRun: args.dryRun, yes: args.yes, language });

  // #317 — `npx bastra-recall install all` registers everything correctly and
  // still leaves no `bastra` on PATH, because npx installs nothing. This path
  // is the scripted one, so it must not prompt (the wizard offers the global
  // install); saying it out loud is what keeps the next documented step from
  // failing with 'command not found' and no explanation.
  if (
    !args.dryRun &&
    decideCliOnPath({ cliPath: FORWARDER_SCRIPT_PATH, resolvedBastra: findExecutable("bastra") }) === "offer"
  ) {
    process.stdout.write(`→ ${w.cliDeclined}\n\n`);
  }
  return 0;
}

async function uninstallLanguage(io?: { address?: AssistantAddressOptions }): Promise<string> {
  const address = io?.address;
  return address?.language ?? (await taskCliLanguage(address?.settingsPath).catch(() => "en"));
}

export async function cmdUninstall(
  args: ParsedArgs,
  io?: { address?: AssistantAddressOptions; notify?: () => Promise<void> }
): Promise<number> {
  const language = await uninstallLanguage(io);
  const a = addressWords(language);
  const w = installWordsIn(language);
  try {
    if (args.surface === "all" && (await hasManagedAssistantAddress(io?.address))) {
      if (args.dryRun) process.stdout.write(w.addressDryRun);
      else {
        const needs = await addressRemovalNeedsConsent(io?.address);
        if (needs && !(process.stdin.isTTY && process.stdout.isTTY && (await confirm(a.confirmUninstallRemove)))) {
          process.stderr.write(a.removeFirst);
          return 1;
        }
        try {
          await removeAssistantAddress({ ...io?.address, systemConsent: needs });
          await (io?.notify ?? notifyAssistantAddressDaemon)();
        } catch (e) {
          process.stderr.write(a.notRemoved((e as Error).message));
          return 1;
        }
      }
    }
  } catch (e) {
    process.stderr.write(a.notCheckedOrRemoved((e as Error).message));
    return 1;
  }
  const screenLanguage = terminalAdapterLanguage(language);
  const targets = resolveTargets(args.surface, screenLanguage);
  if ("error" in targets) {
    process.stderr.write(w.error(targets.error));
    return 2;
  }

  let hadError = false;
  const succeededSurfaces: string[] = [];
  for (const adapter of targets) {
    process.stdout.write(`→ ${adapter.surface} (${adapterDescription(adapter, screenLanguage)})\n`);
    process.stdout.write(w.config(adapter.configPath));
    try {
      const r = await adapter.uninstall({ dryRun: args.dryRun }, screenLanguage);
      process.stdout.write(`  ${w.status(r.status)}: ${r.message}\n`);
      if (r.backupPath) process.stdout.write(w.backup(r.backupPath));
      if (r.status === "error") hadError = true;
      if (r.status === "removed" || r.status === "would-remove" || r.status === "not-present") {
        succeededSurfaces.push(adapter.surface);
      }
    } catch (err) {
      hadError = true;
      process.stdout.write(w.surfaceError((err as Error).message));
    }
    process.stdout.write("\n");
  }

  // The shared skill survives per-surface uninstalls by design; once the loop
  // leaves no surface registration referencing it, it's an orphan — sweep it
  // so a full uninstall leaves nothing behind (#181). Silent when kept or
  // already absent. Only surfaces whose uninstall SUCCEEDED enter the
  // decision — a failed one counts as still registered.
  const sweep = await sweepSharedSkill({
    surface: args.surface,
    dryRun: args.dryRun,
    succeededSurfaces,
    language: screenLanguage,
  });
  if (sweep.status === "removed" || sweep.status === "would-remove") {
    process.stdout.write(w.sharedSkill);
    process.stdout.write(`  ${w.status(sweep.status)}: ${sweep.detail}\n\n`);
  }

  // Full uninstall: nothing references the pinned npx runtimes anymore —
  // remove ~/.bastra/runtime entirely (#180). Best-effort and silent when
  // absent; skipped when any surface errored (its registration may still
  // point into the runtime). A live daemon spawned from a runtime dir keeps
  // running via its open fds; the next install re-creates the dir.
  if (args.surface === "all" && !args.dryRun && !hadError && (await removeRuntimeBase())) {
    process.stdout.write(w.runtime);
    process.stdout.write(w.runtimeRemoved(w.status("removed")));
  }

  // Ollama is global, not a surface. On a full uninstall, if bastra activated
  // it, the login service is still running — print a teardown hint (we don't
  // auto-stop: the user may run Ollama for other things).
  if (args.surface === "all" && (await getEmbeddingProvider()) === "ollama") {
    process.stdout.write(w.ollamaStays);
  }
  return hadError ? 1 : 0;
}

export async function cmdDoctor(args: ParsedArgs): Promise<number> {
  // #702: the replay is its own report — the surface checks stay untouched.
  if (args.replay) return cmdDoctorReplay(args);
  const surface = args.surface ?? "all";
  // An explicitly named surface may be installed from scratch by --fix; on the
  // default 'all' we only repair surfaces that already exist, never silently
  // set up ones the user never asked for.
  const fixMissing = surface !== "all";
  // language.primary, read once for the whole run (English when unset or unreadable).
  const language = await taskCliLanguage().catch(() => "en");
  const w = doctorWordsIn(language);
  const screenLanguage = terminalAdapterLanguage(language, args.json);
  const targets = resolveTargets(surface, screenLanguage);
  if ("error" in targets) {
    process.stderr.write(w.error(targets.error));
    return 2;
  }

  let hadBroken = false;
  const clientFeatures: FeatureState["clients"] = [];
  const sessionStartClients: Parameters<typeof printSessionStartNote>[0] = [];
  for (const adapter of targets) {
    process.stdout.write(`→ ${adapter.surface} (${adapterDescription(adapter, screenLanguage)})\n`);
    process.stdout.write(w.config(adapter.configPath));
    try {
      const r = await adapter.doctor(screenLanguage);
      process.stdout.write(`  ${w.status(r.status)}: ${r.message}\n`);
      if (r.status === "broken" && !args.fix) hadBroken = true;
      if (r.features) clientFeatures.push({ surface: adapter.surface, features: r.features });
      sessionStartClients.push({ surface: adapter.surface, result: r });
      if (r.details) {
        for (const [k, v] of Object.entries(r.details)) {
          process.stdout.write(`    ${adapterDetailLabel(k, screenLanguage)}: ${v}\n`);
        }
      }
      if (args.fix && r.status !== "ok" && (r.status !== "missing" || fixMissing)) {
        const fix = await adapter.install(
          {
            dryRun: args.dryRun,
            vaultPath: resolveVaultPath(args.vaultPath),
            force: args.yes,
            withStopHook: args.withStopHook,
            withBootstrap: args.withBootstrap,
          },
          screenLanguage
        );
        process.stdout.write(w.fix(w.status(fix.status), fix.message));
        if (fix.backupPath) process.stdout.write(w.backup(fix.backupPath));
        if (fix.status === "error" || fix.status === "not-implemented") hadBroken = true;
      }
    } catch (err) {
      hadBroken = true;
      process.stdout.write(w.surfaceError((err as Error).message));
    }
    process.stdout.write("\n");
  }

  // Semantic recall is global, not a surface — reported as a NOTE (or an
  // actionable ⚠), never as a failure: BM25-only recall is degraded, not
  // broken, so it never flips doctor's exit code (#79).
  await printEmbeddingDoctorNote(language);
  await printVersionPairNote(w, language);
  await printDaemonOriginNote(language);
  await printAutostartNote(w, language);
  await printAssistantAddressNote();
  await printStubBinaryNote(w, language);
  await printAffectsFilesNote(resolveVaultPath(args.vaultPath), language);
  await printDerivedClaimsNote(resolveVaultPath(args.vaultPath), w, language);
  await printCodeGraphNote(w, language);
  await printBridgeLearningNote(w, language);
  await printClientMemoryNote(resolveVaultPath(args.vaultPath), w, language);
  const rulebookVault = await resolveVault({ dryRun: true, vaultPath: resolveVaultPath(args.vaultPath) });
  if (!("error" in rulebookVault)) {
    await printRulebookDoctorNote(rulebookVault.path);
    await printConflictCopiesNote(rulebookVault.path, language);
  }
  // #1472: does the tool list reach each client, and what does it cost.
  const deliveryLanguage = scriptOutputLanguage(language, args.json);
  await printDeliveryNote(
    clientFeatures.map((c) => ({ surface: c.surface, mcpSurface: c.features.mcpSurface })),
    fetchToolsFromDaemon(undefined, deliveryLanguage),
    deliveryLanguage
  );
  await printSessionStartNote(sessionStartClients, language, args.json);
  // What is switched off, as opposed to broken — never flips the exit code,
  // and --fix never turns a feature on.
  await printFeaturesNote(clientFeatures, resolveVaultPath(args.vaultPath), language);

  return hadBroken ? 1 : 0;
}

/**
 * The compiled hook binary (#546) — the fourth global check, and the only one
 * that looks at an artifact rather than at a registration.
 *
 * A registered hook points at an absolute path to a `deno compile` binary. The
 * registration being correct says nothing about the binary being current: the
 * one on the dev host was from 29.08. and ran for two weeks against sources
 * that had moved on, writing telemetry rows that could not be folded, and
 * nothing asked. `npm run test:stub` catches it in CI since #546; this asks it
 * in everyday use, before somebody spends days on numbers an old build made.
 *
 * A NOTE like the three above, never a failure: an out-of-date binary still
 * answers every hook call, it just is not the code that is here. And nothing
 * is built — the binary is asked for its stamp (~25 ms), it is not recompiled.
 */
/**
 * Unresolved `affects_files` entries (#578) — the fifth global check. Wording
 * and lookup live in `affects-files-note.ts`; this is the printer, shaped like
 * the four notes above it: silent when there is nothing to say, and never a
 * failure (a memory pointing at a moved file does not break anything).
 */
async function printAffectsFilesNote(cliVault: string | null, language: string): Promise<void> {
  try {
    // Same resolution as every other vault-touching command, so a machine
    // whose vault is only known from an existing registration is checked too.
    const vault = await resolveVault({ dryRun: true, vaultPath: cliVault });
    if ("error" in vault) return;
    const lines = await affectsFilesLines(defaultAffectsFilesIo(vault.path), language);
    if (lines.length === 0) return;
    process.stdout.write("→ affects_files\n");
    for (const line of lines) process.stdout.write(`  ${line}\n`);
    process.stdout.write("\n");
  } catch {
    /* a diagnostics NOTE must never break doctor */
  }
}

/**
 * The clients' own memory folders (#674): notes an agent saved to Claude
 * Code's or Codex's file-based memory never reach the vault. Silent when those
 * folders are empty; a NOTE, never a failure.
 */
async function printClientMemoryNote(cliVault: string | null, w: DoctorWords, language: string): Promise<void> {
  try {
    const vault = await resolveVault({ dryRun: true, vaultPath: cliVault });
    const lines = clientMemoryLines(await findClientMemoryDirs("error" in vault ? null : vault.path), language);
    if (lines.length === 0) return;
    process.stdout.write(w.clientMemory);
    for (const line of lines) process.stdout.write(`  ${line}\n`);
    process.stdout.write("\n");
  } catch {
    /* a diagnostics NOTE must never break doctor */
  }
}

/**
 * Derived claims (#609): which declared claims no longer agree with their
 * source. Wording and reading live in `derived-claims-note.ts`; silent when no
 * memory declares a claim, and like every global note never a failure.
 */
async function printDerivedClaimsNote(cliVault: string | null, w: DoctorWords, language: string): Promise<void> {
  try {
    const vault = await resolveVault({ dryRun: true, vaultPath: cliVault });
    if ("error" in vault) return;
    const lines = await derivedClaimsLines(defaultDerivedClaimsIo(vault.path), language);
    if (lines.length === 0) return;
    process.stdout.write(w.derivedClaims);
    for (const line of lines) process.stdout.write(`  ${line}\n`);
    process.stdout.write("\n");
  } catch {
    /* a diagnostics NOTE must never break doctor */
  }
}

/**
 * Code awareness (#573, #574): which Graphify Recall uses, which repositories
 * are enabled, and whether their graphs are current.
 *
 * Silent when nothing is enabled — which is the default, and not a problem to
 * report. Like every other global note it never flips doctor's exit code: a
 * missing or stale code graph is a degraded optional feature, not a broken
 * installation (C-090 is a release obligation, not a runtime one).
 */
async function printCodeGraphNote(w: DoctorWords, language: string): Promise<void> {
  try {
    const repos = await enabledRepos();
    const tool = await probeTool();
    if (repos.length === 0 && tool.usable === null && tool.external === null) return;

    process.stdout.write(w.codeAwareness);
    if (tool.usable !== null) {
      process.stdout.write(w.graphify(tool.usable.version, GRAPHIFY_PIN));
    } else if (repos.length > 0) {
      process.stdout.write(w.graphifyUnavailable(tool.reason));
    }
    if (tool.external !== null) {
      // Reported so an overlap is visible; Recall never changes it (#573).
      process.stdout.write(w.ownGraphify(tool.external.path));
    }
    // #1148: whether the daemon has paused (busy lock) or stopped (failed
    // builds) its automatic refresh, and when it tries again. The manifest
    // says when the graph was built, never why it is no longer rebuilt.
    const refresh = repos.length > 0 ? await fetchRefreshStatus() : null;
    for (const repo of repos) {
      const manifest = await readManifest(graphDirOf(repo));
      if (manifest === null) {
        process.stdout.write(w.noGraph(repo));
        continue;
      }
      const state = await scanFileState(repo).catch(() => null);
      const paused = refresh?.get(repo)?.givenUp === true;
      const stale = isStale(manifest, state?.newestMtimeMs ?? 0);
      process.stdout.write(w.built(stale || paused, repo, manifest.builtAt));
      process.stdout.write(w.builtEnd(stale));
      if (manifest.lastError !== null) {
        process.stdout.write(w.lastError(manifest.lastError));
      }
      process.stdout.write(w.experimental(await coverageMapStatus(repo, Date.now(), language)));
      const refreshState = refresh?.get(repo);
      if (refreshState !== undefined) {
        for (const line of refreshStatusLines(refreshState, new Date(), language))
          process.stdout.write(`    ${line}\n`);
      }
      // #582: the package boundary is the half of the graph Graphify does not
      // carry, and it fails SILENTLY — a changed id format costs every
      // cross-package answer while the graph still loads and looks fine.
      const loaded = await loadGraph(repo);
      if (loaded.ok) {
        for (const line of externalRefLines(loaded.graph.externalStats, language)) {
          process.stdout.write(`    ${line}\n`);
        }
      }
    }
    process.stdout.write("\n");
  } catch {
    /* a diagnostics NOTE must never break doctor */
  }
}

/**
 * Learned bridges (#672): is the opt-in bridge layer still learning? Wording
 * and reading live in `bridges-note.ts`; silent when shared recall is off, and
 * like every global note never a failure.
 */
async function printBridgeLearningNote(w: DoctorWords, language: string): Promise<void> {
  try {
    const enabled = await getSharedRecallEnabled();
    if (!enabled) return;
    const now = new Date();
    const runs = await readMintRuns(defaultLogDir(), await readLastMint(bridgesPath()), now);
    const lines = bridgeLearningLines({ enabled, live: await getSharedRecallLive(), runs, now, language });
    if (lines.length === 0) return;
    process.stdout.write(w.learnedBridges);
    for (const line of lines) process.stdout.write(`  ${line}\n`);
    process.stdout.write("\n");
  } catch {
    /* a diagnostics NOTE must never break doctor */
  }
}

async function printStubBinaryNote(w: DoctorWords, language: string): Promise<void> {
  try {
    const report = await stubFreshness();
    const lines = stubFreshnessLines(report, language);
    // Silent when no registration runs a compiled stub at all: this host is on
    // the node thin client, which ships inside `dist` and cannot drift from it.
    if (lines.length === 0) return;
    process.stdout.write(w.hookBinary);
    for (const line of lines) process.stdout.write(`  ${line}\n`);
    process.stdout.write("\n");
  } catch {
    /* a diagnostics NOTE must never break doctor */
  }
}

/**
 * Der Autostart — dritter globaler Check, und der einzige, der einen Zustand
 * AUSSERHALB der Installation beschreibt.
 *
 * Ein LaunchAgent zeigt auf einen absoluten Pfad. Nach einem Update, das die
 * Installation verschiebt (Homebrew legt jede Version in ein eigenes
 * Verzeichnis), zeigt er ins Leere — und niemand sagt es, weil launchd einen
 * Agenten, der nicht startet, still liegen lässt. Wie die beiden Notes darüber:
 * niemals ein Fehlschlag, nur ein Hinweis mit einer Handlung dran.
 */
async function printAutostartNote(w: DoctorWords, language: string): Promise<void> {
  try {
    const warning = await autostartWarning(undefined, undefined, undefined, undefined, autostartWordsIn(language));
    if (warning) process.stdout.write(w.autostart(warning));
  } catch {
    /* a diagnostics NOTE must never break doctor */
  }
}

/**
 * The CLI/daemon version pair (#225) — the second global, non-surface check.
 * Nothing compared the two constants, so an upgraded CLI talking to the daemon
 * from the previous install went unnoticed, and the update hint reported the
 * daemon's build as "you have <x>". A NOTE like the embedding block, never a
 * failure: a drifted pair still answers every call, it just isn't the build the
 * user installed.
 */
/** #684: who started the running daemon, and with whose env. #719: and
 *  whether its behaviour config is the configured one — compared only for a
 *  daemon on this machine; another host's is configured there. */
async function printDaemonOriginNote(language: string): Promise<void> {
  try {
    const probe = await probeDaemon();
    let configured: ReturnType<typeof configuredState> | undefined;
    if (probe.ok && probe.configFingerprint && probe.endpoint && canAutoSpawnAt(probe.endpoint)) {
      const agent = await autostartService()?.status();
      configured = configuredState((await readSettings()).daemon?.env, agent?.managed ? agent.env : null);
    }
    const lines = daemonOriginLines(probe, configured, process.platform, language);
    if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n\n`);
  } catch {
    /* a diagnostics NOTE must never break doctor */
  }
}

async function printVersionPairNote(w: DoctorWords, language: string): Promise<void> {
  try {
    const probe = await probeDaemon();
    process.stdout.write(w.version);
    if (!probe.ok || !probe.version) {
      process.stdout.write(w.noDaemon(VERSION));
      return;
    }
    // #329 first: when the daemon's own code was replaced under it, the number
    // it reports describes the process, not the installation — and "both
    // 0.9.0" would be the most misleading thing to print at that moment.
    if (probe.codeStale) {
      process.stdout.write(`  ⚠ ${describeStale(probe.codeStale, language)}\n\n`);
      return;
    }
    if (probe.version === VERSION) {
      process.stdout.write(w.bothVersions(w.status("ok"), VERSION));
      return;
    }
    process.stdout.write(w.versionDrift(VERSION, probe.version, w.driftHint));
  } catch {
    /* a diagnostics NOTE must never break doctor */
  }
}
