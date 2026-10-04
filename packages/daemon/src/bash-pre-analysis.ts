/**
 * Bash tripwire lane — command analysis (split out of bash-pre-lane.ts, #680):
 * which destructive or risky acts a shell command carries once search terms,
 * data heredocs and prose arguments are set aside, whether bastra's rm/git
 * shims may take it, and the hint the lane shows for it. Pure: no I/O.
 */
import {
  DESTRUCTIVE_PATTERNS,
  RISKY_PATTERNS,
  RM_ARCHIVES,
  RM_SHIM,
  GIT_SHIM,
  reversibleDefault,
  rmShim,
  rmShimSwitchedOff,
  gitShim,
  gitShimSwitchedOff,
  type Undo,
} from "./bash-pre-patterns.js";
import type { BashVerdict } from "./cc-permissions.js";
import { gitAct, parseGit } from "./git-archive.js";

/**
 * Command heads that only READ (#415).
 *
 * `grep -rn "DROP TABLE" .` and `rg "git reset --hard" docs/` carry a
 * destructive pattern as their SEARCH TERM. Matching them fired a STOP warning
 * at somebody looking something up — observed on legitimate work, and the same
 * shape of noise that got the `>` redirect pattern removed in August: a
 * tripwire that cries on reading gets ignored when it warns on writing.
 */
const SEARCH_ONLY_HEAD = /^(?:sudo\s+)?(?:grep|egrep|fgrep|rg|ag|ack|git\s+grep)\b/;

/**
 * Consumers that swallow a heredoc as DATA (#521).
 *
 * #415 deliberately kept heredoc bodies in scope, because `bash <<EOF`
 * executes them. That holds for a shell; it does not hold for `cat > file`.
 * Drafting a Discord reply, an issue body or a commit message through a
 * heredoc is routine work, and any of them can MENTION a destructive command
 * in prose — observed: `cat > dm5.txt <<'EOF' … On rm -rf: … EOF` produced a
 * STOP warning while nothing destructive ran.
 *
 * An allowlist and not a blocklist on purpose: an unknown consumer keeps
 * today's behaviour, so a miss here can only fall on the safe side. Each
 * entry is tested against the SEGMENT that carries the `<<`, so a data sink
 * next to a real command (`cat > f <<EOF … ; rm -rf x`) loses only its body.
 */
const DATA_SINK_HEREDOC: RegExp[] = [
  // `cat > file` / `cat >> file` — not `2>`, not `>&`, not `>|`.
  /^(?:sudo\s+)?cat\s[^|]*(?<![0-9&])>>?\s*(?![&|])\S/,
  /^(?:sudo\s+)?tee\b(?:\s+-a)?\s+\S/,
  // Issue/PR/release bodies and commit messages read from stdin.
  /^gh\s[^|]*\s(?:--body-file|-F)[=\s]+-(?:\s|$)/,
  /^git\s+commit\b[^|]*\s(?:-F|--file)[=\s]+-(?:\s|$)/,
];

/**
 * The commit form Claude Code itself writes (#630): the value of a #540
 * message flag is `"$(cat <<'DELIM'` with a single-quoted delimiter and
 * nothing else inside the substitution. The header must end right after the
 * delimiter and hold no other `<<`; the body is data only when the line after
 * the terminator closes the substitution (`)"`) — see stripDataSinkHeredocBodies.
 * An unquoted delimiter or any other command in the substitution keeps firing.
 */
const MESSAGE_SUBST_HEREDOC: RegExp[] = [
  /^git(?:\s+(?:-[Cc]\s+[^\s-]\S*|--(?:git-dir|work-tree|namespace|config-env)\s+[^\s-]\S*|--(?!(?:git-dir|work-tree|namespace|config-env)(?:\s|$))[\w-]+(?:=\S+)?))*\s+(?:commit|tag)\b(?:(?!<<)[^|])*\s(?:-[a-zA-Z]*m|--message)(?:\s+|=)"\$\(cat\s+<<-?[ \t]*'[^']*'\s*$/,
  /^gh\s+(?:issue|pr|release)\b(?:(?!<<)[^|])*\s(?:-[tbn]|--(?:title|body|notes|comment|subject))(?:\s+|=)"\$\(cat\s+<<-?[ \t]*'[^']*'\s*$/,
];

/** `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`, `<<\WORD` — never `<<<`. */
const HEREDOC_OP = /<<(?!<)(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|(\\?[A-Za-z_][A-Za-z0-9_.-]*))/g;

interface HeredocSpec {
  delim: string;
  /** A quoted delimiter suppresses every expansion inside the body. */
  quoted: boolean;
  /** `<<-` strips leading tabs, including on the terminator line. */
  stripTabs: boolean;
  /** The consumer of this body is on the data-sink allowlist. */
  sink: boolean;
  /** #630: the body is a message flag's `"$(cat <<'DELIM' … )"` value. */
  messageSubst: boolean;
}

/** The heredocs opened by one physical line, in the order bash reads them. */
function headerHeredocs(line: string): HeredocSpec[] {
  if (!line.includes("<<")) return [];
  // A heredoc whose output feeds a pipeline can still land in a shell
  // (`cat <<'EOF' | bash`), so nothing on such a line counts as a sink.
  const piped = line.includes("|");
  const specs: HeredocSpec[] = [];
  for (const segment of line.split(/&&|;/)) {
    const messageSubst = !piped && MESSAGE_SUBST_HEREDOC.some((re) => re.test(segment.trim()));
    const sink = messageSubst || (!piped && DATA_SINK_HEREDOC.some((re) => re.test(segment.trim())));
    HEREDOC_OP.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HEREDOC_OP.exec(segment)) !== null) {
      const word = m[2] ?? m[3] ?? m[4] ?? "";
      specs.push({
        delim: word.startsWith("\\") ? word.slice(1) : word,
        quoted: m[2] !== undefined || m[3] !== undefined || word.startsWith("\\"),
        stripTabs: m[1] === "-",
        sink,
        messageSubst,
      });
    }
  }
  return specs;
}

/**
 * Drop the heredoc bodies that are pure data (#521).
 *
 * Only the BODY goes; the header line stays in scope, so a command after the
 * heredoc on that line (`cat > f <<'EOF' … ; rm -rf x`) and every line after
 * the terminator are still matched. Nested heredocs need no recursion: a
 * `bash <<'OUTER'` is no sink, so its whole body — inner heredoc included —
 * stays in scope, and a sink's body is dropped wholesale.
 */
function stripDataSinkHeredocBodies(cmd: string): string {
  if (!cmd.includes("<<")) return cmd;
  const lines = cmd.split("\n");
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++];
    kept.push(line);
    for (const spec of headerHeredocs(line)) {
      const body: string[] = [];
      let terminated = false;
      while (i < lines.length) {
        const raw = lines[i++];
        const candidate = spec.stripTabs ? raw.replace(/^\t+/, "") : raw;
        if (candidate.trim() === spec.delim) {
          terminated = true;
          break;
        }
        body.push(raw);
      }
      // #630: a message substitution is data only when it closes right after
      // the terminator — anything else inside `$(…)` would run.
      const substClosed = !spec.messageSubst || (terminated && (lines[i] ?? "").startsWith(')"'));
      // An unquoted delimiter expands the body: `$(…)` and backticks in it are
      // executed by the sink's own shell, so that body is a command, not data.
      const executable = !spec.sink || !substClosed || (!spec.quoted && /\$\(|`/.test(body.join("\n")));
      if (executable) kept.push(...body);
    }
  }
  return kept.join("\n");
}

/**
 * Flags whose quoted value is the message or body text (#540), per command
 * head. Everything these commands take is handed to git/gh as an argument and
 * never run by a shell, so the flag's value is data by POSITION — no attempt
 * is made to read the sentence. `git commit -am "…"` is a short-flag cluster
 * that ends in `-m`, which is why the git entry takes one.
 */
const GIT_MESSAGE_FLAG = /^(?:-[a-zA-Z]*m|--message)$/;
const GH_TEXT_FLAG = /^(?:-[tbn]|--(?:title|body|notes|comment|subject))$/;

/** Index of the git subcommand: past the global options (`-C <dir>`, `-c k=v`,
 *  `--git-dir <d>`, `--no-pager`, …) that may stand between `git` and it. */
function gitSubcommandAt(words: string[]): number {
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) {
    i += /^(?:-[Cc]|--(?:git-dir|work-tree|namespace|config-env))$/.test(words[i]) ? 2 : 1;
  }
  return i;
}

function proseFlagFor(words: string[]): RegExp | null {
  const sub = words[0] === "git" ? words[gitSubcommandAt(words)] : undefined;
  if (sub === "commit" || sub === "tag") return GIT_MESSAGE_FLAG;
  if (words[0] === "gh" && /^(?:issue|pr|release)$/.test(words[1] ?? "")) return GH_TEXT_FLAG;
  return null;
}

interface ShellWord {
  text: string;
  start: number;
  end: number;
  /** Where a single `'…'`/`"…"` part starts that runs to the word's end, with
   *  only plain characters before it (`"…"`, `--body="…"`); null otherwise. */
  quotedFrom: number | null;
}

const WORD_BREAK = " \t\n|&;()<>";

/** Shell line continuations disappear before tokenization, except inside
 * single quotes, where the backslash and newline are literal data. */
function joinShellLines(cmd: string): string {
  if (!cmd.includes("\\\n") && !cmd.includes("\\\r\n")) return cmd;
  // A quoted heredoc has literal physical lines: joining its body could hide
  // its terminator and swallow a later command. Its scanner already fails closed.
  if (cmd.includes("<<") && !simpleCommands(cmd)) return cmd;
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "\\" && quote !== "'") {
      if (cmd[i + 1] === "\n") { i++; continue; }
      if (cmd[i + 1] === "\r" && cmd[i + 2] === "\n") { i += 2; continue; }
      out += ch + (cmd[++i] ?? "");
      continue;
    }
    if (ch === quote) quote = null;
    else if (quote === null && (ch === "'" || ch === '"')) quote = ch;
    out += ch;
  }
  return out;
}

/**
 * Split a command into simple commands of words, honouring shell quoting.
 *
 * Returns null — "do not strip anything" — for every construct whose words it
 * cannot delimit exactly: a heredoc (its body is not shell text), command or
 * process substitution (`$(…)`, backticks, `<(…)`), `$'…'`/`$"…"` quoting, and
 * an unterminated quote. Bailing out keeps today's behaviour, so a gap in this
 * scanner can only fall on the safe side.
 */
function simpleCommands(cmd: string): Array<{ words: ShellWord[]; piped: boolean; background: boolean }> | null {
  const commands: Array<{ words: ShellWord[]; piped: boolean; background: boolean }> = [];
  let words: ShellWord[] = [];
  const close = (piped: boolean, background = false): void => {
    if (words.length > 0) commands.push({ words, piped, background });
    words = [];
  };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === " " || c === "\t") {
      i++;
    } else if (c === "#") {
      // A comment only starts at a word boundary; its quotes are not quotes.
      while (i < cmd.length && cmd[i] !== "\n") i++;
    } else if (c === "<" || c === ">") {
      if (cmd[i + 1] === "(") return null;
      if (c === "<" && cmd.startsWith("<<<", i)) i += 3;
      else if (c === "<" && cmd[i + 1] === "<") return null;
      else i += cmd[i + 1] === "&" || cmd[i + 1] === "|" || cmd[i + 1] === c ? 2 : 1;
    } else if (c === "&" && cmd[i + 1] === ">") {
      i += 2;
    } else if (c === "&") {
      // `&&` joins; a single `&` puts the command in the background.
      const and = cmd[i + 1] === "&";
      close(false, !and);
      i += and ? 2 : 1;
    } else if (c === "|") {
      const or = cmd[i + 1] === "|";
      close(!or);
      i += or || cmd[i + 1] === "&" ? 2 : 1;
    } else if (WORD_BREAK.includes(c)) {
      close(false);
      i++;
    } else {
      const start = i;
      let quotes = 0;
      let firstQuote = -1;
      let plainBefore = true;
      while (i < cmd.length && !WORD_BREAK.includes(cmd[i])) {
        const ch = cmd[i];
        if (ch === "'" || ch === '"') {
          if (firstQuote < 0) firstQuote = i;
          let j = i + 1;
          for (; j < cmd.length && cmd[j] !== ch; j++) {
            if (ch === "'") continue;
            if (cmd[j] === "\\") j++;
            else if (cmd[j] === "`" || (cmd[j] === "$" && cmd[j + 1] === "(")) return null;
          }
          if (j >= cmd.length) return null;
          quotes++;
          i = j + 1;
        } else if (ch === "`" || (ch === "$" && "('\"".includes(cmd[i + 1] ?? ""))) {
          return null;
        } else {
          if (firstQuote >= 0 || ch === "\\") plainBefore = false;
          i += ch === "\\" ? 2 : 1;
        }
      }
      const end = Math.min(i, cmd.length);
      words.push({
        text: cmd.slice(start, end),
        start,
        end,
        quotedFrom: quotes === 1 && plainBefore ? firstQuote : null,
      });
    }
  }
  close(false);
  return commands;
}

/**
 * Blank the quoted message/body values of git and gh (#540).
 *
 * #521 made heredoc bodies fed to a data sink out of scope; the same prose
 * reaches the tripwire as a quoted argument — `git commit -m "docs: why rm -rf
 * is blocked"`, `gh issue create --body "…git push --force…"`. Only the value
 * of a flag in `GIT_MESSAGE_FLAG`/`GH_TEXT_FLAG`, under the head it belongs
 * to, is blanked, and only when that value is exactly one quoted string.
 * Everything else keeps being matched: the command after the closing quote,
 * any other quoted argument, `bash -c "…"`/`eval "…"`, and every command whose
 * output feeds a pipe (it could land in a shell, as in #521).
 */
function stripProseArguments(cmd: string): string {
  if (!cmd.includes("'") && !cmd.includes('"')) return cmd;
  const commands = simpleCommands(cmd);
  if (!commands) return cmd;
  const spans: Array<[number, number]> = [];
  for (const { words, piped } of commands) {
    const flag = piped ? null : proseFlagFor(words.map((w) => w.text));
    if (!flag) continue;
    for (let k = 2; k < words.length; k++) {
      const w = words[k];
      const next = words[k + 1];
      if (flag.test(w.text) && next && next.quotedFrom === next.start) {
        spans.push([next.start, next.end]);
        k++;
      } else if (w.quotedFrom !== null && w.quotedFrom > w.start) {
        const prefix = w.text.slice(0, w.quotedFrom - w.start);
        if (prefix.startsWith("--") && prefix.endsWith("=") && flag.test(prefix.slice(0, -1))) {
          spans.push([w.quotedFrom, w.end]);
        }
      }
    }
  }
  let out = cmd;
  for (const [s, e] of spans.reverse()) out = out.slice(0, s) + "''" + out.slice(e);
  return out;
}

/**
 * The parts of a command line that actually run something (#415).
 *
 * Split on pipeline and sequence separators, then drop the segments that only
 * search. Per SEGMENT and not per command on purpose: `grep -rn "x" . | xargs
 * rm -rf` must still trip on its second half, and it does — only the `grep`
 * segment is dropped. A command with no separators is one segment, so the
 * common case costs a split of a short string.
 */
function executableSegments(cmd: string): string[] {
  return stripProseArguments(stripDataSinkHeredocBodies(cmd))
    .split(/\|\||&&|[|;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !SEARCH_ONLY_HEAD.test(s));
}

/** #540: quotes and backslashes inside a word do not change what runs —
 *  `"rm" -rf /`, `rm "-rf" /` and `r\m -rf /` are `rm -rf /`. Each segment is
 *  matched as written AND with them removed, so quoting cannot disguise a
 *  command the patterns would catch unquoted. */
function matchSegments(cmd: string): string[] {
  return executableSegments(joinShellLines(cmd)).flatMap((s) => [s, s.replace(/["'\\]/g, "")]);
}

export function matchPattern(cmd: string): { label: string; severity: "destructive" | "risky" } | null {
  const segments = matchSegments(cmd);
  for (const p of DESTRUCTIVE_PATTERNS) {
    if (segments.some((s) => p.re.test(s))) return { label: p.label, severity: "destructive" };
  }
  for (const p of RISKY_PATTERNS) {
    if (segments.some((s) => p.re.test(s))) return { label: p.label, severity: "risky" };
  }
  return null;
}

/** The rows whose receipt is the archiving rm. */
const RM_ROWS = DESTRUCTIVE_PATTERNS.filter((p) => p.undo === RM_ARCHIVES);

/** An `rm()` / `function rm` definition — the scanner splits at `(`, so this
 *  is read from the raw command (#657). No quote boundary: `grep "rm()"` is
 *  data; an `eval 'rm(){ … }'` is caught by re-reading the eval body. */
const RM_FUNCTION_DEF = /(?:^|[\s;&|({])(?:function\s+(?:rm|git)\b|(?:rm|git)\s*\(\s*\))/;

/** A word with its shell quotes removed: `'a b'` → `a b`, `"\$x"y` → `$xy`. */
function unquote(word: string): string {
  let out = "";
  let q: string | null = null;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (q === null && (ch === "'" || ch === '"')) q = ch;
    else if (ch === q) q = null;
    else if (ch === "\\" && q !== "'") out += word[++i] ?? "";
    else out += ch;
  }
  return out;
}

/** Reserved words that open a compound command or a pipeline; the word after
 *  them is at command position again, in THIS shell (#694). */
const LEADING_RESERVED = new Set(["{", "!", "if", "then", "else", "elif", "do", "while", "until"]);

/**
 * Where the command word stands: past `VAR=` assignments, the reserved words
 * that open a compound (`{ … }`, `if … then`, `!`, `time [-p]`, #694) and the
 * `builtin` / `command` prefixes. All of those still run the command in THIS
 * shell; `sudo`, `env`, `xargs` run a child, where `hash` or `alias` cannot
 * change this shell's `rm`. `echo hash -p …` is an argument, not a command.
 */
function commandWordAt(texts: string[]): number {
  let k = 0;
  for (;;) {
    while (k < texts.length && /^\w+(?:\[[^\]]*\])?\+?=/.test(texts[k])) k++;
    if (LEADING_RESERVED.has(texts[k])) k++;
    else if (texts[k] === "time") k += texts[k + 1] === "-p" ? 2 : 1;
    else if (texts[k] === "builtin") k++;
    else if (texts[k] === "command") for (k++; k < texts.length && texts[k].startsWith("-"); k++);
    else return k;
  }
}

/**
 * The names a `hash -p <path> name…` points at the path: every operand after
 * the path, not just the last — `hash -p /x rm python` sets both (#657).
 * No `-p` flag, no names.
 */
function hashPathNames(args: string[]): string[] {
  const i = args.findIndex((t) => /^-\w*p/.test(t));
  if (i < 0) return [];
  // `-p /x` takes the next word as the path; `-p/x` carries it attached.
  return args.slice(/^-\w*p$/.test(args[i]) ? i + 2 : i + 1);
}

/**
 * Does this command change what `rm` resolves to (#657)? A `PATH=`
 * assignment, `alias rm=…`, `hash -p <path> rm`, or an `rm()` / `function rm`
 * definition. The verb is read at command position (`commandWordAt`), so
 * `builtin hash` counts and `echo hash` does not. An `eval` body is shell and
 * is read again (two levels); a body the scanner cannot read counts as a
 * change, so an unknown form keeps the STOP. `"path"` when the only change is
 * a write to the variable `path` (#1047): renaming it would lift the STOP.
 */
function redefinesRm(cmd: string, depth = 0): boolean | "path" {
  if (RM_FUNCTION_DEF.test(cmd)) return true;
  const commands = simpleCommands(cmd);
  if (!commands) return true;
  let path = false;
  for (const { words } of commands) {
    const texts = words.map((w) => unquote(w.text));
    if (texts.some((t) => /^PATH\+?=/.test(t))) return true;
    const k = commandWordAt(texts);
    const args = texts.slice(k + 1);
    // Function names can contain quote/escape parts too: r""m() and
    // function 'rm' still replace rm, while echo 'rm()' is only data.
    if (texts[k] === "function" && /^(?:rm|git)$/.test(texts[k + 1] ?? "")) return true;
    if (/^(?:rm|git)$/.test(texts[k] ?? "") && /^\s*\(\s*\)/.test(cmd.slice(words[k].end))) return true;
    // `git` too: bastra's git snapshots are the other shim in the same PATH entry.
    if (texts[k] === "alias" && args.some((t) => /^(?:rm|git)=/.test(t))) return true;
    if (texts[k] === "hash" && hashPathNames(args).some((t) => /^(?:rm|git)$/.test(t))) return true;
    // zsh `hash rm=/bin/echo`: the assignment form of the same table entry.
    if (texts[k] === "hash" && args.some((t) => /^(?:rm|git)=/.test(t))) return true;
    // A sourced file runs in THIS shell and may set PATH or define `rm`; its
    // text is not in the command, so it counts as a change (#1047).
    if (texts[k] === "source" || texts[k] === ".") return true;
    // The variables this command writes: an assignment before the verb or
    // behind `export`/`declare`/…, `printf -v X`, `read X`, a nameref onto X
    // (`declare -n p=X`), and a `for`/`select` loop variable (`for X in …`,
    // `for X;`, `for X do`, zsh `for X Y in …`, #1047).
    const vars = [...texts.slice(0, k), ...(/^(?:export|declare|typeset|local|readonly)$/.test(texts[k]) ? args : [])].map(
      (t) => /^(\w+)(?:\[[^\]]*\])?\+?=/.exec(t)?.[1],
    );
    // `path[1]=…` above writes one element of the zsh array; `unset` drops it (#1047).
    if (texts[k] === "unset") vars.push(...args.map((t) => /^(\w+)/.exec(t)?.[1]));
    if (texts[k] === "printf") vars.push(...args.filter((_, j) => args[j - 1] === "-v"));
    if (texts[k] === "read") vars.push(...args);
    if (/^(?:declare|typeset|local)$/.test(texts[k]) && args.some((t) => /^-\w*n/.test(t))) {
      vars.push(...args.map((t) => /=(\w+)$/.exec(t)?.[1]));
    }
    if (/^(?:for|select)$/.test(texts[k])) {
      const end = args.findIndex((t) => t === "in" || t === "do");
      vars.push(...(end < 0 ? args : args.slice(0, end)));
    }
    if (vars.includes("PATH")) return true;
    // zsh ties `path` to PATH even for scalar assignments, reads and loop
    // variables. A bash variable named `path` can be harmless, but the shell
    // is not known here: keep STOP rather than claiming the archiving shim
    // certainly ran — and say why, so a rename brings the receipt back.
    if (vars.includes("path")) path = true;
    if (texts[k] === "eval") {
      const inner = depth >= 2 || redefinesRm(args.join(" "), depth + 1);
      if (inner === true) return true;
      if (inner === "path") path = true;
    }
  }
  return path ? "path" : false;
}

/**
 * Is every `rm -r` in this command the PATH-resolved `rm` of THIS shell — the
 * one an archiving shim can stand in for (#650)? The shim's directory is
 * EXPORTED in PATH, so a child that inherits PATH and looks `rm` up there
 * qualifies too: `xargs rm`, `find … -exec rm`, and a non-login `bash -c
 * "…rm…"` (its body is checked the same way). `sudo` (secure_path),
 * `/bin/rm`, `ssh host rm`, `docker exec … rm`, `git rm`, `bash -lc` (a
 * profile may reset PATH), a heredoc body (its consumer may be `ssh`) and
 * anything the scanner cannot delimit do not qualify. An allowlist on
 * purpose: a form not recognised here keeps the STOP. The same command must
 * also not change what `rm` resolves to (`redefinesRm`, #657).
 */
function rmRunsThroughPath(cmd: string, depth = 0, ignorePath = false): boolean {
  const redefined = redefinesRm(cmd);
  if (redefined === true || (redefined && !ignorePath)) return false;
  const commands = simpleCommands(cmd);
  if (!commands) return false;
  for (const { words } of commands) {
    const texts = words.map((w) => w.text.replace(/["'\\]/g, ""));
    if (!RM_ROWS.some((p) => p.re.test(texts.join(" ")))) continue;
    if (/^(?:ba|z|da)?sh$/.test(texts[0]) && texts[1] === "-c" && texts.length === 3) {
      if (depth >= 2 || !rmRunsThroughPath(unquote(words[2].text), depth + 1, ignorePath)) return false;
      continue;
    }
    if (texts[0] === "find") {
      const execs = texts.flatMap((t, i) => (/^-(?:exec|execdir|ok|okdir)$/.test(t) ? [i] : []));
      const rms = texts.flatMap((t, i) => (/\brm\b/.test(t) ? [i] : []));
      if (execs.length === 0 || rms.some((i) => !execs.includes(i - 1) || texts[i] !== "rm")) return false;
      continue;
    }
    let k = 0;
    if (texts[0] === "command") k = 1;
    else if (texts[0] === "xargs") for (k = 1; k < texts.length && texts[k].startsWith("-"); k++);
    if (texts[k] !== "rm") return false;
  }
  return true;
}

/** `find` flags that act on their own, not through `-exec rm`. */
const FIND_OWN_ACTS = /^-(?:delete|fprint\w*|fls)$/;
/** `xargs` flags that take no separate argument. Any other flag may take the
 *  next word (`-E rm`, `-I rm`) and make the command something else. */
const XARGS_BARE = /^-(?:[0rtx]+|[nLP]\d+|-null|-no-run-if-empty|-verbose|-exit)$/;
/** A redirection that writes nothing a user keeps: to /dev/null or a dup.
 *  `/dev/null` whole — not `/dev/null-x`, a file where /dev is writable. */
const HARMLESS_REDIRECT = /(?:\d|&)?>>?\s*\/dev\/null(?![\w.\/-])|\d?>&\d\b/g;

/**
 * Is this command nothing but `rm` (#650)? Rewriting needs
 * `permissionDecision: "allow"`, which allows the WHOLE command — so only a
 * command whose every simple command is an `rm` (plain, `command rm`, `xargs
 * rm` with bare flags, `find … -exec rm` without its own acts, a non-login
 * `bash -c`/`sh -c` of the same) or a `cd` qualifies, with no redirection
 * but to /dev/null. `rm -rf x && curl … | sh` does not.
 */
function shimOnly(cmd: string, take: { rm: boolean; git: boolean } = { rm: true, git: true }, depth = 0): boolean {
  // `rm -rf x > ~/.bashrc` truncates a file no archive keeps.
  if (/>/.test(cmd.replace(HARMLESS_REDIRECT, ""))) return false;
  // `${VAR@P}` expands VAR as a prompt: a `$(…)` in its value runs (bash ≥ 4.4).
  if (/@P\b/.test(cmd)) return false;
  const commands = simpleCommands(cmd);
  if (!commands) return false;
  for (const { words, background } of commands) {
    // `rm -rf x &` returns before the shim wrote its lines: the receipt would miss them.
    if (background) return false;
    const texts = words.map((w) => unquote(w.text));
    const k = commandWordAt(texts);
    const verb = texts[k];
    if (verb === "cd") continue;
    // Each shim only where it is on: the rewrite puts both first in PATH, and
    // `rm -rf build && git stash drop` must not run the one switched off.
    if (verb === "rm") {
      if (take.rm) continue;
      return false;
    }
    // A git act bastra's git shim makes reversible (git-archive.ts), as the
    // bare word at command position: no `VAR=` before it (GIT_DIR,
    // GIT_CONFIG_* would change which repo or config runs), no `command -p`,
    // no global option but `-C`.
    if (verb === "git") {
      if (!take.git) return false;
      if (k !== 0 && !(k === 1 && texts[0] === "command")) return false;
      const g = parseGit(texts.slice(k + 1));
      if (g && !g.otherGlobals && gitAct(g)) continue;
      return false;
    }
    if (verb === "xargs") {
      let j = k + 1;
      while (j < texts.length && XARGS_BARE.test(texts[j])) j++;
      if (texts[j] === "rm" && take.rm) continue;
      return false;
    }
    if (verb === "find") {
      const acts = texts.flatMap((t, i) => (/^-(?:exec|execdir|ok|okdir)$/.test(t) ? [i] : []));
      if (texts.some((t) => FIND_OWN_ACTS.test(t)) || acts.some((i) => texts[i + 1] !== "rm")) return false;
      if (acts.length > 0 && !take.rm) return false;
      continue;
    }
    // Not zsh: it reads ~/.zshenv first, which may put another rm ahead in PATH.
    if (/^(?:ba|da)?sh$/.test(verb) && texts[k + 1] === "-c" && texts.length === k + 3 && depth < 2) {
      if (shimOnly(texts[k + 2], take, depth + 1)) continue;
    }
    return false;
  }
  return true;
}

interface Hint {
  label: string;
  severity: "destructive" | "risky";
  /** null for a destructive hint: STOP. */
  undo: Undo | null;
  /** The receipt holds only if bastra's archiving `rm` runs the command:
   *  the lane rewrites it and allows it (see shimRewrite). */
  viaShim?: boolean;
  /** A shim is switched off (BASTRA_RM_SHIM=0 / BASTRA_GIT_SHIM=0); set when
   *  every act is one of its rows — then true if it would have taken this command. */
  wouldShim?: boolean;
  offFamily?: "rm" | "git";
  /** One of the acts runs through bastra's git shim. */
  viaGit?: boolean;
  /** The STOP comes only from a write to the variable `path` (#1047): with
   *  it renamed, the command would get its receipt. */
  pathVar?: boolean;
}

/**
 * The hint for a whole command (#651 review). Safety is a property of the
 * command, not of the first pattern in table order — `git branch -D x && gh
 * repo delete y` must not read like its first half. So every destructive act
 * in it is weighed:
 *
 * - an act without an undo → STOP, naming that act;
 * - several acts that are not all receipts → STOP (a hint names one form);
 * - the rm receipt only when every rm runs through this shell's PATH.
 */
export function hintFor(cmd: string, surface: string, setting = false): Hint | null {
  cmd = joinShellLines(cmd);
  const h = hintCore(cmd, surface, setting);
  if (!h || h.severity !== "destructive") return h;
  // Switched off, a family's rows get their plain hint; say what the shim
  // would have done, with the same decision it takes when on.
  const segments = matchSegments(cmd);
  const labels = DESTRUCTIVE_PATTERNS.filter((p) => segments.some((s) => p.re.test(s))).map((p) => p.label);
  if (labels.length === 0) return h;
  const family =
    rmShimSwitchedOff(surface, setting) && labels.every((l) => RM_ROWS.some((r) => r.label === l))
      ? "rm"
      : gitShimSwitchedOff(surface, setting) && labels.every((l) => GIT_SHIM[l])
        ? "git"
        : null;
  if (!family) return h;
  return { ...h, offFamily: family, wouldShim: (family === "git" || rmRunsThroughPath(cmd)) && shimOnly(cmd) };
}

function hintCore(cmd: string, surface: string, setting = false, ignorePath = false): Hint | null {
  const first = matchPattern(cmd);
  if (!first || first.severity === "risky") return first && { ...first, undo: null };
  const segments = matchSegments(cmd);
  const acts = DESTRUCTIVE_PATTERNS.filter((p) => segments.some((s) => p.re.test(s))).map((p) => ({
    label: p.label,
    undo: reversibleDefault(p.label, surface, setting),
  }));
  const stop = (label: string): Hint => ({ label, severity: "destructive", undo: null });
  const bare = acts.find((a) => a.undo === null);
  if (bare) return stop(bare.label);
  if (acts.length > 1 && acts.some((a) => a.undo?.kind !== "receipt")) return stop(first.label);
  const archivingRm = acts.some((a) => a.undo?.needsArchivingRm && a.undo.kind === "receipt");
  if (archivingRm && !rmRunsThroughPath(cmd, 0, ignorePath)) {
    // Name the variable only when it is the whole reason: weighed without it,
    // the command must reach a receipt.
    const pathVar = !ignorePath && redefinesRm(cmd) === "path" && hintCore(cmd, surface, setting, true)?.undo?.kind === "receipt";
    return pathVar ? { ...stop(first.label), pathVar } : stop(first.label);
  }
  const viaShim = acts.some((a) => a.undo === RM_SHIM || a.undo?.viaGitShim);
  // bastra's shims only run where the lane may rewrite: a command made of
  // their acts. Anywhere else the real `rm`/`git` runs, and the hint says so.
  if (viaShim && !shimOnly(cmd, { rm: rmShim(surface, setting), git: gitShim(surface, setting) })) return stop(first.label);
  // Every act here is a receipt (or the single act has an undo): say each
  // distinct receipt, not only the first (#658).
  const viaGit = acts.some((a) => a.undo?.viaGitShim);
  const distinct = acts.filter((a, i) => acts.findIndex((b) => b.undo === a.undo) === i);
  if (distinct.length < 2) return { ...first, undo: acts[0].undo, viaShim, viaGit };
  const text = distinct.map((a) => `\`${a.label}\`: ${a.undo?.text}`).join(" ");
  return { ...first, undo: { kind: "receipt", text }, viaShim, viaGit };
}

/** The literal targets of the command's `rm`s, for the one line below. */
function rmTargets(cmd: string): string[] {
  const out: string[] = [];
  for (const { words } of simpleCommands(cmd) ?? []) {
    const texts = words.map((w) => unquote(w.text));
    const k = commandWordAt(texts);
    if (texts[k] !== "rm") continue;
    let done = false;
    for (const t of texts.slice(k + 1)) {
      if (!done && t === "--") done = true;
      else if (done || !t.startsWith("-")) out.push(t);
    }
  }
  return out;
}

/**
 * One line when the shim is off and would have taken this command: what it
 * would have done, how to turn it on, and — read from the user's own Claude
 * Code rules — whether the stop comes from those rules. A user `deny` stays a
 * deny with the shim on too, so it gets no line (the shim would not have
 * saved this case); the shadow event still counts it.
 */
export function shimOffLine(command: string, settings: BashVerdict, family: "rm" | "git" = "rm"): string {
  if (settings.verdict === "deny") return "";
  if (family === "git") {
    // Not "without this stop": switched off, some of these rows are a
    // reversible form or a receipt, and the block above says which.
    const lead = "bastra's git snapshots are switched off here (BASTRA_GIT_SHIM=0). With them on, this exact command";
    const saved =
      "saves what it discards first (files git clean removes → ~/.bastra/archive; uncommitted changes, a deleted branch's or stash's commit → pinned under refs/bastra-archive/, restorable) and then runs as typed";
    const on =
      "They refuse in a repository that runs its own code on the act. Turn them on: unset BASTRA_GIT_SHIM (on with the archive opt-in) — the user's call, tell them.";
    if (settings.verdict === "ask") return `${lead} would still be asked about (your settings: \`${settings.rule}\`); once approved it ${saved}. ${on}`;
    if (settings.verdict === "allow") return `${lead} — which your settings allow (\`${settings.rule}\`), so it discards for real now — ${saved}. ${on}`;
    return `${lead} needs no confirmation: it ${saved}. ${on}`;
  }
  const t = rmTargets(command);
  const what = t.length === 0 ? "its targets" : t.slice(0, 3).map((x) => `\`${x}\``).join(", ") + (t.length > 3 ? ` and ${t.length - 3} more` : "");
  const moved = `would have moved ${what} to ~/.bastra/archive (restorable: \`bastra archive restore <path>\`; temp dirs really removed)`;
  const on = "Turn it on: unset BASTRA_RM_SHIM (on with the archive opt-in) — the user's call, tell them.";
  const lead = "bastra's archiving rm is switched off here (BASTRA_RM_SHIM=0). With it on, this exact command";
  if (settings.verdict === "ask") {
    return `${lead} would still be asked about (your settings: \`${settings.rule}\`), and once approved it ${moved} instead of deleting. ${on}`;
  }
  if (settings.verdict === "allow") {
    return `${lead} — which your settings allow (\`${settings.rule}\`), so it deletes for real — ${moved}. ${on}`;
  }
  return `${lead} would have run without this stop and ${moved}. ${on}`;
}
