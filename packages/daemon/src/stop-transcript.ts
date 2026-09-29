/**
 * Stop lane — reading the session transcript (split out of stop-lane.ts,
 * #680): the Stop payload shape, loading the transcript from the payload or
 * its file, and normalising Claude/Codex rows into turns with the commands,
 * reads and tool names the heuristics consume.
 */
import { open } from "node:fs/promises";
// #305: the scrub leaf, never the core barrel — the barrel costs +40ms of
// process start for a function that lives in a dependency-free module.
import { scrubInjectedBlocks } from "@bastra-recall/core/scrub";
import { isSystemInjectedTurn } from "./system-turn.js";
import type { ProvenRead } from "./code-graph/boundary-block.js";
import {
  claudeToolUseCommands,
  claudeToolUseNames,
  claudeToolUseReads,
  codexCustomExecCommands,
  codexFunctionCallCommands,
} from "./stop-lane-command-input.js";

export interface ClaudeStopPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  transcript_path?: string;
  transcript?: unknown;
  stop_hook_active?: boolean;
}

export interface TranscriptTurn {
  role: "user" | "assistant" | "system" | string;
  content: string;
  /** Shell commands the agent ran from this turn (tool_use input.command /
   *  Codex function_call arguments). Kept apart from `content` so prose that
   *  merely TALKS about a command never counts as running it. */
  commands?: string[];
  /** #572: files the agent read from this turn (Claude `Read`), with the row's time. */
  reads?: ProvenRead[];
  /** #675: tool names the turn called — the after-session harvest skips what was saved. */
  tools?: string[];
}

export async function loadTranscript(payload: ClaudeStopPayload): Promise<TranscriptTurn[]> {
  if (Array.isArray(payload.transcript)) {
    return normalizeTurns(payload.transcript as unknown[]);
  }
  if (typeof payload.transcript_path === "string") {
    try {
      // transcript_path kommt aus dem Hook-Payload (untrusted): nur echte
      // Transcript-Dateien lesen (.jsonl/.json) und eine Größenschranke
      // ziehen — sonst wird der Hook zum Arbitrary-File-Read / Memory-DoS.
      // Einmal öffnen und fstat auf dem Handle: kein TOCTOU-Fenster zwischen
      // Check und Read.
      if (!/\.jsonl?$/.test(payload.transcript_path)) return [];
      const fh = await open(payload.transcript_path, "r");
      try {
        const st = await fh.stat();
        if (!st.isFile() || st.size > MAX_TRANSCRIPT_BYTES) return [];
        const content = await fh.readFile({ encoding: "utf8" });
        return parseTranscriptFile(content);
      } finally {
        await fh.close();
      }
    } catch {
      return [];
    }
  }
  return [];
}

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024; // 64 MiB — weit über realen Transcripts

export function parseTranscriptFile(raw: string): TranscriptTurn[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as unknown[];
      return normalizeTurns(arr);
    } catch {
      return [];
    }
  }
  const out: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // skip
    }
  }
  return normalizeTurns(out);
}

// In Claude-Code transcripts a tool result is stored as a `role: "user"`
// message whose content is an array of `tool_result` blocks (bash/tool output).
// That is NOT human prose — the frustration / decision heuristics must not scan
// it. We reclassify such turns to role "tool" so only genuine typed user
// messages keep role "user". Feature-completion still scans every turn's text.
function isToolResultContent(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "tool_result",
    )
  );
}

/**
 * System-injizierte Turns, die im Transcript als role "user" auftauchen, aber
 * keine getippte Prosa sind. Der Skill-Body (Prefix "Base directory for this
 * skill:") dokumentiert die Frust-Trigger SELBST — ohne diesen Ausschluss
 * triggert jede Session, die den bastra-Skill lädt, die frustration-Heuristik
 * auf der eigenen Doku (der zweite strukturelle Defekt hinter #48).
 */
function isInjectedSystemContent(text: string): boolean {
  const head = text.trimStart();
  return (
    head.startsWith("Base directory for this skill:") ||
    head.startsWith("<system-reminder>") ||
    head.startsWith("<command-name>") ||
    head.startsWith("<local-command-caveat>") ||
    // Task notifications and agent mail (#639, #649): the body is another
    // agent's prose, so the decision and frustration heuristics would read it
    // as the user's. Shared with the prompt lane (#703).
    isSystemInjectedTurn(head)
  );
}

function effectiveRole(role: string, content: unknown): string {
  if (role === "user" && isToolResultContent(content)) return "tool";
  if (role === "user" && isInjectedSystemContent(stringifyContent(content))) return "system-injected";
  return role;
}

export function normalizeTurns(items: unknown[]): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    // Codex rollout JSONL wraps conversation messages as
    // `{type:"response_item", payload:{type:"message", role, content}}`.
    // Upstream documents this file format as unstable, so this parser remains
    // additive and the older Claude/direct shapes below stay intact (#15).
    const payload = obj.payload;
    if (obj.type === "response_item" && payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      if (p.type === "message" && typeof p.role === "string") {
        out.push({
          role: effectiveRole(p.role, p.content),
          content: scrubTurnContent(stringifyContent(p.content)),
        });
        continue;
      }
      // Codex: `{type:"function_call", name:"shell", arguments:"{\"command\":[…]}"}`.
      // A separate item, not part of an assistant message — attach it to the
      // preceding assistant turn so it neither inflates the turn window nor
      // feeds file-token scanning.
      if (p.type === "function_call") {
        attachCommands(out, codexFunctionCallCommands(p));
        if (typeof p.name === "string") attachTools(out, [p.name]);
        continue;
      }
      // Current Codex desktop rollouts use a free-form `custom_tool_call`
      // named `exec`; the input is JavaScript which calls tools.exec_command
      // with a `cmd` property. Keep this additive because the rollout format
      // is explicitly unstable and older function_call rows still exist.
      if (p.type === "custom_tool_call") {
        attachCommands(out, codexCustomExecCommands(p));
        continue;
      }
    }
    const directRole = obj.role;
    const directContent = obj.content;
    if (typeof directRole === "string") {
      out.push({ role: effectiveRole(directRole, directContent), content: scrubTurnContent(stringifyContent(directContent)) });
      continue;
    }
    const msg = obj.message;
    if (msg && typeof msg === "object") {
      const m = msg as Record<string, unknown>;
      const role = typeof m.role === "string" ? m.role : "unknown";
      const turn: TranscriptTurn = { role: effectiveRole(role, m.content), content: scrubTurnContent(stringifyContent(m.content)) };
      const commands = claudeToolUseCommands(m.content);
      if (commands.length > 0) turn.commands = commands;
      const tools = claudeToolUseNames(m.content);
      if (tools.length > 0) turn.tools = tools;
      const reads = claudeToolUseReads(m.content);
      if (reads.length > 0) {
        // A row without a parseable timestamp cannot be placed after an edit,
        // and an unplaced read is not counted (`boundary-block.ts`).
        const at = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : Number.NaN;
        turn.reads = reads.map((path) => ({ path, at: Number.isNaN(at) ? null : at }));
      }
      out.push(turn);
      continue;
    }
    if (typeof obj.text === "string") {
      out.push({ role: "unknown", content: scrubTurnContent(obj.text) });
    }
  }
  return out;
}

function attachTools(out: TranscriptTurn[], tools: string[]): void {
  const last = out[out.length - 1];
  if (last && last.role === "assistant") last.tools = [...(last.tools ?? []), ...tools];
  else out.push({ role: "assistant", content: "", tools });
}

function attachCommands(out: TranscriptTurn[], commands: string[]): void {
  if (commands.length === 0) return;
  const last = out[out.length - 1];
  if (last && last.role === "assistant") {
    last.commands = [...(last.commands ?? []), ...commands];
  } else {
    out.push({ role: "assistant", content: "", commands });
  }
}

// #149: our own hook injections (<recall-hints>, <session-context>, …) quote
// file paths and trigger vocabulary. Embedded mid-turn they survive the
// prefix-based role reclassification above, and detectFeatureCompletion scans
// EVERY role's text for file tokens — so recalled context could count toward
// its own re-capture. Scrub complete blocks AFTER role classification (the
// prefix match in effectiveRole needs the raw text) so every heuristic sees
// clean prose.
function scrubTurnContent(text: string): string {
  return scrubInjectedBlocks(text).text;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (typeof c === "string") parts.push(c);
      else if (c && typeof c === "object") {
        const obj = c as Record<string, unknown>;
        if (typeof obj.text === "string") parts.push(obj.text);
        else if (typeof obj.content === "string") parts.push(obj.content);
      }
    }
    return parts.join("\n");
  }
  if (content && typeof content === "object") {
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  return "";
}
