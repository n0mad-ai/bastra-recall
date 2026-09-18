/**
 * Which workspace package a bare import specifier means (#582).
 *
 * WHY THIS IS NEEDED AT ALL. Measured on the 44 scenario graphs of the
 * code-roi v3 sample: a daemon file that writes
 *
 *   import { auditedSave } from "@bastra-recall/core";
 *
 * does NOT get an edge to `packages/core/src/audit-save.ts`. Graphify emits a
 * node it marks `"external": true` with an EMPTY `source_file`, id
 * `ref_bastra_recall_core` (and `ref_bastra_recall_core_scope` for the
 * `/scope` subpath), and points the import there. The reader drops such a node
 * — rightly, it is not a place anyone can navigate to — and with it goes every
 * core→daemon edge in the graph. Six of the eight blind spots of the graph
 * ceiling diagnosis were exactly that.
 *
 * The missing half is the one thing Graphify cannot know from the import line
 * alone and we can read off disk in a few files: the workspace's own
 * package.json map from `name` (+ `exports` subpath) to a file.
 *
 * DIST IS RESOLVED BACK TO SOURCE. `exports` points at `./dist/index.js`,
 * which is a build artifact and is not in the graph — the graph indexes
 * `packages/core/src/index.ts`. So every resolved target is tried under `src/`
 * with a TypeScript extension first and only accepted when the file exists.
 * A specifier whose target cannot be found on disk is left out entirely
 * rather than guessed at: a wrong entry file would spread a blast radius over
 * a package the change never touched.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Largest package.json this will read. A manifest is a few kilobytes; a
 * megabyte-sized one is not a manifest, and this runs inside a graph load.
 */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** Upper bound on workspace packages examined, so a glob cannot unbound this. */
const MAX_WORKSPACE_PACKAGES = 200;

/**
 * Import specifier -> repo-relative SOURCE file it resolves to.
 * `@bastra-recall/core` -> `packages/core/src/index.ts`,
 * `@bastra-recall/core/scope` -> `packages/core/src/scope.ts`.
 */
export type WorkspaceModules = ReadonlyMap<string, string>;

/**
 * Read the workspace manifests under `repoRoot` and build the specifier map.
 * Never throws: a repository without workspaces, without a package.json or
 * with an unparseable one simply has no bare specifiers to resolve, and code
 * awareness stays exactly as useful as it was before.
 */
export function workspaceModules(repoRoot: string): WorkspaceModules {
  const out = new Map<string, string>();
  const root = readManifest(join(repoRoot, "package.json"));
  if (root === null) return out;
  const patterns = Array.isArray(root.workspaces)
    ? root.workspaces
    : isRecord(root.workspaces) && Array.isArray(root.workspaces.packages)
      ? root.workspaces.packages
      : [];

  for (const dir of workspaceDirs(repoRoot, patterns)) {
    const pkg = readManifest(join(repoRoot, dir, "package.json"));
    if (pkg === null || typeof pkg.name !== "string" || pkg.name.length === 0) continue;
    const name = pkg.name;
    const resolve = (target: unknown): string | null =>
      typeof target === "string" ? sourceFileOf(repoRoot, dir, target) : null;

    if (isRecord(pkg.exports)) {
      for (const [subpath, value] of Object.entries(pkg.exports)) {
        if (!subpath.startsWith(".")) continue; // conditions at the top level
        const file = resolve(typeof value === "string" ? value : conditionTarget(value));
        if (file === null) continue;
        out.set(subpath === "." ? name : name + subpath.slice(1), file);
      }
    }
    if (!out.has(name)) {
      const file = resolve(pkg.main) ?? resolve(pkg.module) ?? resolve(pkg.types);
      if (file !== null) out.set(name, file);
    }
  }
  return out;
}

/**
 * The directories the `workspaces` patterns name. Only the two forms npm
 * actually sees here are handled: a literal path, and one trailing `/*`.
 * Anything else is skipped rather than half-matched.
 */
function workspaceDirs(repoRoot: string, patterns: readonly unknown[]): string[] {
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.length === 0) continue;
    if (dirs.length >= MAX_WORKSPACE_PACKAGES) break;
    if (!pattern.includes("*")) {
      dirs.push(trimSlashes(pattern));
      continue;
    }
    if (!pattern.endsWith("/*") || pattern.slice(0, -2).includes("*")) continue;
    const parent = trimSlashes(pattern.slice(0, -2));
    let entries: string[];
    try {
      entries = readdirSync(join(repoRoot, parent));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      if (dirs.length >= MAX_WORKSPACE_PACKAGES) break;
      dirs.push(`${parent}/${entry}`);
    }
  }
  return dirs;
}

/**
 * One `exports` value reduced to a target path. The conditions are tried in
 * the order a bundler would: `import` before `types` before `default`, and a
 * nested condition object one level deep.
 */
function conditionTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return null;
  for (const key of ["import", "types", "default", "require"]) {
    const inner = value[key];
    if (typeof inner === "string") return inner;
    if (isRecord(inner)) {
      const deep = conditionTarget(inner);
      if (deep !== null) return deep;
    }
  }
  return null;
}

/**
 * The repo-relative SOURCE file a package's export target means, or null when
 * nothing that exists on disk corresponds to it.
 *
 * `./dist/scope.js` is tried as `src/scope.ts`, `src/scope.tsx` and
 * `src/scope/index.ts` before the literal path — a graph never contains the
 * build output, so the literal path is the last resort, not the first guess.
 */
function sourceFileOf(repoRoot: string, dir: string, target: string): string | null {
  const rel = target.replace(/\\/g, "/").replace(/^\.\//, "");
  if (rel.length === 0 || rel.startsWith("/") || rel.split("/").includes("..")) return null;

  const candidates: string[] = [];
  const build = /^(?:dist|build|lib|out)\/(.+)\.(?:js|mjs|cjs|d\.ts)$/.exec(rel);
  if (build !== null) {
    const stem = build[1];
    candidates.push(`src/${stem}.ts`, `src/${stem}.tsx`, `src/${stem}/index.ts`);
  }
  candidates.push(rel);

  for (const candidate of candidates) {
    const repoRelative = `${dir}/${candidate}`;
    if (existsSync(join(repoRoot, repoRelative))) return repoRelative;
  }
  return null;
}

function readManifest(path: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function trimSlashes(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
