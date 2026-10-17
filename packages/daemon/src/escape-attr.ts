/**
 * Escapes a value for a double-quoted attribute in the tag wrappers the hooks
 * inject (`<recall-hints project="…">` and friends). Project names, file names,
 * ids and scopes come from outside; without this a `"` or `>` in one of them
 * closes the tag early and the rest reads as an instruction (#1232).
 */
export function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
