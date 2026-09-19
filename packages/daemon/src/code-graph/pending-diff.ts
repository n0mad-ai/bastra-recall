/**
 * The diff of a change that has not happened yet (#606).
 *
 * WHY THIS EXISTS. `find_affected_files` narrows the blast radius to the
 * symbols a diff touches, and reads that diff from git — which only works
 * AFTER the edit. The Write/Edit lane runs BEFORE it, and the one thing it has
 * that git does not is the edit itself: `old_string`/`new_string` for an Edit,
 * the whole `content` for a Write, the patch document for an apply_patch. This
 * module turns that tool input into the same unified diff `affected.ts`
 * already knows how to read, so the lane gets the symbol-level answer instead
 * of the file-level one it delivered until now.
 *
 * WHY A TRIMMED REPLACEMENT AND NOT A REAL DIFF ALGORITHM. A Write hands over
 * the whole new file, and the honest question is which LINES of it differ from
 * the working tree. A full LCS would answer that exactly; trimming the common
 * prefix and the common suffix and calling the rest one replacement hunk
 * answers it conservatively — the selection can only ever be WIDER than the
 * true one, never narrower. Wider costs precision (one candidate too many is a
 * file the agent opens and closes); narrower costs recall (a missing dependent
 * is a mistake the agent cannot see). That is the same trade `affected.ts`
 * makes at every other fork, and it buys a bounded, allocation-cheap pass
 * instead of an O(n·m) matrix inside a hook budget.
 *
 * APPLY_PATCH IS NOT A UNIFIED DIFF. Codex' patch document carries `@@`
 * markers that name a context, not line numbers, so nothing here can place its
 * lines in the working tree without applying the patch first. It is therefore
 * NOT converted: `applyPatchBody` returns the changed lines alone, and the
 * caller runs the name lane over them. A patch whose lines name no known
 * symbol falls back to the whole file, which is what an unplaceable hunk does
 * in `affected.ts` too.
 */

/** Largest file this reads or rewrites. Bigger is not a hand-written module. */
export const MAX_DIFF_SOURCE_BYTES = 2 * 1024 * 1024;

/**
 * The text `file` would hold after the pending call, or null when this module
 * cannot say — an unsupported tool, a missing field, an `old_string` that does
 * not occur in the current text (the edit would fail anyway).
 *
 * `current` is the working-tree text, "" for a file that does not exist yet.
 */
export function pendingText(
  toolName: string,
  toolInput: Record<string, unknown>,
  current: string,
): string | null {
  if (toolName === "Write") {
    return typeof toolInput.content === "string" ? toolInput.content : null;
  }
  if (toolName === "Edit") {
    return applyEdit(current, toolInput);
  }
  if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
    let text = current;
    for (const raw of toolInput.edits) {
      const next = applyEdit(text, (raw ?? {}) as Record<string, unknown>);
      if (next === null) return null;
      text = next;
    }
    return text;
  }
  return null;
}

/** One `{ old_string, new_string, replace_all }` applied, or null if it misses. */
function applyEdit(text: string, edit: Record<string, unknown>): string | null {
  const from = edit.old_string;
  const to = edit.new_string;
  if (typeof from !== "string" || typeof to !== "string") return null;
  // An empty `old_string` is Claude Code's "create this file" form; the new
  // text is simply the whole content.
  if (from === "") return to;
  if (!text.includes(from)) return null;
  return edit.replace_all === true ? text.split(from).join(to) : text.replace(from, to);
}

/**
 * A unified diff from `oldText` to `newText`, or null when they are equal.
 *
 * `-U0`, one hunk, the shape `changedLines` in `affected.ts` parses: the
 * common prefix and suffix are trimmed off and everything between them is one
 * replacement. The `a/`…`b/` headers are written without a `diff --git` line,
 * which is the form that module reads as "this hunk belongs to `file`".
 */
export function unifiedDiff(file: string, oldText: string, newText: string): string | null {
  if (oldText === newText) return null;
  const a = oldText.split("\n");
  const b = newText.split("\n");

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const removed = a.slice(prefix, a.length - suffix);
  const added = b.slice(prefix, b.length - suffix);
  if (removed.length === 0 && added.length === 0) return null;

  // `-p,0` / `+p,0` is git's way of saying "between line p and p+1", so a run
  // with no lines of its own names the line BEFORE it, not the first line it
  // would have covered. `affected.ts` reads both forms; writing the wrong one
  // shifts every line of the hunk by one.
  const oldStart = removed.length === 0 ? prefix : prefix + 1;
  const newStart = added.length === 0 ? prefix : prefix + 1;

  const lines = [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${oldStart},${removed.length} +${newStart},${added.length} @@`,
  ];
  for (const line of removed) lines.push(`-${line}`);
  for (const line of added) lines.push(`+${line}`);
  return lines.join("\n");
}

/** `*** Add File: x` / `*** Update File: x` / `*** Delete File: x`. */
const PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;

/**
 * The added and removed lines an apply_patch document holds for one file, or
 * null when the document does not touch it.
 *
 * Content only — the `@@` context markers and the `*** …` envelope are
 * dropped, because the caller reads this as text to look symbol names up in,
 * not as something with line numbers. A `---`/`+++` line inside the patch body
 * is content here for the same reason it is in `affected.ts`: this document has
 * no file headers of its own to confuse it with.
 */
export function applyPatchBody(command: unknown, file: string): string | null {
  if (typeof command !== "string") return null;
  const wanted = file.replace(/\\/g, "/").replace(/^\.\//, "");
  const out: string[] = [];
  let inFile = false;
  let sawFile = false;
  for (const raw of command.split("\n")) {
    const header = PATCH_FILE_HEADER.exec(raw);
    if (header !== null) {
      const named = (header[1] ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
      inFile = named === wanted || named.endsWith(`/${wanted}`) || wanted.endsWith(`/${named}`);
      if (inFile) sawFile = true;
      continue;
    }
    if (raw.startsWith("*** ")) {
      inFile = false;
      continue;
    }
    if (!inFile) continue;
    if (raw.startsWith("+") || raw.startsWith("-")) out.push(raw);
  }
  return sawFile ? out.join("\n") : null;
}
