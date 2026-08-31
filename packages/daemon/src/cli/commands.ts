/** CLI command orchestration, including Codex/ChatGPT installation (#15). */
import { resolveTargets } from "./registry.js";
import {
  VERSION,
  VERSION_DRIFT_HINT,
  probeDaemon,
  formatStatus,
  resolveVault,
  decideFirstRunVaultAction,
  defaultVaultPath,
  createVaultAt,
  DEFAULT_VAULT_DISPLAY,
  VAULT_REQUIRED_ERROR,
} from "./helpers.js";
import { installSemanticRecallStep, printEmbeddingDoctorNote } from "./embeddings-cmd.js";
import { sweepSharedSkill } from "./skill.js";
import { removeRuntimeBase } from "./stable-runtime.js";
import { CLI_DECLINED_NOTE, decideCliOnPath } from "./cli-on-path.js";
import { FORWARDER_SCRIPT_PATH } from "./paths.js";
import { findExecutable } from "./exec.js";
import { runInstallWizard, shouldRunWizard } from "./wizard.js";
import { cmdInstallExtension } from "./extension-install.js";
import { ensureHookStub } from "./stub-install.js";
import { confirm, isInteractive } from "./prompt.js";
import { getEmbeddingProvider } from "../settings.js";
import { showHelp } from "./help-text.js";
import { describeStale } from "../code-staleness.js";
import { autostartWarning } from "./autostart.js";
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
    extension: false,
    stub: null,
    exclude: [],
    follow: false,
    since: null,
    source: null,
    lines: null,
    stats: false,
    positional: [],
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
    else if (a === "--with-stop-hook") result.withStopHook = true; // kept for compat — now the default
    else if (a === "--no-stop-hook") result.withStopHook = false;
    else if (a === "--staged") result.staged = true;
    else if (a === "--force") result.force = true;
    else if (a === "--exclude") {
      const v = argv[++i];
      if (v) result.exclude.push(v);
    } else if (a.startsWith("--exclude=")) {
      const v = a.slice("--exclude=".length);
      if (v) result.exclude.push(v);
    }
    else if (a === "--follow" || a === "-f") result.follow = true;
    else if (a === "--stats") result.stats = true;
    else if (a === "--since") {
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
    }
    else if (a === "--extension") result.extension = true;
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
    } else if (a.startsWith("--")) {
      process.stderr.write(`warning: unknown flag '${a}' ignored\n`);
    } else {
      positional.push(a);
    }
  }

  result.command = positional[0] ?? null;
  result.surface = positional[1] ?? null;
  result.positional = positional;
  return result;
}

function resolveVaultPath(cliVault: string | null): string | null {
  return cliVault ?? process.env.BASTRA_VAULT_PATH ?? null;
}

export const FIRST_RUN_VAULT_QUESTION =
  `No memory vault configured yet. Create one at ${DEFAULT_VAULT_DISPLAY}?`;

/**
 * First-run vault step (#178): on a fresh machine there is nothing to
 * auto-detect, so without this the headline onboarding command errors once
 * per surface. Runs ONCE before the per-surface loop. Returns the created
 * vault path (the caller feeds it through opts.vaultPath — the same route a
 * --vault value takes), or an exit code when install must stop (refusal or
 * failed creation → the unchanged non-zero error semantics). `io` is
 * injectable for tests only (there is no TTY on CI).
 */
export async function installVaultFirstRunStep(
  i: { vaultConfigured: boolean; interactive: boolean; yes: boolean; dryRun: boolean },
  io: {
    ask?: (question: string, opts: { defaultYes?: boolean }) => Promise<boolean>;
    create?: (path: string) => Promise<{ path: string } | { error: string }>;
  } = {},
): Promise<{ vaultPath: string | null; exit: number | null }> {
  const action = decideFirstRunVaultAction(i);
  // "error" = non-TTY/--yes without a vault: do nothing here — the per-surface
  // loop reports today's deterministic error, so scripts see exactly what they
  // saw before.
  if (action === "proceed" || action === "error") return { vaultPath: null, exit: null };
  if (action === "would-create") {
    process.stdout.write(`~ would prompt to create ${DEFAULT_VAULT_DISPLAY} (dry-run): no vault configured yet\n\n`);
    return { vaultPath: null, exit: null };
  }
  // action === "prompt" — ask once, default Yes.
  const accepted = await (io.ask ?? confirm)(FIRST_RUN_VAULT_QUESTION, { defaultYes: true });
  if (!accepted) {
    process.stderr.write(`error: ${VAULT_REQUIRED_ERROR}\n`);
    return { vaultPath: null, exit: 1 };
  }
  const created = await (io.create ?? createVaultAt)(defaultVaultPath());
  if ("error" in created) {
    process.stderr.write(`✗ could not create ${DEFAULT_VAULT_DISPLAY}: ${created.error}\n`);
    process.stderr.write(`error: ${VAULT_REQUIRED_ERROR}\n`);
    return { vaultPath: null, exit: 1 };
  }
  process.stdout.write(`✓ created ${created.path} — your memories live here as plain markdown files\n\n`);
  return { vaultPath: created.path, exit: null };
}

export async function cmdInstall(args: ParsedArgs): Promise<number> {
  // `bastra install --help` must document, never act — without this it would
  // fall through to the wizard (TTY) or the missing-surface error (script).
  // dispatch() now guards every command the same way (#330); this stays as the
  // direct-call guard, since cmdInstall is also reached from cmdUpdate.
  if (args.showHelp) {
    showHelp("install");
    return 0;
  }

  // `--extension` (#218): the .mcpb Desktop Extension path — claude-desktop
  // only; Desktop's own dialog owns the final Install click.
  if (args.extension) {
    if (args.surface !== "claude-desktop") {
      process.stderr.write("error: --extension is only available for 'bastra install claude-desktop'\n");
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

  const targets = resolveTargets(args.surface);
  if ("error" in targets) {
    process.stderr.write(`error: ${targets.error}\n`);
    return 2;
  }

  const vaultPath = resolveVaultPath(args.vaultPath);
  const opts: InstallOpts = {
    dryRun: args.dryRun,
    vaultPath,
    force: args.yes,
    withStopHook: args.withStopHook,
  };

  // First-run vault guard (#178) — before the loop, so the offer never
  // repeats per surface.
  const preResolve = await resolveVault(opts);
  const firstRun = await installVaultFirstRunStep({
    vaultConfigured: !("error" in preResolve),
    interactive: isInteractive(),
    yes: args.yes,
    dryRun: args.dryRun,
  });
  if (firstRun.exit !== null) return firstRun.exit;
  if (firstRun.vaultPath) opts.vaultPath = firstRun.vaultPath;

  // #350/#15: the compiled hook client for Claude Code and Codex. Runs before the adapters
  // plan their hook entries, because registration prefers the stub only when
  // the binary already exists on disk (buildHookEntry). Nothing here fails the
  // install — the node client serves the same daemon lanes, just slower.
  if (targets.some((a) => a.surface === "claude-code" || a.surface === "codex")) {
    const stub = await ensureHookStub({ dryRun: args.dryRun, mode: args.stub ?? "ask", interactive: isInteractive() });
    process.stdout.write(`${stub.status === "failed" ? "⚠" : "·"} hook client: ${stub.detail}\n\n`);
  }

  let hadError = false;
  for (const adapter of targets) {
    process.stdout.write(`→ ${adapter.surface} (${adapter.description})\n`);
    process.stdout.write(`  config: ${adapter.configPath}\n`);
    try {
      const r = await adapter.install(opts);
      process.stdout.write(`  ${formatStatus(r.status)}: ${r.message}\n`);
      if (r.backupPath) process.stdout.write(`  backup: ${r.backupPath}\n`);
      if (r.status === "error") hadError = true;
    } catch (err) {
      hadError = true;
      process.stdout.write(`  error: ${(err as Error).message}\n`);
    }
    process.stdout.write("\n");
  }
  if (hadError) return 1;

  // Semantic recall is a global concern (one daemon, one embedding engine), so
  // it runs ONCE at the end of a successful install — not per surface (#79).
  // Prompts only on a TTY without --yes and only when no provider is effective;
  // an Ollama failure never fails the install: surface registration is the job.
  await installSemanticRecallStep({ dryRun: args.dryRun, yes: args.yes, ollama: args.ollama });

  // #317 — `npx bastra-recall install all` registers everything correctly and
  // still leaves no `bastra` on PATH, because npx installs nothing. This path
  // is the scripted one, so it must not prompt (the wizard offers the global
  // install); saying it out loud is what keeps the next documented step from
  // failing with 'command not found' and no explanation.
  if (
    !args.dryRun &&
    decideCliOnPath({ cliPath: FORWARDER_SCRIPT_PATH, resolvedBastra: findExecutable("bastra") }) === "offer"
  ) {
    process.stdout.write(`→ ${CLI_DECLINED_NOTE}\n\n`);
  }
  return 0;
}

export async function cmdUninstall(args: ParsedArgs): Promise<number> {
  const targets = resolveTargets(args.surface);
  if ("error" in targets) {
    process.stderr.write(`error: ${targets.error}\n`);
    return 2;
  }

  let hadError = false;
  const succeededSurfaces: string[] = [];
  for (const adapter of targets) {
    process.stdout.write(`→ ${adapter.surface} (${adapter.description})\n`);
    process.stdout.write(`  config: ${adapter.configPath}\n`);
    try {
      const r = await adapter.uninstall({ dryRun: args.dryRun });
      process.stdout.write(`  ${formatStatus(r.status)}: ${r.message}\n`);
      if (r.backupPath) process.stdout.write(`  backup: ${r.backupPath}\n`);
      if (r.status === "error") hadError = true;
      if (r.status === "removed" || r.status === "would-remove" || r.status === "not-present") {
        succeededSurfaces.push(adapter.surface);
      }
    } catch (err) {
      hadError = true;
      process.stdout.write(`  error: ${(err as Error).message}\n`);
    }
    process.stdout.write("\n");
  }

  // The shared skill survives per-surface uninstalls by design; once the loop
  // leaves no surface registration referencing it, it's an orphan — sweep it
  // so a full uninstall leaves nothing behind (#181). Silent when kept or
  // already absent. Only surfaces whose uninstall SUCCEEDED enter the
  // decision — a failed one counts as still registered.
  const sweep = await sweepSharedSkill({ surface: args.surface, dryRun: args.dryRun, succeededSurfaces });
  if (sweep.status === "removed" || sweep.status === "would-remove") {
    process.stdout.write("→ skill (shared across Claude surfaces)\n");
    process.stdout.write(`  ${formatStatus(sweep.status)}: ${sweep.detail}\n\n`);
  }

  // Full uninstall: nothing references the pinned npx runtimes anymore —
  // remove ~/.bastra/runtime entirely (#180). Best-effort and silent when
  // absent; skipped when any surface errored (its registration may still
  // point into the runtime). A live daemon spawned from a runtime dir keeps
  // running via its open fds; the next install re-creates the dir.
  if (args.surface === "all" && !args.dryRun && !hadError && (await removeRuntimeBase())) {
    process.stdout.write("→ runtime (pinned npx runtime, ~/.bastra/runtime)\n");
    process.stdout.write(`  ${formatStatus("removed")}: no surface registration references it anymore\n\n`);
  }

  // Ollama is global, not a surface. On a full uninstall, if bastra activated
  // it, the login service is still running — print a teardown hint (we don't
  // auto-stop: the user may run Ollama for other things).
  if (args.surface === "all" && (await getEmbeddingProvider()) === "ollama") {
    process.stdout.write(
      "→ semantic recall: Ollama stays configured and its login service may still run.\n" +
        "  Disable recall: bastra embeddings off\n" +
        "  Stop the service: brew services stop ollama\n\n",
    );
  }
  return hadError ? 1 : 0;
}

export async function cmdDoctor(args: ParsedArgs): Promise<number> {
  const surface = args.surface ?? "all";
  // An explicitly named surface may be installed from scratch by --fix; on the
  // default 'all' we only repair surfaces that already exist, never silently
  // set up ones the user never asked for.
  const fixMissing = surface !== "all";
  const targets = resolveTargets(surface);
  if ("error" in targets) {
    process.stderr.write(`error: ${targets.error}\n`);
    return 2;
  }

  let hadBroken = false;
  for (const adapter of targets) {
    process.stdout.write(`→ ${adapter.surface} (${adapter.description})\n`);
    process.stdout.write(`  config: ${adapter.configPath}\n`);
    try {
      const r = await adapter.doctor();
      process.stdout.write(`  ${formatStatus(r.status)}: ${r.message}\n`);
      if (r.status === "broken" && !args.fix) hadBroken = true;
      if (r.details) {
        for (const [k, v] of Object.entries(r.details)) {
          process.stdout.write(`    ${k}: ${v}\n`);
        }
      }
      if (args.fix && r.status !== "ok" && (r.status !== "missing" || fixMissing)) {
        const fix = await adapter.install({
          dryRun: args.dryRun,
          vaultPath: resolveVaultPath(args.vaultPath),
          force: args.yes,
          withStopHook: args.withStopHook,
        });
        process.stdout.write(`  fix: ${formatStatus(fix.status)}: ${fix.message}\n`);
        if (fix.backupPath) process.stdout.write(`  backup: ${fix.backupPath}\n`);
        if (fix.status === "error" || fix.status === "not-implemented") hadBroken = true;
      }
    } catch (err) {
      hadBroken = true;
      process.stdout.write(`  error: ${(err as Error).message}\n`);
    }
    process.stdout.write("\n");
  }

  // Semantic recall is global, not a surface — reported as a NOTE (or an
  // actionable ⚠), never as a failure: BM25-only recall is degraded, not
  // broken, so it never flips doctor's exit code (#79).
  await printEmbeddingDoctorNote();
  await printVersionPairNote();
  await printAutostartNote();

  return hadBroken ? 1 : 0;
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
async function printAutostartNote(): Promise<void> {
  try {
    const warning = await autostartWarning();
    if (warning) process.stdout.write(`→ autostart\n  ⚠ ${warning}\n\n`);
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
async function printVersionPairNote(): Promise<void> {
  try {
    const probe = await probeDaemon();
    process.stdout.write("→ version\n");
    if (!probe.ok || !probe.version) {
      process.stdout.write(`  · cli ${VERSION} (no running daemon to compare against)\n\n`);
      return;
    }
    // #329 first: when the daemon's own code was replaced under it, the number
    // it reports describes the process, not the installation — and "both
    // 0.9.0" would be the most misleading thing to print at that moment.
    if (probe.codeStale) {
      process.stdout.write(`  ⚠ ${describeStale(probe.codeStale)}\n\n`);
      return;
    }
    if (probe.version === VERSION) {
      process.stdout.write(`  ${formatStatus("ok")}: cli and daemon both ${VERSION}\n\n`);
      return;
    }
    process.stdout.write(
      `  ⚠ version drift: cli ${VERSION}, daemon ${probe.version} — ${VERSION_DRIFT_HINT}\n\n`,
    );
  } catch {
    /* a diagnostics NOTE must never break doctor */
  }
}
