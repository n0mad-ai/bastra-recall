/**
 * The lowest Node.js release bastra-recall supports.
 *
 * One value for the whole project: `engines.node` in every package.json, the
 * Claude Desktop extension's `compatibility.runtimes.node` and the docs state
 * the same floor, and `tools/__tests__/support-matrix.test.mjs` fails when one
 * of them drifts. Node 22 is no longer supported (Daniel, 17.11.2026).
 */
import { compareVersions } from "./update-check.js";

export const MIN_NODE_VERSION = "24.16.0";

/** Why this Node.js cannot run bastra-recall, as one user-facing clause, or
 *  null when it is new enough. */
export function unsupportedNode(version: string = process.versions.node): string | null {
  if (compareVersions(version, MIN_NODE_VERSION) >= 0) return null;
  return `this is Node.js ${version.replace(/^v/, "")}; bastra-recall needs Node.js ${MIN_NODE_VERSION} or newer (check with 'node --version')`;
}

/**
 * Every `bastra` command says so on stderr, once, before it runs. Only a
 * warning: an installation that an older updater already moved onto this Node
 * keeps working until the user updates Node. `bastra update` refuses on its
 * own (see cmdUpdate) and is skipped here so the reason is not printed twice.
 */
export function warnOnUnsupportedNode(command: string | null | undefined, version?: string): void {
  const reason = command === "update" ? null : unsupportedNode(version);
  if (reason) process.stderr.write(`warning: ${reason}. Update Node.js; older versions are not supported.\n`);
}
