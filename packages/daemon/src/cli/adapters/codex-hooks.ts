/**
 * The Codex hook registration in ~/.codex/hooks.json: which lanes Bastra
 * registers, how its entries are recognized among foreign ones, the pure
 * install/uninstall merge plan, and the read-only checks doctor runs on what
 * is registered. Split out of codex.ts (#1532), which writes the plan and
 * re-exports the public functions.
 */
import { existsSync } from "node:fs";
import { codexGateSupported, CODEX_GATE_MIN_VERSION } from "../../codex-gate-capability.js";
import {
  BASH_FAIL_HOOK_BIN,
  BASH_PRE_HOOK_BIN,
  GATE_HOOK_BIN,
  HOOK_STUB_BIN,
  PRE_TOOL_HOOK_BIN,
  PROMPT_HOOK_BIN,
  SESSION_HOOK_BIN,
  STOP_HOOK_BIN,
  TODO_HOOK_BIN,
} from "../paths.js";
import {
  existingHookWrapper,
  hookCommandTokens,
  fileOf,
  lookalikeHookCommands,
  runsOurHookRunner,
  slashes,
  windowsHookToken,
  type HookWrapper,
} from "./command-paths.js";
import { CODEX_SAVE_NOTICE_MATCHER } from "../../save-notice-lane.js";

export type HookEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";

interface CodexHookDef {
  event: HookEvent;
  matcher?: string;
  bin: string;
  timeout: number;
  label: string;
  stubSubcommand: string;
}

const STOP_DEF: CodexHookDef = {
  event: "Stop",
  bin: STOP_HOOK_BIN,
  timeout: 3,
  label: "evaluating memory save",
  stubSubcommand: "stop",
};

export function codexHookDefinitions(includeStop: boolean, codexVersion?: string | null): CodexHookDef[] {
  const defs: CodexHookDef[] = [
    {
      event: "SessionStart",
      matcher: "startup|resume|clear|compact|fork",
      bin: SESSION_HOOK_BIN,
      timeout: 3,
      label: "loading context",
      stubSubcommand: "session",
    },
    {
      event: "UserPromptSubmit",
      bin: PROMPT_HOOK_BIN,
      timeout: 2,
      label: "recalling for prompt",
      stubSubcommand: "prompt",
    },
    {
      event: "PreToolUse",
      matcher: "^apply_patch$",
      bin: PRE_TOOL_HOOK_BIN,
      timeout: 2,
      label: "recalling for patch",
      stubSubcommand: "write",
    },
    {
      event: "PreToolUse",
      matcher: "^update_plan$",
      bin: TODO_HOOK_BIN,
      timeout: 2,
      label: "recalling for plan",
      stubSubcommand: "todo",
    },
    {
      event: "PreToolUse",
      matcher: "^Bash$",
      bin: BASH_PRE_HOOK_BIN,
      timeout: 2,
      label: "checking shell command",
      stubSubcommand: "bash-pre",
    },
    {
      event: "PostToolUse",
      matcher: "^Bash$",
      bin: BASH_FAIL_HOOK_BIN,
      timeout: 2,
      label: "learning from shell result",
      stubSubcommand: "bash-fail",
    },
    {
      event: "PostToolUse",
      matcher: CODEX_SAVE_NOTICE_MATCHER,
      bin: BASH_FAIL_HOOK_BIN,
      timeout: 2,
      label: "announcing saved memory",
      stubSubcommand: "bash-fail",
    },
  ];
  // Runtime evidence is an exact allowlist. Other/unknown versions keep
  // legacy context-only lanes, with neither a deny gate nor must-load claims.
  // Official catch-all matcher: https://learn.chatgpt.com/docs/hooks#matcher-patterns
  if (codexGateSupported(codexVersion))
    defs.push({
      event: "PreToolUse",
      matcher: "*",
      bin: GATE_HOOK_BIN,
      timeout: 2,
      label: "checking must-load and reflex rules",
      stubSubcommand: "gate",
    });
  if (includeStop) defs.push(STOP_DEF);
  return defs;
}

export const HOOK_EVENTS: HookEvent[] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
const OUR_HOOK_FILES = [
  "hook.js",
  "session-hook.js",
  "prompt-hook.js",
  "todo-hook.js",
  "bash-pre-hook.js",
  "bash-fail-hook.js",
  "stop-hook.js",
  "gate-hook.js",
];
export const REQUIRED_HOOK_FILES = OUR_HOOK_FILES.filter((file) => file !== "stop-hook.js" && file !== "gate-hook.js");

const CLIENT_MARKER = "BASTRA_HOOK_CLIENT=codex";

function shellToken(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** #647/#1304: remove only our unquoted assignments adjacent to the runner.
 * Marker text inside a wrapper's quoted label is user data, kept byte-for-byte. */
function withoutOurAssignments(wrapPrefix: string): string {
  let prefixEnd = wrapPrefix.length;
  for (const part of hookCommandTokens(wrapPrefix).reverse()) {
    if (
      wrapPrefix.slice(part.end, prefixEnd).trim() !== "" ||
      wrapPrefix.slice(part.start, part.end) !== part.value ||
      (part.value !== CLIENT_MARKER && !/^BASTRA_CODEX_VERSION=\d+\.\d+\.\d+$/.test(part.value))
    )
      break;
    prefixEnd = part.start;
  }
  return wrapPrefix.slice(0, prefixEnd);
}

function hookEntry(
  def: CodexHookDef,
  stubPresent = existsSync(HOOK_STUB_BIN),
  wrap: HookWrapper = { prefix: "", suffix: "" },
  platform: string = process.platform,
  codexVersion?: string | null
): Record<string, unknown> {
  const token = platform === "win32" ? windowsHookToken : shellToken;
  const runner = stubPresent ? `${token(HOOK_STUB_BIN)} ${def.stubSubcommand}` : `node ${token(def.bin)}`;
  const prefix = withoutOurAssignments(wrap.prefix);
  const version = codexGateSupported(codexVersion) ? codexVersion : null;
  const entry: Record<string, unknown> = {};
  if (def.matcher) entry.matcher = def.matcher;
  entry.hooks = [
    {
      type: "command",
      command:
        platform === "win32"
          ? `${prefix}${runner} --client=codex${version ? ` --codex-version=${version}` : ""}${wrap.suffix}`
          : `${prefix}${CLIENT_MARKER} ${version ? `BASTRA_CODEX_VERSION=${version} ` : ""}${runner}${wrap.suffix}`,
      timeout: def.timeout,
      statusMessage: `Bastra Recall · ${def.label}`,
    },
  ];
  return entry;
}

function isOurHandler(hook: unknown): boolean {
  if (!hook || typeof hook !== "object") return false;
  const record = hook as Record<string, unknown>;
  if (
    typeof record.statusMessage === "string" &&
    (record.statusMessage.startsWith("bastra-recall:") || record.statusMessage.startsWith("Bastra Recall ·"))
  )
    return true;
  const command = typeof record.command === "string" ? record.command : "";
  return command.includes(CLIENT_MARKER) && runsOurHookRunner(command, OUR_HOOK_FILES, CLIENT_MARKER);
}

function isOurHookEntry(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const hooks = (value as Record<string, unknown>).hooks;
  return Array.isArray(hooks) && hooks.some(isOurHandler);
}

function foreignRemainder(entry: unknown): unknown[] {
  const record = entry as Record<string, unknown>;
  const rest = (Array.isArray(record.hooks) ? record.hooks : []).filter((hook) => !isOurHandler(hook));
  return rest.length ? [{ ...record, hooks: rest }] : [];
}

// The recognition before #683 — only to name what is now left alone.
const lookedOurs = (command: string): boolean => command.includes(CLIENT_MARKER) && command.includes("bastra-hook");

export interface CodexHookPlan {
  before: Record<HookEvent, unknown[]>;
  after: Record<HookEvent, unknown[]>;
  stopPreserved: boolean;
  /** #683: commands the old substring recognition claimed; kept as they are. */
  leftAlone: string[];
}

/** Pure merge planner: foreign hook entries pass through byte-for-byte. */
export function planCodexHooks(
  action: "install" | "uninstall",
  hooks: Record<string, unknown>,
  opts: {
    includeStop: boolean;
    codexVersion?: string | null;
    mapBin?: (bin: string) => string;
    stubPresent?: boolean;
    platform?: string;
  }
): CodexHookPlan {
  const map = (def: CodexHookDef): CodexHookDef => (opts.mapBin ? { ...def, bin: opts.mapBin(def.bin) } : def);
  const defs = codexHookDefinitions(opts.includeStop, opts.codexVersion).map(map);
  const stopDef = map(STOP_DEF);
  const stubPresent = opts.stubPresent ?? existsSync(HOOK_STUB_BIN);
  // #647: what wraps our runner for this lane today, kept on the rebuilt entry.
  const wrapOf = (def: CodexHookDef): HookWrapper =>
    existingHookWrapper(
      Array.isArray(hooks[def.event]) ? (hooks[def.event] as unknown[]) : [],
      def.matcher,
      fileOf(def.bin),
      def.stubSubcommand,
      isOurHookEntry
    );
  const before = {} as Record<HookEvent, unknown[]>;
  const after = {} as Record<HookEvent, unknown[]>;
  let stopPreserved = false;

  for (const event of HOOK_EVENTS) {
    const current = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    before[event] = current;
    if (action === "install" && !opts.includeStop && event === "Stop") {
      stopPreserved = current.some(isOurHookEntry);
      after[event] = current.flatMap((entry) =>
        isOurHookEntry(entry)
          ? [
              hookEntry(stopDef, stubPresent, wrapOf(stopDef), opts.platform, opts.codexVersion),
              ...foreignRemainder(entry),
            ]
          : [entry]
      );
    } else {
      after[event] = current.flatMap((entry) => (isOurHookEntry(entry) ? foreignRemainder(entry) : [entry]));
    }
  }
  if (action === "install") {
    for (const def of defs)
      after[def.event].push(hookEntry(def, stubPresent, wrapOf(def), opts.platform, opts.codexVersion));
  }
  return {
    before,
    after,
    stopPreserved,
    leftAlone: lookalikeHookCommands(hooks, HOOK_EVENTS, isOurHookEntry, lookedOurs),
  };
}

/** Adds every Bastra hook runner file the command starts, by path or stub subcommand. */
function addHookFilesOf(command: string, found: Set<string>): void {
  for (const def of codexHookDefinitions(true, CODEX_GATE_MIN_VERSION)) {
    if (
      slashes(command).includes(`/${fileOf(def.bin)}`) ||
      (command.includes("bastra-hook") && command.includes(` ${def.stubSubcommand}`))
    ) {
      found.add(fileOf(def.bin));
    }
  }
}

export function registeredCodexHookFiles(hooks: Record<string, unknown>): Set<string> {
  const found = new Set<string>();
  for (const event of HOOK_EVENTS) {
    const entries = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    for (const entry of entries) {
      if (!isOurHookEntry(entry)) continue;
      const handlers = (entry as Record<string, unknown>).hooks;
      if (!Array.isArray(handlers)) continue;
      for (const handler of handlers) {
        const command =
          typeof (handler as Record<string, unknown>)?.command === "string"
            ? String((handler as Record<string, unknown>).command)
            : "";
        addHookFilesOf(command, found);
      }
    }
  }
  return found;
}

/** A shared runner file alone does not prove the write-tool matcher is installed. */
export function codexSaveNoticeRegistered(hooks: Record<string, unknown>): boolean {
  const entries = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
  return entries.some((entry) => {
    const group = entry as { matcher?: unknown; hooks?: unknown } | null;
    return (
      group?.matcher === CODEX_SAVE_NOTICE_MATCHER &&
      Array.isArray(group.hooks) &&
      group.hooks.some((handler) => {
        const hook = handler as { type?: unknown; command?: unknown } | null;
        return (
          hook?.type === "command" &&
          typeof hook.command === "string" &&
          runsOurHookRunner(hook.command, [fileOf(BASH_FAIL_HOOK_BIN)], CLIENT_MARKER, "bash-fail")
        );
      })
    );
  });
}

/** Verify the real catch-all runner and version evidence on the hint producers.
 * Trust is Codex-owned and cannot be inferred from registration. */
export function codexGateRegistered(hooks: Record<string, unknown>, version?: string | null): boolean {
  if (!codexGateSupported(version)) return false;
  return [
    ["PreToolUse", "*", "gate-hook.js", "gate"],
    ["SessionStart", "startup|resume|clear|compact|fork", "session-hook.js", "session"],
    ["UserPromptSubmit", undefined, "prompt-hook.js", "prompt"],
  ].every(([event, matcher, file, sub]) => {
    const entries = Array.isArray(hooks[event!]) ? (hooks[event!] as unknown[]) : [];
    return entries.some((entry) => {
      const group = entry as { matcher?: unknown; hooks?: unknown } | null;
      if (!group) return false;
      return (
        group.matcher === matcher &&
        Array.isArray(group.hooks) &&
        group.hooks.some((handler) => {
          const command = (handler as { command?: unknown } | null)?.command;
          if (typeof command !== "string") return false;
          const tokens = hookCommandTokens(command).map((token) => token.value);
          return (
            runsOurHookRunner(command, [file!], CLIENT_MARKER, sub) &&
            (tokens.includes(CLIENT_MARKER) || tokens.includes("--client=codex")) &&
            (tokens.includes(`BASTRA_CODEX_VERSION=${version}`) || tokens.includes(`--codex-version=${version}`))
          );
        })
      );
    });
  });
}

/** Doctor's read-only policy includes stale hint markers: an old producer can
 * still promise must-load even if someone already removed its gate entry. */
export function inspectCodexGateRegistration(
  hooks: Record<string, unknown>,
  version?: string | null
): {
  registered: boolean;
  stale: boolean;
  broken: boolean;
} {
  const eligible = codexGateSupported(version);
  const registered = codexGateRegistered(hooks, version);
  const hasVersionMarker = HOOK_EVENTS.some((event) => {
    const entries = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    return entries.some(
      (entry) =>
        isOurHookEntry(entry) &&
        (entry as { hooks: unknown[] }).hooks.some((handler) => {
          const command = (handler as { command?: unknown } | null)?.command;
          return (
            typeof command === "string" &&
            hookCommandTokens(command).some((token) => /^(?:BASTRA_CODEX_VERSION=|--codex-version=)/.test(token.value))
          );
        })
    );
  });
  const stale = !eligible && (registeredCodexHookFiles(hooks).has("gate-hook.js") || hasVersionMarker);
  return { registered, stale, broken: eligible ? !registered : stale };
}
