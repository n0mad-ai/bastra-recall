/** Path matching for registered hook commands, shared by the Claude Code and Codex adapters. */

/**
 * Hook commands are matched on forward slashes. The installer writes whatever
 * the platform's `path.resolve` produces, so on Windows a registered command is
 * `node C:\Users\…\daemon\dist\session-hook.js` — and every `/${file}` match in
 * the adapters read that as "not registered": doctor reported a fresh, working install
 * as `broken — 0/7 hooks`, and the #321 path check never ran there. Normalising
 * only for the comparison keeps the returned paths native.
 */
export function slashes(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Last path segment under either separator (`C:\…\hook.js` → `hook.js`). */
export function fileOf(p: string): string {
  return slashes(p).split("/").pop() ?? "";
}

/** What a user wrapped around one of our hook runners (#647). */
export interface HookWrapper {
  prefix: string;
  suffix: string;
}

const unquote = (t: string): string => t.replace(/^["']|["']$/g, "");

export interface HookCommandToken {
  value: string;
  start: number;
  end: number;
  /** null for shell words; a shared id for words inside one quoted command argument. */
  group: number | null;
}

/** Keep shell words separate from the words inside `wrapper -- "node script"`.
 * A quoted log message is not a command, so only `--` opens an inner command. */
export function hookCommandTokens(cmd: string): HookCommandToken[] {
  const tokens: HookCommandToken[] = [];
  let previous = "";
  let group = 0;
  for (const outer of cmd.matchAll(/"[^"]*"|'[^']*'|\S+/g)) {
    const raw = outer[0];
    const start = outer.index ?? 0;
    const value = unquote(raw);
    tokens.push({ value, start, end: start + raw.length, group: null });
    if (/^["'].*["']$/.test(raw) && /\s/.test(value) && previous === "--") {
      const id = ++group;
      for (const inner of value.matchAll(/"[^"]*"|'[^']*'|\S+/g)) {
        const innerStart = start + 1 + (inner.index ?? 0);
        tokens.push({ value: unquote(inner[0]), start: innerStart, end: innerStart + inner[0].length, group: id });
      }
    }
    previous = raw;
  }
  return tokens;
}

/** Last real shell separator before a runner; quoted labels are data. */
export function lastShellOperatorCut(prefix: string): number {
  let quote: string | null = null;
  let escaped = false;
  let cut = 0;
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    let end = i;
    if (ch === ";" || ch === "|") end = i + 1 + (ch === "|" && prefix[i + 1] === "|" ? 1 : 0);
    else if (ch === "&" && prefix[i + 1] === "&") end = i + 2;
    if (end === i) continue;
    while (/\s/.test(prefix[end] ?? "")) end++;
    cut = end;
    i = end - 1;
  }
  return cut;
}

/**
 * The text before and after the runner in a registered hook command — the
 * runner being `node <…/file>` or `<…/bastra-hook> <sub>` — or null when the
 * command does not run that lane.
 *
 * A re-install used to replace the whole command, so a user's wrapper (a
 * logging shim that times every hook, `/usr/bin/env FOO=1 …`) was flattened
 * back to a bare `node …/hook.js` and nothing said so. Install replaces its
 * own runner and keeps whatever wraps it.
 */
export function hookWrapper(cmd: string, file: string, sub?: string): HookWrapper | null {
  const tokens = hookCommandTokens(cmd);
  let start = -1;
  let end = -1;
  // Only a whole absolute path counts. An unquoted path with a space splits
  // into fragments, and taking the first fragment for a "prefix" would write
  // it twice; such a command keeps the old behaviour (no wrapper kept).
  const rooted = (t: string): boolean => /^(?:[/~]|[A-Za-z]:[\\/])/.test(t);
  for (let i = 0; i < tokens.length && start < 0; i++) {
    const t = tokens[i].value;
    if (!rooted(t)) continue;
    if (slashes(t).endsWith(`/${file}`)) {
      const node = i > 0 && tokens[i - 1].group === tokens[i].group &&
        /^node(\.exe)?$/.test(fileOf(tokens[i - 1].value));
      start = node ? i - 1 : i;
      end = i;
    } else if (sub && /^bastra-hook(\.exe)?$/.test(fileOf(t)) &&
      tokens[i + 1]?.group === tokens[i].group && tokens[i + 1]?.value === sub) {
      start = i;
      end = i + 1;
    }
  }
  if (start < 0) return null;
  return {
    prefix: cmd.slice(0, tokens[start].start),
    suffix: cmd.slice(tokens[end].end),
  };
}

/**
 * The wrapper around lane `file`/`sub` among the entries already registered
 * for one event and matcher; `isOurs` recognises our entries the way each
 * adapter does. Empty when nothing wraps it. The same lane under an older
 * matcher counts too (#698 widened the plan lane's), so a changed matcher
 * does not drop the user's wrapping; the exact matcher wins when both exist.
 */
export function existingHookWrapper(
  entries: unknown[],
  matcher: string | undefined,
  file: string,
  sub: string | undefined,
  isOurs: (entry: unknown) => boolean,
): HookWrapper {
  for (const exact of [true, false]) {
    for (const entry of entries) {
      if (!isOurs(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (exact && (record.matcher ?? undefined) !== matcher) continue;
      const handlers = Array.isArray(record.hooks) ? record.hooks : [];
      for (const h of handlers) {
        const cmd = (h as Record<string, unknown> | null)?.command;
        const wrap = typeof cmd === "string" ? hookWrapper(cmd, file, sub) : null;
        if (wrap) return wrap;
      }
    }
  }
  return { prefix: "", suffix: "" };
}

/**
 * Whether a registered hook command runs one of our hook runners (#683).
 *
 * Recognition used to be a substring test (`bastra-recall` + `hook` anywhere
 * in the command), so a user's own `~/bin/my-bastra-recall-audit-hook.sh` was
 * claimed and deleted on install. What counts now is the program a token
 * names: the compiled stub (`bastra-hook`), one of our package bins
 * (`bastra-recall-session-hook`, the docs snippet; `nexus-recall-*` before
 * the rename), or one of our hook scripts — under `…/daemon/dist/`, or in any
 * directory when the command carries the installer's client marker.
 */
export function runsOurHookRunner(cmd: string, files: string[], clientMarker: string, stubSubcommand?: string): boolean {
  const words = [...cmd.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((m) => m[0]);
  const pathAt = (at: number): string => slashes(unquote(words[at] ?? ""));
  const baseAt = (at: number): string => fileOf(pathAt(at));
  let at = 0;
  let marked = false;
  const skipAssignments = (): void => {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? "")) {
      if (words[at] === clientMarker) marked = true;
      at++;
    }
  };
  skipAssignments();
  if (baseAt(at) === "env") {
    at++;
    skipAssignments();
  }
  // The wrapper observed in #647 accepts a child command after an optional tag.
  if (baseAt(at) === "hook-timer") {
    at++;
    if (words[at] === "--tag") at += 2;
    skipAssignments();
  }

  const program = baseAt(at);
  if (/^node(\.exe)?$/.test(program)) {
    const script = pathAt(at + 1);
    return files.includes(fileOf(script)) && (marked || script.includes("/daemon/dist/"));
  }
  if (/^bastra-hook(\.exe)?$/.test(program)) {
    return new Set(["session", "prompt", "write", "todo", "bash-pre", "bash-fail", "stop"]).has(words[at + 1] ?? "") &&
      (stubSubcommand === undefined || words[at + 1] === stubSubcommand);
  }
  const bin = /^(?:bastra|nexus)-recall-(.+?)(?:\.cmd)?$/.exec(program);
  if (bin && files.includes(`${bin[1]}.js`)) return true;
  return files.includes(program) && (marked || pathAt(at).includes("/daemon/dist/"));
}

/**
 * #683: the commands under `hooks` that the old substring recognition
 * (`lookedOurs`) claimed and `isOurs` no longer does. They stay registered;
 * install and uninstall say so instead of deleting them without a word.
 */
export function lookalikeHookCommands(
  hooks: Record<string, unknown>,
  events: readonly string[],
  isOurs: (entry: unknown) => boolean,
  lookedOurs: (cmd: string) => boolean,
): string[] {
  const found: string[] = [];
  for (const event of events) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    for (const entry of entries) {
      if (isOurs(entry)) continue;
      const handlers = (entry as Record<string, unknown> | null)?.hooks;
      for (const h of Array.isArray(handlers) ? handlers : []) {
        const cmd = (h as Record<string, unknown> | null)?.command;
        if (typeof cmd === "string" && lookedOurs(cmd) && !found.includes(cmd)) found.push(cmd);
      }
    }
  }
  return found;
}

/** The line install/uninstall print for those commands; undefined when there are none. */
export function leftAloneNote(commands: string[]): string | undefined {
  return commands.length > 0
    ? `hooks left alone (the name looks like ours, the command does not run a bastra-recall hook): ${commands.join(" | ")}`
    : undefined;
}
