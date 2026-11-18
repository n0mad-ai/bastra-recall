/**
 * #1637: the rule kernel for a Claude Code subagent at its start.
 *
 * The gate lane re-delivers the kernel after 25 tool calls per agent (#1305,
 * #1623); a short worker can finish before it gets there and never see a
 * rule. Claude Code's SubagentStart hook adds `additionalContext` to the
 * subagent's context before its first prompt
 * (code.claude.com/docs/en/hooks#subagentstart), so the worker gets the same
 * full kernel there.
 *
 * Deliberately nothing more: the answer carries only the kernel (no session
 * start extras, no task cards), writes no session state — no fingerprint, no
 * cadence change, no approval stage — and answers `{}` for a caller without
 * an `agent_id` or when the catalog is unavailable. The worker's own cadence
 * and the main agent's stay exactly as they were.
 *
 * Served on POST /hook/session, so the existing `session` client and stub
 * subcommand carry it without a new binary.
 */
import { hookAgent } from "./hook-surface.js";
import { renderRuleKernel } from "./rule-kernel.js";
import type { CatalogProvider } from "./rulebook-check.js";
import { withRulebookDeadline } from "./rulebook-catalog.js";
import { projectForLane } from "./scope-filter.js";
import { peekActiveConventions } from "./session-state.js";

export interface SubagentStartPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  agent_id?: unknown;
  agent_type?: unknown;
}

export async function runSubagentStartLane(payload: SubagentStartPayload, kernel?: CatalogProvider): Promise<string> {
  if (payload.hook_event_name !== "SubagentStart" || !kernel || hookAgent(payload) !== "subagent") return "{}";
  try {
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
    const active = await peekActiveConventions(sessionId);
    const project = projectForLane(typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd());
    const candidates = await withRulebookDeadline(() => kernel(active, project, "content"));
    const rendered = renderRuleKernel(candidates, { trigger: "subagent start" });
    if (rendered.text === "") return "{}";
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: rendered.text } });
  } catch {
    return "{}";
  }
}
