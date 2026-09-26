/**
 * What the user's own Claude Code permission rules say about a Bash command
 * (#650) — read-only, deterministic, cached by mtime. bastra never acts on it
 * against the user: a `deny` here is only ever reported, and Claude Code
 * itself still applies every rule to what the hook returns. It feeds two
 * things: the shadow telemetry of a switched-off shim (what the off switch
 * costs, next to what the user's settings would have done anyway) and the
 * wording of the one line that says the shim exists.
 *
 * Files, as Claude Code reads them: managed (the admin's), user
 * (`~/.claude/settings.json`, or under CLAUDE_CONFIG_DIR), project
 * (`<cwd>/.claude/settings.json`) and local (`<cwd>/.claude/settings.local.json`).
 * Rules: `Bash` / `Bash(*)` (every command), `Bash(rm:*)` (prefix), a
 * `*` glob (`Bash(rm -rf *)`), else the exact command. Across all files:
 * deny beats ask beats allow, as in Claude Code. A compound command is
 * judged per part (`&&`, `||`, `;`, `|`, newline): any part denied → deny,
 * any part asked → ask, every part allowed → allow.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Verdict = "deny" | "ask" | "allow" | "none";
type Kind = Exclude<Verdict, "none">;

interface Rule {
  kind: Kind;
  rule: string;
  file: string;
}

export interface BashVerdict {
  verdict: Verdict;
  /** The rule that decided it, and where it is written. */
  rule?: string;
  file?: string;
}

export function managedSettingsPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "win32") return "C:\\ProgramData\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

/** The settings files Claude Code reads for a session in `cwd`, managed first. */
export function settingsFiles(cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const user = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return [
    managedSettingsPath(),
    join(user, "settings.json"),
    ...(cwd ? [join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")] : []),
  ];
}

const cache = new Map<string, { mtimeMs: number; rules: Rule[] }>();

function rulesOf(file: string): Rule[] {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    cache.delete(file);
    return [];
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.rules;
  let rules: Rule[] = [];
  try {
    const perms = (JSON.parse(readFileSync(file, "utf8")) as { permissions?: Record<string, unknown> }).permissions ?? {};
    for (const kind of ["deny", "ask", "allow"] as const) {
      const list = perms[kind];
      if (Array.isArray(list)) {
        for (const r of list) if (typeof r === "string" && /^Bash(?:\(|$)/.test(r)) rules.push({ kind, rule: r, file });
      }
    }
  } catch {
    rules = []; // a file Claude Code cannot parse either
  }
  cache.set(file, { mtimeMs, rules });
  return rules;
}

/** Does one rule (`Bash(rm:*)`) cover one simple part of a command? */
export function ruleMatches(rule: string, part: string): boolean {
  const m = /^Bash(?:\((.*)\))?$/s.exec(rule);
  if (!m) return false;
  const inner = m[1];
  if (inner === undefined || inner === "" || inner === "*") return true;
  if (inner.endsWith(":*")) {
    const prefix = inner.slice(0, -2);
    return part === prefix || part.startsWith(prefix + " ");
  }
  if (inner.includes("*")) {
    const re = new RegExp("^" + inner.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "s");
    return re.test(part);
  }
  return part === inner;
}

function parts(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** The user's settings on this Bash command: deny / ask / allow / none. */
export function bashVerdict(command: string, files: string[]): BashVerdict {
  const rules = files.flatMap(rulesOf);
  const ps = parts(command);
  for (const kind of ["deny", "ask"] as const) {
    const r = rules.find((x) => x.kind === kind && ps.some((p) => ruleMatches(x.rule, p)));
    if (r) return { verdict: kind, rule: r.rule, file: r.file };
  }
  const allows = rules.filter((x) => x.kind === "allow");
  if (ps.length > 0 && ps.every((p) => allows.some((x) => ruleMatches(x.rule, p)))) {
    const r = allows.find((x) => ps.some((p) => ruleMatches(x.rule, p)));
    return { verdict: "allow", rule: r?.rule, file: r?.file };
  }
  return { verdict: "none" };
}
