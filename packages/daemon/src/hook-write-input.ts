/**
 * Cross-client write-input normalization (#15).
 *
 * Claude Code names a single target in `tool_input.file_path`; Codex sends an
 * apply_patch document in `tool_input.command`. The recall lane needs a stable
 * representative path for its cheap skip gate, project/file-size checks and
 * topic extraction, while retaining the complete patch as recall evidence.
 */

const PATCH_PATH = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

export function applyPatchPaths(command: unknown): string[] {
  if (typeof command !== "string") return [];
  const paths: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = PATCH_PATH.exec(command)) !== null) {
    const path = (match[1] ?? "").trim();
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

export interface WritePayloadShape {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/** Return a normalized clone; null means the tool has no usable target. */
export function normalizeWritePayload<T extends WritePayloadShape>(payload: T): T | null {
  if (payload.tool_name === "NotebookEdit") {
    // #572: NotebookEdit names its target `notebook_path`, and the write lane
    // reads `file_path` — so the lane returned on its first line and the
    // notebook was never booked. Silent, because a file that was never booked
    // renders at the task boundary exactly like a file nothing depends on.
    const input = payload.tool_input ?? {};
    if (typeof input.file_path === "string" && input.file_path) return payload;
    const path = input.notebook_path;
    if (typeof path !== "string" || !path) return null;
    return { ...payload, tool_input: { ...input, file_path: path } };
  }
  if (payload.tool_name !== "apply_patch") return payload;
  const input = payload.tool_input ?? {};
  const paths = applyPatchPaths(input.command);
  if (paths.length === 0) return null;
  return {
    ...payload,
    tool_input: { ...input, file_path: paths[0], file_paths: paths },
  };
}
