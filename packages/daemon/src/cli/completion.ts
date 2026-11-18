/**
 * `bastra completion <shell>` — Tab completion for bash, zsh and fish (#15).
 *
 * The scripts are static templates over one list of commands. That list is the
 * thing that rots: a new subcommand lands in cli.ts and completion keeps
 * offering yesterday's vocabulary, which is worse than no completion at all
 * because it reads as authoritative. `__tests__/cli-completion.test.ts` diffs
 * COMMANDS against the dispatch table in cli.ts, so the drift fails the build
 * instead of reaching a user's shell.
 */
import { taskCliLanguage } from "./task-cli-words.js";

/** Top-level subcommands, in the order `bastra help` lists them. */
export const COMMANDS = [
  "install",
  "uninstall",
  "doctor",
  "autostart",
  "status",
  "code",
  "logs",
  "update",
  "config",
  "address",
  "embeddings",
  "models",
  "token",
  "oauth",
  "commons",
  "bridges",
  "map",
  "ui",
  "import",
  "onboard",
  "skills",
  "rules",
  "tasks",
  "codex",
  "drafts",
  "suggestions",
  "patches",
  "feedback",
  "archive",
  "trash",
  "recall",
  "save",
  "reconcile",
  "completion",
  "help",
  "version",
] as const;

/** Surfaces accepted by install / uninstall / doctor. */
export const SURFACES = ["claude-desktop", "claude-code", "codex", "cursor", "all"] as const;

/** Flags worth completing — the ones with a stable meaning across commands. */
export const FLAGS = [
  "--help",
  "--version",
  "--dry-run",
  "--vault",
  "--json",
  "--quiet",
  "--yes",
  "--fix",
  "--follow",
  "--since",
  "--source",
  "--lines",
  "--ollama",
  "--no-ollama",
  "--staged",
  "--extension",
  "--exclude",
  "--origin",
  "--answers",
  "--replay",
  "--days",
  "--compare",
] as const;

export const SHELLS = ["bash", "zsh", "fish"] as const;
export type Shell = (typeof SHELLS)[number];

export function isShell(value: string): value is Shell {
  return (SHELLS as readonly string[]).includes(value);
}

function bashScript(): string {
  return `# bastra completion for bash
# install: bastra completion bash > /usr/local/etc/bash_completion.d/bastra
#      or: echo 'eval "$(bastra completion bash)"' >> ~/.bashrc
_bastra_completion() {
  local cur prev commands surfaces flags
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="${COMMANDS.join(" ")}"
  surfaces="${SURFACES.join(" ")}"
  flags="${FLAGS.join(" ")}"

  case "\$prev" in
    install|uninstall|doctor)
      COMPREPLY=( \$(compgen -W "\$surfaces" -- "\$cur") )
      return 0
      ;;
    --vault)
      COMPREPLY=( \$(compgen -d -- "\$cur") )
      return 0
      ;;
    --source)
      COMPREPLY=( \$(compgen -W "daemon hook all" -- "\$cur") )
      return 0
      ;;
    completion)
      COMPREPLY=( \$(compgen -W "${SHELLS.join(" ")}" -- "\$cur") )
      return 0
      ;;
  esac

  if [[ "\$cur" == -* ]]; then
    COMPREPLY=( \$(compgen -W "\$flags" -- "\$cur") )
  elif [[ \$COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( \$(compgen -W "\$commands" -- "\$cur") )
  fi
  return 0
}
complete -F _bastra_completion bastra
`;
}

function zshScript(): string {
  const pairs = COMMANDS.map((c) => `    '${c}'`).join("\n");
  return `#compdef bastra
# bastra completion for zsh
# install: bastra completion zsh > "\${fpath[1]}/_bastra"
#      or: echo 'eval "$(bastra completion zsh)"' >> ~/.zshrc

_bastra() {
  local -a commands surfaces
  commands=(
${pairs}
  )
  surfaces=(${SURFACES.join(" ")})

  _arguments -C \\
    '1: :->command' \\
    '2: :->argument' \\
    '*: :->rest'

  case "\$state" in
    command)
      _describe 'bastra command' commands
      ;;
    argument)
      case "\$words[2]" in
        install|uninstall|doctor)
          _describe 'surface' surfaces
          ;;
        completion)
          _values 'shell' ${SHELLS.map((s) => `'${s}'`).join(" ")}
          ;;
      esac
      ;;
    rest)
      _values 'flag' ${FLAGS.map((f) => `'${f}'`).join(" ")}
      ;;
  esac
}

_bastra "\$@"
`;
}

function fishScript(): string {
  const lines: string[] = [
    "# bastra completion for fish",
    "# install: bastra completion fish > ~/.config/fish/completions/bastra.fish",
    "",
    "# Subcommands only at position 1.",
    "complete -c bastra -f",
  ];
  for (const c of COMMANDS) {
    lines.push(`complete -c bastra -n __fish_use_subcommand -a ${c}`);
  }
  lines.push("", "# Surfaces for the commands that take one.");
  for (const cmd of ["install", "uninstall", "doctor"]) {
    for (const s of SURFACES) {
      lines.push(`complete -c bastra -n '__fish_seen_subcommand_from ${cmd}' -a ${s}`);
    }
  }
  lines.push("", "# Flags.");
  for (const f of FLAGS) {
    lines.push(`complete -c bastra -l ${f.replace(/^--/, "")}`);
  }
  lines.push(
    "",
    "complete -c bastra -n '__fish_seen_subcommand_from logs' -l source -a 'daemon hook all'",
    `complete -c bastra -n '__fish_seen_subcommand_from completion' -a '${SHELLS.join(" ")}'`,
    ""
  );
  return lines.join("\n");
}

export function completionScript(shell: Shell): string {
  switch (shell) {
    case "bash":
      return bashScript();
    case "zsh":
      return zshScript();
    case "fish":
      return fishScript();
  }
}

/** The errors of `bastra completion` by language.primary (#1602), English when
 *  unset or unlisted. Text the product writes — never matched against user text. */
export const COMPLETION_WORDS = {
  en: {
    whichShell: (shells: string) => `error: which shell? usage: bastra completion <${shells}>\n`,
    unknownShell: (shell: string, shells: string) =>
      `error: no completion for '${shell}' — supported shells: ${shells}\n`,
  },
  de: {
    whichShell: (shells: string) => `Fehler: welche Shell? Aufruf: bastra completion <${shells}>\n`,
    unknownShell: (shell: string, shells: string) =>
      `Fehler: keine Vervollständigung für '${shell}' — unterstützte Shells: ${shells}\n`,
  },
};
export const completionWordsIn = (language: string | undefined) =>
  COMPLETION_WORDS[(language ?? "en") as keyof typeof COMPLETION_WORDS] ?? COMPLETION_WORDS.en;

/** The settings are read only on an error: the script itself is the same in every language. */
export async function cmdCompletion(shell: string | null): Promise<number> {
  if (!shell || !isShell(shell)) {
    const w = completionWordsIn(await taskCliLanguage().catch(() => "en"));
    process.stderr.write(shell ? w.unknownShell(shell, SHELLS.join(", ")) : w.whichShell(SHELLS.join("|")));
    return 2;
  }
  process.stdout.write(completionScript(shell));
  return 0;
}
