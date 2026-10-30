import { shellIsReadOnly } from "./github-shell-actions.js";
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch", "view_image", "search_query", "read_file", "list_directory"]);
const BASTRA_READ = new Set(["recall", "load_memory", "list_rules", "rulebook_check", "find_document", "read_document", "find_code", "find_affected_files", "validate_artifact", "task_get", "task_list", "task_status", "task_controls"]);
export function bastraReadTool(name: string): boolean {
  if (BASTRA_READ.has(name)) return true;
  const match = /^(?:mcp__(?:plugin_.+_)?bastra[-_]recall__|mcp__codex_apps__bastra_recall_)(.+)$/.exec(name);
  return !!match && BASTRA_READ.has(match[1]);
}
export async function rulebookMutates(name: string, input: Record<string, unknown>): Promise<boolean> {
  if (READ_TOOLS.has(name) || bastraReadTool(name)) return false;
  if (name === "ToolSearch") return false;
  if (name === "Bash" || name === "exec_command") {
    const command = input.command ?? input.cmd;
    return typeof command !== "string" || !await shellIsReadOnly(command);
  }
  return true; // No semantics inferred from truncated inputs or opaque actions.
}
