/** Lexical boundary for application state; the root is configured locally,
 * while the candidate may contain a remote session ID. Normalize BEFORE the
 * separator-terminated prefix check so sibling prefixes and ../ cannot pass.
 * Keep this standard resolve/startsWith guard visible to CodeQL's path model. */
import * as path from "node:path";

export function resolveStatePath(root: string, candidate: string): string {
  const normalizedRoot = path.resolve(root);
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(prefix)) throw new Error("Path is outside the allowed state root");
  return resolved;
}
