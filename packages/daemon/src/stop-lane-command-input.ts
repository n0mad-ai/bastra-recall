/**
 * Shell-command extraction from assistant transcript rows.
 *
 * Claude and Codex record tool calls in different, evolving shapes. Keep the
 * shape-specific parsing out of the stop-lane heuristics: they only consume
 * commands that an agent actually submitted, never assistant prose.
 */

/** Claude Code: tool_use blocks live inside assistant message content. */
export function claudeToolUseCommands(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const block = c as Record<string, unknown>;
    if (block.type !== "tool_use" || !block.input || typeof block.input !== "object") continue;
    const command = (block.input as Record<string, unknown>).command;
    if (typeof command === "string" && command.trim()) out.push(command);
  }
  return out;
}

/** Older Codex: function_call arguments are JSON with command or cmd. */
export function codexFunctionCallCommands(payload: Record<string, unknown>): string[] {
  if (typeof payload.arguments !== "string") return [];
  try {
    const args = JSON.parse(payload.arguments) as Record<string, unknown>;
    const command = args.command ?? args.cmd;
    if (typeof command === "string" && command.trim()) return [command];
    if (Array.isArray(command)) return [command.filter((part) => typeof part === "string").join(" ")];
  } catch {
    // Malformed or non-JSON tool input is not a shell command.
  }
  return [];
}

/**
 * Current Codex desktop: an executed custom exec call contains JavaScript such
 * as `await tools.exec_command({ cmd: "git commit ..." })`.
 *
 * Extract only literal cmd/command properties from an actual exec_command
 * invocation. Arbitrary custom-tool input that merely mentions git commit
 * must not become an execution signal.
 */
export function codexCustomExecCommands(payload: Record<string, unknown>): string[] {
  if (payload.name !== "exec" || typeof payload.input !== "string") return [];
  if (!/\btools\.exec_command\s*\(/.test(payload.input)) return [];
  return [
    ...jsStringPropertyValues(payload.input, "cmd"),
    ...jsStringPropertyValues(payload.input, "command"),
  ];
}

function jsStringPropertyValues(source: string, property: string): string[] {
  const out: string[] = [];
  const patterns = [
    new RegExp(`\\b${property}\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "g"),
    new RegExp(`\\b${property}\\s*:\\s*'((?:\\\\.|[^'\\\\])*)'`, "g"),
    new RegExp(`\\b${property}\\s*:\\s*\u0060((?:\\\\.|[^\u0060\\\\])*)\u0060`, "g"),
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) out.push(match[1]);
  }
  return out;
}
