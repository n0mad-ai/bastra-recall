/**
 * Which options each command accepts — checked BEFORE anything runs (#536).
 *
 * The parser used to print `warning: unknown flag '--dryrun' ignored` and then
 * dispatch anyway. Measured on an isolated profile: `bastra uninstall cursor
 * --dryrun` warned, removed the real registration and exited 0 — a typo in a
 * rehearsal flag performed the mutation it was meant to rehearse. The same
 * shape turned `bastra logs --stats --days 1` into the default seven-day
 * report.
 *
 * So a misspelled or misplaced option is a usage error, not a warning: the
 * check runs in `parseArgs`, its findings ride along in `ParsedArgs.errors`,
 * and `main()` reports them and exits 2 before `dispatch()` is ever entered.
 *
 * The `=` form is part of the same check. `--vault=/x` is a value the parser
 * reads; `--dry-run=false` is not, and used to be dropped without a word —
 * the rehearsal flag the user tried to switch OFF stayed ON and the command
 * ran. Options that take no value reject an attached one, so no invocation is
 * ever understood differently from how it reads.
 *
 * Precedence decision (one, documented): validation wins over `--help`.
 * `bastra uninstall --dryrun --help` prints the error and exits 2 rather than
 * the help text — help is still side-effect free either way, and the stricter
 * order is the one that never leaves a user believing a flag was understood.
 */

/** Options that consume the next argv token as their value. */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--exclude",
  "--since",
  "--source",
  "--lines",
  "--vault",
  "--origin",
]);

/** Accepted on every command: pure documentation, no side effects. */
const GLOBAL_FLAGS = ["--help", "-h", "--version", "-v"] as const;

/**
 * One entry per dispatched command (plus "" for the bare panel invocation).
 * Keys must cover the switch in cli.ts — the drift gate enforces it, the same
 * way it does for COMMAND_HELP.
 */
export const COMMAND_FLAGS: Record<string, readonly string[]> = {
  "": [],
  help: [],
  version: [],
  install: [
    "--dry-run", "--vault", "--yes", "-y", "--ollama", "--no-ollama",
    "--with-stop-hook", "--no-stop-hook", "--stub", "--no-stub", "--extension",
  ],
  uninstall: ["--dry-run"],
  doctor: ["--fix", "--dry-run", "--vault", "--yes", "-y", "--with-stop-hook", "--no-stop-hook"],
  update: [
    "--staged", "--force", "--dry-run", "--vault", "--yes", "-y",
    "--ollama", "--no-ollama", "--with-stop-hook", "--no-stop-hook", "--stub", "--no-stub",
  ],
  autostart: ["--dry-run", "--force", "--json", "--vault"],
  status: ["--json", "--quiet", "-q"],
  config: [],
  embeddings: [],
  models: [],
  token: ["--json", "--origin"],
  commons: [],
  bridges: [],
  map: [],
  ui: [],
  import: ["--dry-run", "--vault", "--exclude"],
  onboard: ["--vault"],
  skills: ["--vault"],
  feedback: [],
  rules: ["--dry-run"],
  patches: [],
  completion: [],
  logs: ["--follow", "-f", "--since", "--source", "--lines", "--stats"],
};

/** Every option the CLI knows at all — used to tell "unknown" from "misplaced". */
const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  ...GLOBAL_FLAGS,
  ...Object.values(COMMAND_FLAGS).flat(),
]);

function isOption(token: string): boolean {
  return token.length > 1 && token.startsWith("-");
}

/** `--vault=/x` → `--vault`; everything else unchanged. */
function optionName(token: string): string {
  const eq = token.indexOf("=");
  return eq === -1 ? token : token.slice(0, eq);
}

/**
 * Every usage problem in `argv`, in the order they appear — empty when the
 * invocation is sound. Walks argv itself rather than reading the parse result,
 * because a missing value is only visible in the raw token stream.
 */
export function validateArgs(argv: string[]): string[] {
  const errors: string[] = [];
  // Whether a token is the value of the option before it depends on VALUE_FLAGS,
  // so the same walk answers both "which token is the command" and "which
  // option is missing its value".
  const consumed = new Set<number>();
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (consumed.has(i)) continue;
    const token = argv[i];
    if (!isOption(token)) {
      if (command === null) command = token;
      continue;
    }
    const name = optionName(token);
    if (!VALUE_FLAGS.has(name) || token !== name) continue;
    const value = argv[i + 1];
    // A value that looks like an option is never silently swallowed: `--vault
    // --json` loses the vault AND the flag, and nothing says so.
    if (value === undefined || isOption(value)) errors.push(`option '${name}' needs a value`);
    else consumed.add(i + 1);
  }

  const allowed = COMMAND_FLAGS[command ?? ""];
  for (let i = 0; i < argv.length; i++) {
    if (consumed.has(i)) continue;
    const token = argv[i];
    if (!isOption(token)) continue;
    const name = optionName(token);
    if (!KNOWN_FLAGS.has(name)) {
      errors.push(`unknown option '${name}'`);
      continue;
    }
    // The `=` form is only meaningful for an option that takes a value. The
    // parser matches `--dry-run` as an exact token and silently dropped
    // `--dry-run=false` — measured: `bastra uninstall cursor --dry-run=false`
    // exited 0, removed the registration and wrote a backup, having understood
    // neither the flag nor the value. A valueless option therefore REJECTS an
    // attached value rather than guessing which half the user meant; and an
    // empty one (`--vault=`) is the missing value it looks like, not a silent
    // fallback to the default vault.
    if (token !== name) {
      if (!VALUE_FLAGS.has(name)) {
        errors.push(`option '${name}' takes no value — write '${name}'`);
        continue;
      }
      if (token.slice(name.length + 1) === "") {
        errors.push(`option '${name}' needs a value`);
        continue;
      }
    }
    if ((GLOBAL_FLAGS as readonly string[]).includes(name)) continue;
    // An unknown COMMAND is the dispatcher's error message, not ours — say
    // nothing about its options rather than shadowing the better report.
    if (allowed === undefined) continue;
    if (!allowed.includes(name)) {
      errors.push(
        command === null
          ? `option '${name}' needs a command — run 'bastra help'`
          : `option '${name}' is not valid for 'bastra ${command}'`,
      );
    }
  }
  return errors;
}
