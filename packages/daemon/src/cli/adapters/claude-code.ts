import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  CLAUDE_CODE_CONFIG,
  CLAUDE_CODE_SETTINGS,
  HOOK_STUB_BIN,
  PRE_TOOL_HOOK_BIN,
  SESSION_HOOK_BIN,
  PROMPT_HOOK_BIN,
  TODO_HOOK_BIN,
  BASH_PRE_HOOK_BIN,
  BASH_FAIL_HOOK_BIN,
  STOP_HOOK_BIN,
  STATUSLINE_BIN,
  SKILL_TARGET_FILE,
} from "../paths.js";
import {
  SERVER_KEY,
  atomicWriteJson,
  backupConfig,
  blocksMatch,
  buildServerBlock,
  fileExists,
  getServersBlock,
  probeDaemon,
  readJsonConfig,
  resolveVault,
} from "../helpers.js";
import { copySkill } from "../skill.js";
import { checkForwarderRegistration, ensureStableForwarder, mapBinToStableRuntime } from "../stable-runtime.js";
import type { Adapter, DoctorResult, InstallOpts, InstallResult, UninstallResult } from "../types.js";

// ─── Hook helpers (claude-code-only surface) ─────────────────────

type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop";

interface HookDef {
  event: HookEventName;
  matcher?: string;
  bin: string;
  timeout: number;
  note: string;
  /** #344: subcommand of the compiled stub that serves this lane. When set
   *  AND the stub binary exists, registration prefers `<stub> <subcommand>`
   *  over `node <bin>` — the stub starts in ~25ms against node's ~75ms floor,
   *  which is the whole point of compiling it. Since #369 every lane has one:
   *  session, todo and stop got their daemon-side pipelines (#369) and joined
   *  the stub, Stop being the one that fires at the end of every answer. */
  stubSubcommand?: string;
}

// Held separately from the list below because a run that does NOT register the
// Stop hook still needs its definition — to refresh an already-registered one
// (see planHookEntries).
const STOP_HOOK_DEF: HookDef = {
  event: "Stop", bin: STOP_HOOK_BIN, timeout: 3, note: "bastra-recall Stop hook (optional autonomous save-eval, #35)", stubSubcommand: "stop",
};

// Single source of truth for the reflex layer. The Stop hook is ON by default
// since the #48 redesign made it SILENT: suggestions go to
// ~/.bastra/pending-suggestions.json (read by the next SessionStart as
// additionalContext) instead of systemMessage, which Claude Code rendered 1:1
// into the chat. Live-validated → default on; opt out with --no-stop-hook.
function hookDefinitions(opts: { includeStop?: boolean } = {}): HookDef[] {
  const defs: HookDef[] = [
    { event: "SessionStart", matcher: "startup|resume|clear|compact", bin: SESSION_HOOK_BIN, timeout: 3, note: "bastra-recall SessionStart hook", stubSubcommand: "session" },
    { event: "UserPromptSubmit", bin: PROMPT_HOOK_BIN, timeout: 2, note: "bastra-recall UserPromptSubmit hook (lookup-mode, #33)", stubSubcommand: "prompt" },
    { event: "PreToolUse", matcher: "Write|Edit|MultiEdit|NotebookEdit", bin: PRE_TOOL_HOOK_BIN, timeout: 2, note: "bastra-recall PreToolUse hook", stubSubcommand: "write" },
    { event: "PreToolUse", matcher: "TodoWrite", bin: TODO_HOOK_BIN, timeout: 2, note: "bastra-recall TodoWrite hook (topology-recall, #36)", stubSubcommand: "todo" },
    { event: "PreToolUse", matcher: "Bash", bin: BASH_PRE_HOOK_BIN, timeout: 2, note: "bastra-recall Bash-pre hook (safety, #34)", stubSubcommand: "bash-pre" },
    { event: "PostToolUse", matcher: "Bash", bin: BASH_FAIL_HOOK_BIN, timeout: 2, note: "bastra-recall Bash post hook (act-signal #144 + lesson recall on fail #37)", stubSubcommand: "bash-fail" },
    { event: "PostToolUseFailure", matcher: "Bash", bin: BASH_FAIL_HOOK_BIN, timeout: 2, note: "bastra-recall Bash failure hook (act-signal #144 + lesson recall on fail #37)", stubSubcommand: "bash-fail" },
  ];
  if (opts.includeStop) defs.push(STOP_HOOK_DEF);
  return defs;
}

/**
 * #344: prefer the compiled stub when this lane has a subcommand and the
 * binary actually exists on this host. Plain npm installs have no stub (it is
 * downloaded per #350 or built locally via deno) — they keep the node thin
 * client, which serves the same daemon lane, just with node's start cost.
 *
 * `stubPresent` is injectable so the planner tests can pin BOTH registered
 * forms; production passes nothing and probes the disk.
 */
function buildHookEntry(
  def: HookDef,
  stubPresent: boolean = existsSync(HOOK_STUB_BIN),
): Record<string, unknown> {
  const command =
    def.stubSubcommand && stubPresent
      ? `${HOOK_STUB_BIN} ${def.stubSubcommand}`
      : `node ${def.bin}`;
  const entry: Record<string, unknown> = {};
  if (def.matcher) entry.matcher = def.matcher;
  entry.hooks = [{
    type: "command",
    command,
    timeout: def.timeout,
    __bastraRecall: true,
    __note: def.note,
  }];
  return entry;
}

// Hook bin filenames we own — recognised even on entries missing the
// __bastraRecall marker (e.g. older hand-added ones).
const OUR_HOOK_FILES = [
  "hook.js", "session-hook.js", "prompt-hook.js", "todo-hook.js",
  "bash-pre-hook.js", "bash-fail-hook.js", "stop-hook.js",
];
const REQUIRED_HOOK_FILES = OUR_HOOK_FILES.filter((f) => f !== "stop-hook.js");

/**
 * The stub subcommand that serves the lane whose node client is `<file>`, or
 * null when the lane has none. Derived from the defs above rather than a second
 * table: a lane's file and its subcommand drifting apart is exactly how the
 * detection below would go quietly blind again.
 */
export function stubSubcommandForFile(file: string): string | null {
  for (const def of hookDefinitions({ includeStop: true })) {
    if (def.bin.endsWith(`/${file}`) && def.stubSubcommand) return def.stubSubcommand;
  }
  return null;
}

/**
 * The stub binary a registered command executes for lane `sub`, or null when
 * the command is not that lane on the stub.
 *
 * Needed because a lane has TWO registered forms since #344/#350 —
 * `node /…/dist/prompt-hook.js` and `/…/stub/bastra-hook prompt` — and every
 * consumer that only knew the first went blind on stub installs: doctor
 * reported 3/7 registered and called a healthy surface broken (found while
 * moving the last three lanes onto the stub, #369).
 */
export function stubLaneCommandPath(cmd: string, sub: string, home: string = homedir()): string | null {
  // Leading program token, quoted (a path with spaces can only appear so) or bare.
  const m = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*(.*)$/.exec(cmd);
  if (!m) return null;
  const prog = m[1] ?? m[2] ?? m[3] ?? "";
  const base = prog.split("/").pop() ?? "";
  if (base !== "bastra-hook" && base !== "bastra-hook.exe") return null;
  const args = (m[4] ?? "").trim().split(/\s+/);
  if (args[0] !== sub) return null;
  return prog.startsWith("~/") ? join(home, prog.slice(2)) : prog;
}

function isOurHookEntry(matcher: unknown): boolean {
  if (typeof matcher !== "object" || matcher === null) return false;
  const m = matcher as Record<string, unknown>;
  const hooks = Array.isArray(m.hooks) ? m.hooks : [];
  return hooks.some((h: unknown) => {
    if (typeof h !== "object" || h === null) return false;
    const hh = h as Record<string, unknown>;
    if (hh.__bastraRecall === true || hh.__nexusRecall === true) return true;
    const cmd = typeof hh.command === "string" ? hh.command : "";
    if (cmd.includes("/daemon/dist/") && OUR_HOOK_FILES.some((f) => cmd.includes(`/${f}`))) return true;
    // Fallback (mirrors install-hook.sh): bare-bin / legacy command form, e.g.
    // `bastra-recall-session-hook` or `nexus-recall-*-hook` from the docs snippet.
    if ((cmd.includes("bastra-recall") || cmd.includes("nexus-recall")) && cmd.includes("hook")) return true;
    return false;
  });
}

const HOOK_EVENTS: HookEventName[] = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop",
];

/**
 * The path a hook command actually executes, pulled back out of the command
 * string (`node /…/dist/stop-hook.js`, quoted or not).
 *
 * Doctor needs the path, not just the filename: an entry can be registered and
 * still run a replaced runtime (#321). `~` is expanded because the check it
 * feeds compares against `~/.bastra/runtime/<version>/` as a real path.
 */
export function hookCommandPath(
  cmd: string,
  file: string,
  home: string = homedir(),
): string | null {
  const suffix = `/${file}`;
  const expand = (p: string) => (p.startsWith("~/") ? join(home, p.slice(2)) : p);
  // Quoted first — a path containing spaces can only appear that way.
  for (const m of cmd.matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const v = m[1] ?? m[2];
    if (v.endsWith(suffix)) return expand(v);
  }
  for (const tok of cmd.split(/\s+/)) {
    const t = tok.replace(/^["']+|["']+$/g, "");
    if (t.endsWith(suffix)) return expand(t);
  }
  return null;
}

/**
 * Every registered hook whose command does not execute the running version
 * (#321), one line per problem, empty when all of them are sound.
 *
 * A registered hook can still run replaced code: `N/N registered` answers
 * whether an entry exists, which is not the same question as whether it
 * executes what was just installed. Reporting only the first one is how a pin
 * to an evicted runtime survived an update while doctor called the surface
 * healthy — the check for exactly this shape existed since #304 and was applied
 * to the forwarder path alone. Here it is applied where the drift happened.
 *
 * `io` is injectable for tests; production passes nothing.
 */
export async function checkHookPaths(
  found: Iterable<readonly [string, string]>,
  io: {
    exists?: (p: string) => Promise<boolean>;
    running?: string;
    home?: string;
  } = {},
): Promise<string[]> {
  const exists = io.exists ?? fileExists;
  const home = io.home ?? homedir();
  const problems: string[] = [];
  for (const [file, cmd] of found) {
    const sub = stubSubcommandForFile(file);
    const path =
      hookCommandPath(cmd, file, home)
      ?? (sub ? stubLaneCommandPath(cmd, sub, home) : null);
    if (path === null) {
      problems.push(`${file}: no path in '${cmd}'`);
      continue;
    }
    const check = checkForwarderRegistration(path, await exists(path), "claude-code", io.running, home);
    if (check.broken) problems.push(`${file} → ${check.detail}`);
  }
  return problems;
}

// Which of our hook bins are actually registered, across every event, mapped to
// the command that runs them — doctor reports N/7 coverage from the keys and
// checks the paths from the values (#321).
export function registeredHookBins(hooks: Record<string, unknown>): Map<string, string> {
  return new Map(registeredHookCommands(hooks));
}

/** Every owned hook command, without deduplicating two event registrations
 * that intentionally share one binary (PostToolUse + PostToolUseFailure). */
export function registeredHookCommands(hooks: Record<string, unknown>): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const ev of HOOK_EVENTS) {
    const arr = Array.isArray(hooks[ev]) ? (hooks[ev] as unknown[]) : [];
    for (const entry of arr) {
      if (!isOurHookEntry(entry)) continue;
      const hs = (entry as Record<string, unknown>).hooks;
      if (!Array.isArray(hs)) continue;
      for (const h of hs) {
        const cmd = typeof (h as Record<string, unknown>)?.command === "string"
          ? ((h as Record<string, unknown>).command as string)
          : "";
        for (const f of OUR_HOOK_FILES) {
          if (cmd.includes(`/${f}`)) {
            found.push([f, cmd]);
            continue;
          }
          // …or the same lane on the compiled stub (#344/#350).
          const sub = stubSubcommandForFile(f);
          if (sub && stubLaneCommandPath(cmd, sub)) found.push([f, cmd]);
        }
      }
    }
  }
  return found;
}

/**
 * Required logical registrations that are absent from their exact event and
 * matcher. Counting hook binaries alone cannot see that the same bash-fail
 * binary must be registered on both PostToolUse and PostToolUseFailure: an old
 * seven-entry install otherwise still looks like 7/7 healthy to doctor.
 */
export function missingRequiredHookRegistrations(hooks: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const def of hookDefinitions()) {
    const entries = Array.isArray(hooks[def.event]) ? hooks[def.event] as unknown[] : [];
    const file = def.bin.split("/").pop() ?? "";
    const found = entries.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const record = entry as Record<string, unknown>;
      if ((record.matcher ?? undefined) !== (def.matcher ?? undefined)) return false;
      const handlers = Array.isArray(record.hooks) ? record.hooks : [];
      return handlers.some((handler) => {
        if (!handler || typeof handler !== "object") return false;
        const command = (handler as Record<string, unknown>).command;
        if (typeof command !== "string") return false;
        return command.includes(`/${file}`) ||
          (def.stubSubcommand ? stubLaneCommandPath(command, def.stubSubcommand) !== null : false);
      });
    });
    if (!found) missing.push(`${def.event}${def.matcher ? `:${def.matcher}` : ""}`);
  }
  return missing;
}

type HookStepStatus = "installed" | "already-installed" | "would-install" | "removed" | "not-present" | "would-remove" | "error";

export interface HookPlan {
  before: Record<HookEventName, unknown[]>;
  after: Record<HookEventName, unknown[]>;
  stopPreserved: boolean;
}

/**
 * Pure per-event planner — exported for tests (the real settings.json lives
 * under HOME). Returns the entry arrays as they are (`before`) and as they
 * should be (`after`); every foreign entry passes through untouched.
 */
export function planHookEntries(
  action: "install" | "uninstall",
  hooks: Record<string, unknown>,
  opts: {
    includeStop: boolean;
    mapBin?: (bin: string) => string;
    /** Test seam — see buildHookEntry. Omitted in production. */
    stubPresent?: boolean;
  },
): HookPlan {
  // Register the stable-runtime copy of each bin when active (#180) — hooks
  // pointing into the npx cache break on eviction just like the forwarder.
  // On non-npx installs mapBin is the identity (byte-identical no-op).
  const withBin = (def: HookDef): HookDef =>
    opts.mapBin ? { ...def, bin: opts.mapBin(def.bin) } : def;
  const defs = hookDefinitions({ includeStop: opts.includeStop }).map(withBin);
  const stopDef = withBin(STOP_HOOK_DEF);
  const stubPresent = opts.stubPresent ?? existsSync(HOOK_STUB_BIN);

  // Per event: keep all foreign entries, append our (possibly re-built) entries.
  const before: Record<HookEventName, unknown[]> = {} as Record<HookEventName, unknown[]>;
  const after: Record<HookEventName, unknown[]> = {} as Record<HookEventName, unknown[]>;
  let stopPreserved = false;
  for (const ev of HOOK_EVENTS) {
    const cur = Array.isArray(hooks[ev]) ? (hooks[ev] as unknown[]) : [];
    before[ev] = cur;
    // On install without --with-stop-hook, preserve a previously opted-in Stop
    // hook instead of stripping it: re-running install / `bastra update` must
    // not silently remove a hook the user enabled earlier (#48). What survives
    // is the opt-in DECISION, not the path it was written with: keeping the
    // entry verbatim left it pointing at the previous
    // ~/.bastra/runtime/<version>, which the same update then prunes — the #304
    // failure mode, on the one hook that never got re-registered. So our entry
    // is re-built from the current def, in place; foreign ones stay verbatim.
    if (action === "install" && !opts.includeStop && ev === "Stop") {
      stopPreserved = cur.some((m) => isOurHookEntry(m));
      after[ev] = cur.map((m) => (isOurHookEntry(m) ? buildHookEntry(stopDef, stubPresent) : m));
    } else {
      after[ev] = cur.filter((m) => !isOurHookEntry(m));
    }
  }
  if (action === "install") {
    for (const def of defs) after[def.event].push(buildHookEntry(def, stubPresent));
  }
  return { before, after, stopPreserved };
}

async function patchClaudeCodeHooks(
  action: "install" | "uninstall",
  opts: { dryRun: boolean; includeStop?: boolean; mapBin?: (bin: string) => string },
): Promise<{ status: HookStepStatus; detail: string; backupPath?: string }> {
  const sourceDefs = hookDefinitions({ includeStop: opts.includeStop });
  const includeStop = opts.includeStop === true;

  if (action === "install") {
    // Existence is checked against the SOURCE bins — under an active stable
    // runtime the copy may not exist yet (dry-run), but it mirrors these.
    for (const def of sourceDefs) {
      if (!(await fileExists(def.bin))) {
        return { status: "error", detail: `hook binary missing: ${def.bin} — run 'npm run build'` };
      }
    }
  }

  const read = await readJsonConfig(CLAUDE_CODE_SETTINGS);
  if ("error" in read) return { status: "error", detail: read.error };

  const data = read.data;
  const hooks = (data.hooks && typeof data.hooks === "object" && !Array.isArray(data.hooks))
    ? data.hooks as Record<string, unknown>
    : {};

  const { before, after, stopPreserved } = planHookEntries(action, hooks, {
    includeStop,
    mapBin: opts.mapBin,
  });
  const installNote = includeStop
    ? ""
    : stopPreserved
      ? " (existing Stop hook kept at current path)"
      : " (Stop hook optional/off)";

  const currentMatches = HOOK_EVENTS.every(
    (ev) => JSON.stringify(before[ev]) === JSON.stringify(after[ev]),
  );

  if (currentMatches) {
    return action === "install"
      ? { status: "already-installed", detail: `${sourceDefs.length} hooks already registered with matching paths${installNote}` }
      : { status: "not-present", detail: "no bastra-recall hooks present" };
  }

  if (opts.dryRun) {
    return action === "install"
      ? { status: "would-install", detail: `would (re)register ${sourceDefs.length} hooks across ${HOOK_EVENTS.length} events${installNote}` }
      : { status: "would-remove", detail: "would strip bastra-recall hook entries" };
  }

  // Commit changes
  for (const ev of HOOK_EVENTS) {
    if (after[ev].length > 0) hooks[ev] = after[ev];
    else delete hooks[ev];
  }
  data.hooks = hooks;

  const backupPath = await backupConfig(CLAUDE_CODE_SETTINGS);
  await atomicWriteJson(CLAUDE_CODE_SETTINGS, data);
  return action === "install"
    ? {
        status: "installed",
        detail: `${sourceDefs.length} hooks registered (SessionStart, UserPromptSubmit, PreToolUse×3, PostToolUse, PostToolUseFailure${includeStop ? ", Stop" : stopPreserved ? "; Stop kept at current path" : "; Stop optional/off"})`,
        backupPath: backupPath ?? undefined,
      }
    : { status: "removed", detail: "bastra-recall hook entries removed", backupPath: backupPath ?? undefined };
}

// ─── Statusline helpers ──────────────────────────────────────────

// Matches Daniel's hand-configured block + the One-command default:
//   node <statusline>/dist/index.mjs --style=powerline
// The bin is a parameter (#180): under an active stable runtime it points into
// the ~/.bastra/runtime copy instead of the npx cache.
// #347 stage 2: same stub policy as the hook lanes (#344) — when the compiled
// stub exists on this host, register `bastra-hook statusline` for the fast
// start; plain npm installs keep the node client.
function statuslineCommand(bin: string): string {
  return existsSync(HOOK_STUB_BIN)
    ? `${HOOK_STUB_BIN} statusline --style=powerline`
    : `node ${bin} --style=powerline`;
}

function buildStatuslineBlock(command: string): Record<string, unknown> {
  return {
    type: "command",
    command,
    refreshInterval: 1,
    __bastraRecall: true,
  };
}

// Recognise our statusLine — by marker (our writes) or by command path
// (hand-configured ones that predate the marker).
function isOurStatusline(sl: unknown): boolean {
  if (typeof sl !== "object" || sl === null) return false;
  const s = sl as Record<string, unknown>;
  if (s.__bastraRecall === true || s.__nexusRecall === true) return true;
  const cmd = typeof s.command === "string" ? s.command : "";
  return (
    cmd.includes("bastra-statusline") ||
    cmd.includes("/statusline/dist/index.mjs") ||
    cmd.includes("/statusline/bin/claude-powerline") ||
    (cmd.includes("statusline") && cmd.includes("bastra"))
  );
}

function statuslineMatches(sl: unknown, command: string): boolean {
  if (typeof sl !== "object" || sl === null) return false;
  const s = sl as Record<string, unknown>;
  return (
    s.command === command &&
    s.type === "command" &&
    s.refreshInterval === 1
  );
}

type StatuslineStepStatus =
  | "installed" | "already-installed" | "would-install" | "foreign-kept"
  | "removed" | "not-present" | "would-remove" | "error";

async function patchClaudeCodeStatusline(
  action: "install" | "uninstall",
  opts: { dryRun: boolean; force: boolean; bin?: string },
): Promise<{ status: StatuslineStepStatus; detail: string; backupPath?: string }> {
  // opts.bin: the path to REGISTER (stable-runtime copy when active, #180).
  // Build/existence is still checked against the source STATUSLINE_BIN — the
  // copy mirrors it and may not exist yet under dry-run.
  const command = statuslineCommand(opts.bin ?? STATUSLINE_BIN);
  if (action === "install" && !(await fileExists(STATUSLINE_BIN))) {
    return { status: "error", detail: `statusline not built: ${STATUSLINE_BIN} — run 'npm run build'` };
  }

  const read = await readJsonConfig(CLAUDE_CODE_SETTINGS);
  if ("error" in read) return { status: "error", detail: read.error };
  const data = read.data;
  const existing = data.statusLine;
  const present = existing !== undefined && existing !== null;

  if (action === "install") {
    // A different statusLine is configured → never clobber it without --yes.
    if (present && !isOurStatusline(existing)) {
      if (!opts.force) {
        return { status: "foreign-kept", detail: "a different statusLine is configured — kept it (pass --yes to use bastra's)" };
      }
    } else if (statuslineMatches(existing, command)) {
      return { status: "already-installed", detail: "bastra statusLine already configured" };
    }

    if (opts.dryRun) {
      const verb = !present ? "would add" : isOurStatusline(existing) ? "would update" : "would replace foreign";
      return { status: "would-install", detail: `${verb} statusLine → ${command}` };
    }

    const backupPath = await backupConfig(CLAUDE_CODE_SETTINGS);
    data.statusLine = buildStatuslineBlock(command);
    await atomicWriteJson(CLAUDE_CODE_SETTINGS, data);
    const how = !present ? "powerline, refreshInterval 1s" : isOurStatusline(existing) ? "path updated" : "replaced foreign";
    return { status: "installed", detail: `statusLine registered (${how})`, backupPath: backupPath ?? undefined };
  }

  // uninstall — only remove our own statusLine, never a foreign one.
  if (!present || !isOurStatusline(existing)) {
    return { status: "not-present", detail: present ? "statusLine is not bastra's — kept" : "no statusLine present" };
  }
  if (opts.dryRun) return { status: "would-remove", detail: "would remove bastra statusLine" };

  const backupPath = await backupConfig(CLAUDE_CODE_SETTINGS);
  delete data.statusLine;
  await atomicWriteJson(CLAUDE_CODE_SETTINGS, data);
  return { status: "removed", detail: "bastra statusLine removed", backupPath: backupPath ?? undefined };
}

// ─── Adapter functions ───────────────────────────────────────────

async function claudeCodeInstall(opts: InstallOpts): Promise<InstallResult> {
  const configPath = CLAUDE_CODE_CONFIG;
  const vault = await resolveVault(opts);
  if ("error" in vault) return { status: "error", message: vault.error, configPath };

  const fwd = await ensureStableForwarder({ dryRun: opts.dryRun });
  // #180: hooks and statusline must survive npx-cache eviction like the
  // forwarder — register the stable-runtime copy of every bin when active.
  // On non-npx installs mapBin is the identity (byte-identical no-op).
  const mapBin = (bin: string) => mapBinToStableRuntime(bin, fwd);
  const block = buildServerBlock(vault.path, fwd.path);
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "error", message: read.error, configPath };

  const data = read.data;
  const servers = getServersBlock(data) ?? {};

  const mcpMatches = blocksMatch(servers[SERVER_KEY], block);
  const skillResult = await copySkill({ dryRun: opts.dryRun });
  const hookResult = await patchClaudeCodeHooks("install", {
    dryRun: opts.dryRun,
    includeStop: opts.withStopHook === true,
    mapBin,
  });
  const statuslineResult = await patchClaudeCodeStatusline("install", {
    dryRun: opts.dryRun,
    force: opts.force === true,
    bin: mapBin(STATUSLINE_BIN),
  });

  if (skillResult.status === "error") return { status: "error", message: `skill: ${skillResult.detail}`, configPath };
  if (hookResult.status === "error") return { status: "error", message: `hooks: ${hookResult.detail}`, configPath };
  if (statuslineResult.status === "error") return { status: "error", message: `statusline: ${statuslineResult.detail}`, configPath };

  // If everything is already in place: no MCP write, no Skill write, no Hook write.
  // A kept foreign statusLine counts as settled (nothing to write) — we just
  // surface the hint that --yes would switch it to bastra's.
  const statuslineSettled =
    statuslineResult.status === "already-installed" || statuslineResult.status === "foreign-kept";
  const allAlreadyInstalled =
    mcpMatches &&
    skillResult.status === "already-installed" &&
    hookResult.status === "already-installed" &&
    statuslineSettled;
  if (allAlreadyInstalled) {
    const msg = statuslineResult.status === "foreign-kept"
      ? "MCP, skill, hooks in place; statusLine: foreign one kept (pass --yes to use bastra's)"
      : "MCP server, skill, hooks, and statusLine all already in place";
    return { status: "already-installed", message: msg, configPath };
  }

  if (opts.dryRun) {
    const steps: string[] = [];
    if (fwd.note) steps.push(`runtime: ${fwd.note}`);
    if (!mcpMatches) steps.push(`mcp: would register '${SERVER_KEY}' in ${configPath}`);
    else steps.push("mcp: already matches");
    steps.push(`skill: ${skillResult.detail}`);
    steps.push(`hooks: ${hookResult.detail}`);
    steps.push(`statusline: ${statuslineResult.detail}`);
    return { status: "would-install", message: steps.join("\n  · "), configPath };
  }

  // Write MCP block (if changed)
  let backupPath: string | undefined;
  if (!mcpMatches) {
    backupPath = (await backupConfig(configPath)) ?? undefined;
    data.mcpServers = { ...servers, [SERVER_KEY]: block };
    await atomicWriteJson(configPath, data);
  }

  const lines: string[] = [];
  if (fwd.note) lines.push(`runtime: ${fwd.note}`);
  lines.push(mcpMatches ? "mcp: already matches" : `mcp: registered '${SERVER_KEY}'`);
  lines.push(`skill: ${skillResult.detail}`);
  lines.push(`hooks: ${hookResult.detail}`);
  lines.push(`statusline: ${statuslineResult.detail}`);
  lines.push("restart Claude Code to activate");

  return {
    status: "installed",
    message: lines.join("\n  · "),
    configPath,
    backupPath: backupPath ?? statuslineResult.backupPath,
  };
}

async function claudeCodeUninstall(opts: { dryRun: boolean }): Promise<UninstallResult> {
  const configPath = CLAUDE_CODE_CONFIG;
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "error", message: read.error, configPath };

  const data = read.data;
  const servers = getServersBlock(data);
  const mcpPresent = !!(servers && SERVER_KEY in servers);

  // Skill is shared with Claude Desktop (~/.claude/skills/bastra-recall).
  // We don't remove it here — Claude Desktop might still need it. Once no
  // surface registration references it, cmdUninstall's final sweep removes
  // it (#181).
  const hookResult = await patchClaudeCodeHooks("uninstall", { dryRun: opts.dryRun });
  const statuslineResult = await patchClaudeCodeStatusline("uninstall", { dryRun: opts.dryRun, force: false });

  if (!mcpPresent && hookResult.status === "not-present" && statuslineResult.status === "not-present") {
    return { status: "not-present", message: "nothing to remove (skill: shared file — final sweep decides)", configPath };
  }

  if (opts.dryRun) {
    const steps: string[] = [];
    steps.push(mcpPresent ? `mcp: would remove '${SERVER_KEY}'` : "mcp: not present");
    steps.push(`hooks: ${hookResult.detail}`);
    steps.push(`statusline: ${statuslineResult.detail}`);
    steps.push("skill: shared file — final sweep decides");
    return { status: "would-remove", message: steps.join("\n  · "), configPath };
  }

  // Write MCP removal
  let backupPath: string | undefined;
  if (mcpPresent && servers) {
    backupPath = (await backupConfig(configPath)) ?? undefined;
    delete servers[SERVER_KEY];
    data.mcpServers = servers;
    await atomicWriteJson(configPath, data);
  }

  const lines: string[] = [];
  lines.push(mcpPresent ? `mcp: removed '${SERVER_KEY}'` : "mcp: not present");
  lines.push(`hooks: ${hookResult.detail}`);
  lines.push(`statusline: ${statuslineResult.detail}`);
  lines.push("skill: shared file — final sweep decides");
  lines.push("restart Claude Code to drop the connection");

  return {
    status: "removed",
    message: lines.join("\n  · "),
    configPath,
    backupPath: backupPath ?? statuslineResult.backupPath,
  };
}

async function claudeCodeDoctor(): Promise<DoctorResult> {
  const configPath = CLAUDE_CODE_CONFIG;
  const details: Record<string, string> = {};

  // MCP entry in ~/.claude.json
  const read = await readJsonConfig(configPath);
  if ("error" in read) return { status: "broken", message: read.error, details };
  details["claude-json"] = read.existed ? "present" : "missing";
  const servers = getServersBlock(read.data) ?? {};
  const registered = SERVER_KEY in servers;
  details["mcp-registration"] = registered ? "present" : "missing";

  let forwarderBroken = false;
  if (registered) {
    const block = servers[SERVER_KEY] as Record<string, unknown>;
    const args = Array.isArray(block?.args) ? block.args : [];
    const fwd = args[0];
    if (typeof fwd === "string") {
      const check = checkForwarderRegistration(fwd, await fileExists(fwd), "claude-code");
      details["forwarder-path"] = check.detail;
      forwarderBroken = check.broken;
    }
    const env = block?.env as Record<string, unknown> | undefined;
    const vault = env?.BASTRA_VAULT_PATH;
    if (typeof vault === "string") {
      details["vault-path"] = (await fileExists(vault)) ? `${vault} (exists)` : `${vault} (MISSING)`;
    }
  }

  // Skill
  details["skill"] = (await fileExists(SKILL_TARGET_FILE)) ? `present (${SKILL_TARGET_FILE})` : "missing";

  // Hooks. Stop is optional: some users intentionally disable autonomous
  // save-eval while keeping the rest of the reflex layer active.
  let requiredHooksMissing = false;
  let hookPathBroken = false;
  const settingsRead = await readJsonConfig(CLAUDE_CODE_SETTINGS);
  if ("error" in settingsRead) {
    details["hooks"] = `settings.json broken: ${settingsRead.error}`;
    requiredHooksMissing = true;
  } else {
    const hooks = (settingsRead.data.hooks && typeof settingsRead.data.hooks === "object")
      ? settingsRead.data.hooks as Record<string, unknown>
      : {};
    const found = registeredHookBins(hooks);
    const registeredCommands = registeredHookCommands(hooks);
    const requiredMissing = REQUIRED_HOOK_FILES.filter((f) => !found.has(f));
    const registrationMissing = missingRequiredHookRegistrations(hooks);
    const optionalMissing = OUR_HOOK_FILES
      .filter((f) => !REQUIRED_HOOK_FILES.includes(f))
      .filter((f) => !found.has(f));
    requiredHooksMissing = requiredMissing.length > 0 || registrationMissing.length > 0;
    details["hooks"] = requiredHooksMissing
      ? `${found.size}/${OUR_HOOK_FILES.length} lanes registered (missing required: ${[
          ...requiredMissing,
          ...registrationMissing,
        ].join(", ")})`
      : optionalMissing.length > 0
        ? `${found.size}/${OUR_HOOK_FILES.length} registered (optional disabled: ${optionalMissing.join(", ")})`
        : `${OUR_HOOK_FILES.length}/${OUR_HOOK_FILES.length} registered`;

    const hookPathProblems = await checkHookPaths(registeredCommands);
    hookPathBroken = hookPathProblems.length > 0;
    if (hookPathBroken) details["hook-paths"] = hookPathProblems.join("; ");

    // Statusline (optional/cosmetic — never marks the surface as broken).
    const sl = settingsRead.data.statusLine;
    details["statusline"] = sl === undefined || sl === null
      ? "missing (run 'bastra install' to add it)"
      : isOurStatusline(sl)
        ? "present (bastra)"
        : "present (foreign — run 'bastra install --yes' to replace it)";
  }

  // Daemon
  const probe = await probeDaemon();
  details["daemon-on-6723"] = probe.ok ? `reachable (${probe.detail})` : probe.detail;

  if (!registered) return { status: "missing", message: "MCP not registered with Claude Code", details };
  const broken =
    forwarderBroken ||
    details["vault-path"]?.includes("MISSING") === true ||
    requiredHooksMissing ||
    hookPathBroken ||
    details["skill"] === "missing";
  if (broken) return { status: "broken", message: "registered but some pieces need repair — re-run 'bastra install claude-code'", details };
  return { status: "ok", message: "MCP + skill + required hooks registered and healthy", details };
}

export const claudeCodeAdapter: Adapter = {
  surface: "claude-code",
  description: "Claude Code (MCP + Skill + Hooks)",
  configPath: CLAUDE_CODE_CONFIG,
  install: claudeCodeInstall,
  uninstall: claudeCodeUninstall,
  doctor: claudeCodeDoctor,
};
