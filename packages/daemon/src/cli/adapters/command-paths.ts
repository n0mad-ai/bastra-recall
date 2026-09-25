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
  const tokens = [...cmd.matchAll(/"[^"]*"|'[^']*'|\S+/g)];
  let start = -1;
  let end = -1;
  // Only a whole absolute path counts. An unquoted path with a space splits
  // into fragments, and taking the first fragment for a "prefix" would write
  // it twice; such a command keeps the old behaviour (no wrapper kept).
  const rooted = (t: string): boolean => /^(?:[/~]|[A-Za-z]:[\\/])/.test(t);
  for (let i = 0; i < tokens.length && start < 0; i++) {
    const t = unquote(tokens[i][0]);
    if (!rooted(t)) continue;
    if (slashes(t).endsWith(`/${file}`)) {
      const node = i > 0 && /^node(\.exe)?$/.test(fileOf(unquote(tokens[i - 1][0])));
      start = node ? i - 1 : i;
      end = i;
    } else if (sub && /^bastra-hook(\.exe)?$/.test(fileOf(t)) && tokens[i + 1]?.[0] === sub) {
      start = i;
      end = i + 1;
    }
  }
  if (start < 0) return null;
  return {
    prefix: cmd.slice(0, tokens[start].index),
    suffix: cmd.slice(tokens[end].index + tokens[end][0].length),
  };
}

/**
 * The wrapper around lane `file`/`sub` among the entries already registered
 * for one event and matcher; `isOurs` recognises our entries the way each
 * adapter does. Empty when nothing wraps it.
 */
export function existingHookWrapper(
  entries: unknown[],
  matcher: string | undefined,
  file: string,
  sub: string | undefined,
  isOurs: (entry: unknown) => boolean,
): HookWrapper {
  for (const entry of entries) {
    if (!isOurs(entry)) continue;
    const record = entry as Record<string, unknown>;
    if ((record.matcher ?? undefined) !== matcher) continue;
    const handlers = Array.isArray(record.hooks) ? record.hooks : [];
    for (const h of handlers) {
      const cmd = (h as Record<string, unknown> | null)?.command;
      const wrap = typeof cmd === "string" ? hookWrapper(cmd, file, sub) : null;
      if (wrap) return wrap;
    }
  }
  return { prefix: "", suffix: "" };
}
