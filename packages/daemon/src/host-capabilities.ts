/** Evidence ledger (#1312), not a host detector or an enforcement switch.
 * `status` describes the host boundary; `bastra` describes the shipped path.
 * No Stop capability promises that text is hidden before it is displayed.
 * Sources checked 2026-10-29. A missing minimum is deliberately not a guess.
 */
import { CODEX_GATE_MIN_VERSION, codexGateSupported } from "./codex-gate-capability.js";

export type CapabilityStatus = "supported" | "unsupported" | "preparation-only" | "unverified";
export const CAPABILITY_KEYS = ["prompt_hook", "pre_tool_deny", "stop_additional_context", "stop_block", "session_fork", "must_load_gate", "rule_kernel", "validate_artifact_tool"] as const;
export type CapabilityKey = typeof CAPABILITY_KEYS[number];
export interface Capability {
  status: CapabilityStatus;
  bastra: CapabilityStatus;
  sources: readonly string[];
  note: string;
}
export interface ToolCoverage {
  runtimeVerified: readonly string[];
  documentedOnly: readonly string[];
  exceptions: readonly string[];
  sources: readonly string[];
}
export interface HostCapabilities {
  surface: "claude-code" | "codex" | "cursor" | "claude-desktop" | "replay" | "remote-mcp";
  installable: boolean;
  runtime: { scope: string; verifiedVersion?: string; minimumVersion?: string };
  capabilities: Record<CapabilityKey, Capability>;
  pre_tool_coverage: ToolCoverage;
  prerequisites: readonly string[];
}
const issue = (n: number) => `https://github.com/n0mad-ai/bastra-recall/issues/${n}`;
const claude = "https://code.claude.com/docs/en/hooks";
const codex = "https://learn.chatgpt.com/docs/hooks";
const spike = `${issue(1300)}#issuecomment-6497445090`;
const source = (file: string) => `https://github.com/n0mad-ai/bastra-recall/blob/main/${file}`;
const cap = (status: CapabilityStatus, sources: string[], note: string, bastra = status): Capability => ({ status, bastra, sources, note });
const validate = cap("supported", [issue(1309), source("packages/daemon/src/tool-defs.ts")], "Requires connected Recall MCP with write/full tool surface; unavailable with search-only or no MCP. This is a tool, not automatic host validation.");
const emptyCoverage: ToolCoverage = { runtimeVerified: [], documentedOnly: [], exceptions: ["No Bastra lifecycle hook registration on this surface."], sources: [issue(1312)] };
const toolPrerequisites = ["validate_artifact requires connected Recall MCP and BASTRA_TOOL_SURFACE=write or full; a HostContext without these does not have the tool."];

const claudeCode: HostCapabilities = {
  surface: "claude-code", installable: true,
  runtime: { scope: "Current documented hooks and shipped adapter; minimum runtime not established." },
  capabilities: {
    prompt_hook: cap("supported", [claude], "UserPromptSubmit command hook; not the LLM prompt handler type."),
    pre_tool_deny: cap("supported", [claude, issue(1303)], "PreToolUse deny on hook-covered calls; Bastra catch-all gate is one-time and fail-open."),
    stop_additional_context: cap("supported", [claude, source("packages/daemon/src/stop-lane.ts"), issue(1311)], "Bastra same-turn save-eval delivery and the bounded approved-copy repair (two requests per task, then non-conformance) are conditional on session state and Stop registration."),
    stop_block: cap("supported", [claude, issue(1311)], "Host can continue after Stop; Bastra's approved-copy repair uses additionalContext and never a block decision. No before-display guarantee.", "unsupported"),
    session_fork: cap("supported", [claude, issue(1303)], "Fork source registered in SessionStart; no minimum runtime established."),
    must_load_gate: cap("supported", [issue(1303)], "One persisted deny claim, then retry passes; never permanent blocking until load."),
    rule_kernel: cap("supported", [issue(1305)], "Compact/clear/fork recovery; bounded full bodies or explicit degraded load instruction. No kernel on resume."),
    validate_artifact_tool: validate,
  },
  pre_tool_coverage: { runtimeVerified: [], documentedOnly: ["PreToolUse-covered local tools", "MCP tools"], exceptions: ["EndConversation skips PreToolUse (current host docs).", "Recall MCP tools and Bastra ToolSearch are intentionally exempt from Bastra gate denial.", "Host documentation and lane tests do not certify every tool/runtime combination."], sources: [claude, issue(1303)] },
  prerequisites: ["Installed and enabled Bastra hooks; optional Stop registration for Stop delivery.", ...toolPrerequisites],
};

function codexRow(verified: boolean, eligible: boolean): HostCapabilities {
  return {
    surface: "codex", installable: true,
    runtime: { scope: verified ? "CLI 0.162.1 runtime probe; IDE/Desktop not runtime-certified." : "Untested, older, unknown or malformed runtime; no deny certification.", ...(verified ? { verifiedVersion: CODEX_GATE_MIN_VERSION } : {}), minimumVersion: CODEX_GATE_MIN_VERSION },
    capabilities: {
      prompt_hook: cap(verified ? "supported" : "unverified", [codex], "Current docs describe UserPromptSubmit, not a version-pinned contract for unknown/other runtimes. Bastra registers the command hook; trust is required. Not an LLM prompt handler.", "supported"),
      pre_tool_deny: cap(verified ? "supported" : "unverified", [spike, `${codex}#tool-coverage`], "Only CLI 0.162.1 was runtime-probed. apply_patch/MCP support is documentation-only; no universal enforcement claim.", verified ? "supported" : "preparation-only"),
      stop_additional_context: cap("unverified", [codex, source("packages/daemon/src/stop-lane.ts"), issue(1311)], "Current docs do not establish Stop additionalContext delivery; absence is not proof of host rejection. Bastra explicitly skips Codex same-turn save-eval delivery and queues pending context; the approved-copy Stop repair is not offered on Codex.", "unsupported"),
      stop_block: cap(verified ? "supported" : "unverified", [`${codex}#stop`], "Current docs describe a block creating a continuation prompt; this was not runtime-probed and does not certify other/unknown versions. Bastra has no Stop repair block and offers no approved-copy Stop repair on Codex (#1311). No before-display guarantee.", "unsupported"),
      session_fork: cap(verified ? "supported" : "unverified", [spike, issue(1304)], "Runtime-confirmed source=fork only on CLI 0.162.1; adapter registers the benign fork matcher on every version, without certifying that the host emits it.", "supported"),
      must_load_gate: cap(verified ? "supported" : "preparation-only", [issue(1304), spike], eligible ? "Verified runtime matched; registration enabled. Later versions require a new probe." : "No gate registered for other, unknown, malformed or prerelease versions; preparation hints only."),
      rule_kernel: cap(verified ? "supported" : "unverified", [issue(1305), issue(1304)], "Shared session lane renders compact/clear/fork recovery; this does not certify host delivery on other/unknown runtimes. The fork matcher is registered on all versions; interval re-delivery requires the eligible gate.", eligible ? "supported" : "preparation-only"),
      validate_artifact_tool: validate,
    },
    pre_tool_coverage: {
      runtimeVerified: verified ? ["exec_command (hook name Bash)", "view_image"] : [],
      documentedOnly: ["apply_patch (aliases Edit/Write)", "MCP tools", "other local function tools"],
      exceptions: ["write_stdin has no fresh PreToolUse boundary for an existing process; completion can emit the original Bash PostToolUse.", "Hosted WebSearch is documented unsupported and was not runtime-tested.", "Recall MCP tools and Bastra ToolSearch are intentionally exempt from Bastra gate denial."],
      sources: [spike, `${codex}#tool-coverage`, issue(1303)],
    },
    prerequisites: ["Project layer trusted; review/re-trust the exact changed hook definition via /hooks; installed and enabled hooks required.", "Only CLI 0.162.1 is eligible for gate registration. The minimum records the smallest verified version, not a supported range or IDE/Desktop certification.", ...toolPrerequisites],
  };
}
function hookless(surface: "cursor" | "claude-desktop" | "remote-mcp"): HostCapabilities {
  const adapter = surface === "remote-mcp" ? "docs/REMOTE-ACCESS.md" : `packages/daemon/src/cli/adapters/${surface}.ts`;
  const unavailable = cap("unverified", [issue(1312), source(adapter)], "Native host capability not established by these sources. The shipped Bastra adapter has no lifecycle hook path; MCP guidance is preparation, not host enforcement.", "unsupported");
  return {
    surface, installable: surface !== "remote-mcp", runtime: { scope: surface === "remote-mcp" ? "ChatGPT web/iPhone remote MCP; no host runtime minimum established." : "Shipped MCP adapter; no host runtime minimum established." },
    capabilities: { prompt_hook: unavailable, pre_tool_deny: unavailable, stop_additional_context: unavailable, stop_block: unavailable, session_fork: cap("unverified", [issue(1312)], "Host fork behavior not established; no Bastra fork hook registered.", "unsupported"), must_load_gate: unavailable, rule_kernel: cap("unverified", [source(adapter)], "Native recovery capability not established. Bastra memory guidance/first-call context does not establish compact/clear/fork rule-kernel recovery.", "preparation-only"), validate_artifact_tool: validate },
    pre_tool_coverage: emptyCoverage, prerequisites: toolPrerequisites,
  };
}
const replay: HostCapabilities = {
  surface: "replay", installable: false, runtime: { scope: "Deterministic test harness; no live host runtime." },
  capabilities: Object.fromEntries(CAPABILITY_KEYS.map(key => [key, cap("preparation-only", [issue(1302), issue(1303), issue(1305), issue(1309)], "Replay simulates lane behavior; it cannot certify a live host capability.")])) as Record<CapabilityKey, Capability>,
  pre_tool_coverage: { ...emptyCoverage, exceptions: ["Synthetic tool inputs only; no live tool enforcement."] }, prerequisites: ["Test fixture and simulated host inputs; no live host guarantee."],
};

/** Representative evidence rows; select with hostCapabilities for a runtime. */
export const HOST_CAPABILITIES: readonly HostCapabilities[] = [claudeCode, codexRow(true, true), codexRow(false, false), hookless("cursor"), hookless("claude-desktop"), replay, hookless("remote-mcp")];
export function hostCapabilities(surface: HostCapabilities["surface"], version?: string | null): HostCapabilities {
  if (surface === "codex") return codexRow(version === CODEX_GATE_MIN_VERSION, codexGateSupported(version));
  return HOST_CAPABILITIES.find(row => row.surface === surface)!;
}
