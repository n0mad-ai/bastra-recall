export interface InstallOpts {
  dryRun: boolean;
  vaultPath: string | null;
  // --yes: replace a foreign statusLine instead of keeping it.
  force?: boolean;
  // Stop hook can emit multi-line save-eval suggestions, so it is opt-in.
  withStopHook?: boolean;
  /**
   * Which hook client this run registers (#537): true = the compiled stub,
   * false = the node thin client. Set once by the install step from
   * `ensureHookStub`, so `--no-stub` reaches every adapter instead of each one
   * probing the disk and preferring a binary the user just opted out of.
   * Undefined = no stub step ran (doctor --fix, direct adapter calls) — the
   * adapters then probe HOOK_STUB_BIN exactly as before.
   */
  useStub?: boolean;
}

export interface InstallResult {
  status: "installed" | "already-installed" | "would-install" | "error" | "not-implemented";
  message: string;
  configPath?: string;
  backupPath?: string;
}

export interface UninstallResult {
  status: "removed" | "not-present" | "would-remove" | "error" | "not-implemented";
  message: string;
  configPath?: string;
  backupPath?: string;
}

export interface DoctorResult {
  status: "ok" | "missing" | "broken" | "not-implemented";
  message: string;
  details?: Record<string, string>;
}

export interface Adapter {
  surface: string;
  description: string;
  configPath: string;
  install(opts: InstallOpts): Promise<InstallResult>;
  uninstall(opts: { dryRun: boolean }): Promise<UninstallResult>;
  doctor(): Promise<DoctorResult>;
}

export interface ParsedArgs {
  command: string | null;
  surface: string | null;
  dryRun: boolean;
  vaultPath: string | null;
  showHelp: boolean;
  showVersion: boolean;
  json: boolean;
  quiet: boolean;
  yes: boolean;
  fix: boolean;
  withStopHook: boolean;
  // `update --staged`: swap files only (npm/brew + re-register), no daemon
  // kickstart. The new code goes live on the next daemon boot. Used by the
  // SessionStart auto-update path so a running session is never disrupted.
  staged: boolean;
  // `update --force` (#268): install even though the preflight found locally
  // modified files. They are copied aside either way — forcing means "update
  // anyway", never "throw my work away". Ignored on the unattended --staged
  // path, which may never proceed past a finding.
  force: boolean;
  // `install --ollama` → "auto" (provision without asking); `--no-ollama`
  // → "skip"; null → ask ONCE at the end of a successful install (TTY only,
  // never with --yes/--dry-run; non-TTY prints the `bastra embeddings on` hint).
  ollama: "auto" | "skip" | null;
  // `token --origin <url>`: mint the token AND allowlist this browser Origin in
  // cli-settings.json in one step (so onboarding is a single command). null =
  // flag absent → `bastra token` behaves exactly as before.
  origin: string | null;
  // `install claude-desktop --extension`: hand the .mcpb Desktop Extension
  // to Claude Desktop instead of writing the config-file registration.
  extension: boolean;
  // `install --stub` → "yes" (download the compiled hook client without
  // asking); `--no-stub` → "skip" (node client, remembered); null → ask once
  // on a TTY and remember the answer (#350).
  stub: "yes" | "skip" | null;
  // `import vault --exclude <dir>` (#220, repeatable): additional directory
  // names to skip anywhere in the source tree.
  exclude: string[];
  // `logs` (#11): live tail, time window, source filter and output cap.
  // Kept as raw strings — `cmdLogs` owns parsing and the error messages.
  follow: boolean;
  since: string | null;
  source: string | null;
  lines: string | null;
  // `logs --stats` (#279 slice): aggregate the same files per trigger lane
  // instead of printing them line by line.
  stats: boolean;
  // All positional tokens, in order — for sub-commands like
  // `config set update.mode auto` that need more than command+surface.
  positional: string[];
  // Usage problems found by validateArgs (#536): an unknown option, one used on
  // a command that does not take it, or a value-taking option without a value.
  // `main()` reports them and exits 2 BEFORE dispatch — a typo in --dry-run
  // must never reach the mutation it was meant to rehearse. Optional so the
  // synthetic ParsedArgs `cmdUpdate` builds for its install run stays valid.
  errors?: string[];
}
