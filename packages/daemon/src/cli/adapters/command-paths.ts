/** Path matching for registered hook commands, shared by the Claude Code and Codex adapters. */

/**
 * Hook commands are matched on forward slashes. The installer writes whatever
 * the platform's `path.resolve` produces, so on Windows a registered command is
 * `node C:\Users\…\daemon\dist\session-hook.js` — and every `/${file}` match in
 * the adapters read that as "not registered": doctor reported a fresh, working install
 * as `broken — 0/7 hooks`, and the #321 path check never ran there. Normalising
 * only for the comparison keeps the returned paths native.
 */
export function slashes(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Last path segment under either separator (`C:\…\hook.js` → `hook.js`). */
export function fileOf(p: string): string {
  return slashes(p).split("/").pop() ?? "";
}
