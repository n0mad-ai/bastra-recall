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
  const patterns = workspacePatterns(repoRoot);
  if (patterns.length === 0) return out;

  for (const dir of workspaceDirs(repoRoot, patterns)) {
    const pkg = readManifest(join(repoRoot, dir, "package.json"));
    if (pkg === null || typeof pkg.name !== "string" || pkg.name.length === 0) continue;
    const name = pkg.name;
    const resolve = (target: unknown): string | null =>
      typeof target === "string" ? sourceFileOf(repoRoot, dir, target) : null;

    if (isRecord(pkg.exports)) {
      for (const [subpath, value] of Object.entries(pkg.exports)) {
        if (!subpath.startsWith(".")) continue; // conditions at the top level
        const target = typeof value === "string" ? value : conditionTarget(value);
        if (target === null) continue;
        if (subpath.includes("*")) {
          for (const [suffix, file] of wildcardTargets(repoRoot, dir, target)) {
            // A subpath can carry more than one `*` (e.g. `./*/*.js`); Node
            // substitutes the SAME match into every one of them, so a plain
            // `replace` — which only touches the first — would leave the
            // later stars in the specifier literal (#582 CodeQL).
            out.set(name + subpath.slice(1).replaceAll("*", suffix), file);
          }
          continue;
        }
        const file = resolve(target);
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
 * Where a repository declares its workspace packages.
 *
 * npm and yarn put it in package.json; PNPM puts it in `pnpm-workspace.yaml`
 * and package.json then says nothing at all. Measured on a real pnpm monorepo
 * (17 packages, scope `@bastra`, 237 cross-package imports): reading only
 * package.json resolved ZERO specifiers, so every cross-package import stayed
 * unresolved and the package boundary was silently missing — the exact failure
 * `bastra doctor` now counts.
 *
 * The YAML is read with a line matcher rather than a parser: the file is a
 * list of globs under one key, and taking on a YAML dependency inside the
 * graph-load path would be the larger commitment. A file that does not match
 * this shape yields no patterns, which is the same as having none.
 */
function workspacePatterns(repoRoot: string): unknown[] {
  const root = readManifest(join(repoRoot, "package.json"));
  const fromManifest = Array.isArray(root?.workspaces)
    ? root.workspaces
    : isRecord(root?.workspaces) && Array.isArray(root.workspaces.packages)
      ? root.workspaces.packages
      : [];
  if (fromManifest.length > 0) return fromManifest;

  let yaml: string;
  try {
    yaml = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return [];
  }
  if (Buffer.byteLength(yaml, "utf8") > MAX_MANIFEST_BYTES) return [];

  const patterns: string[] = [];
  let inPackages = false;
  for (const raw of yaml.split("\n")) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s*-\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (item !== null) patterns.push(item[1]);
    else if (line.trim().length > 0 && !line.startsWith(" ")) break;
  }
  return patterns;
}

/**
 * The directories the `workspaces` patterns name.
 *
 * A pattern is matched segment by segment, so all the shapes a real monorepo
 * writes resolve: one trailing star as before, a star in the MIDDLE of a
 * pattern (`apps`, star, `frontend`), a partial segment (`pkg-` star), and a
 * double star standing for any number of segments — pnpm's own default, and
 * the one shape that silently resolved NOTHING before. Negations
 * (`!packages/legacy`) are not patterns of their own and are skipped: a
 * workspace dir too many costs one manifest read, an excluded one that is
 * still read costs a specifier nobody imports.
 */
function workspaceDirs(repoRoot: string, patterns: readonly unknown[]): string[] {
  const dirs = new Set<string>();
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.length === 0) continue;
    if (pattern.startsWith("!")) continue;
    if (dirs.size >= MAX_WORKSPACE_PACKAGES) break;
    const segments = trimSlashes(pattern).split("/").filter((s) => s.length > 0);
    for (const dir of matchDirs(repoRoot, "", segments, MAX_WORKSPACE_PACKAGES - dirs.size)) {
      dirs.add(dir);
    }
  }
  return [...dirs];
}

/** How deep a `**` may descend. A workspace is not nested twelve levels. */
const MAX_GLOB_DEPTH = 12;

/** Directories under `base` matching the remaining glob `segments`. */
function matchDirs(
  repoRoot: string,
  base: string,
  segments: readonly string[],
  budget: number,
  depth = 0,
): string[] {
  if (budget <= 0 || depth > MAX_GLOB_DEPTH) return [];
  if (segments.length === 0) return base.length > 0 ? [base] : [];
  const [head, ...rest] = segments;
  const out: string[] = [];
  const under = (entry: string): string => (base.length > 0 ? `${base}/${entry}` : entry);

  if (!head.includes("*")) {
    const next = under(head);
    if (!existsSync(join(repoRoot, next))) return [];
    return matchDirs(repoRoot, next, rest, budget, depth + 1);
  }

  // `**` matches zero segments too, so the rest is tried right here first and
  // the pattern stays in play one level down.
  const re = head === "**" ? null : globSegment(head);
  if (re === null) out.push(...matchDirs(repoRoot, base, rest, budget, depth + 1));
  for (const entry of childDirs(repoRoot, base)) {
    if (out.length >= budget) break;
    if (re !== null && !re.test(entry)) continue;
    out.push(
      ...matchDirs(repoRoot, under(entry), re === null ? segments : rest, budget - out.length, depth + 1),
    );
  }
  return out;
}

/** The immediate subdirectories of `base`, skipping what is never a package. */
function childDirs(repoRoot: string, base: string): string[] {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = readdirSync(join(repoRoot, base), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => e.name);
}

/** One path segment of a glob as a regex. `*` matches within the segment. */
function globSegment(segment: string): RegExp {
  return new RegExp(`^${segment.split("*").map(escapeRe).join("[^/]*")}$`);
}

function escapeRe(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

/** Files a single wildcard export may expand to. A package is not a file tree. */
const MAX_WILDCARD_TARGETS = 200;

/**
 * A WILDCARD subpath export, expanded against the files on disk.
 *
 * `"./*": "./dist/*.js"` is how a package says "every module of mine is
 * importable by its name", and it is the shape of every `exports` map written
 * by a generator. Without it `@acme/core/scope` resolved to nothing, the
 * package boundary was missing for the whole package, and the change-impact
 * answer silently lost every cross-package dependent of it — the same failure
 * `pnpm-workspace.yaml` caused before it was read.
 *
 * Returns the `*` capture and the repo-relative SOURCE file for each match,
 * so the caller can put the capture back into the specifier. `*` matches
 * across `/`, the way Node resolves it. The source rewrite is the one from
 * `sourceFileOf`: a build path is tried under `src/` first, because the graph
 * indexes source and never the build output.
 */
function wildcardTargets(repoRoot: string, dir: string, target: string): Array<[string, string]> {
  const rel = target.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!rel.includes("*") || rel.startsWith("/") || rel.split("/").includes("..")) return [];

  for (const pattern of sourcePatternsOf(rel)) {
    const star = pattern.indexOf("*");
    if (star < 0 || pattern.indexOf("*", star + 1) >= 0) continue;
    const re = new RegExp(`^${escapeRe(pattern.slice(0, star))}(.+)${escapeRe(pattern.slice(star + 1))}$`);
    const head = pattern.split("/")[0];
    const out: Array<[string, string]> = [];
    for (const file of filesUnder(repoRoot, dir, head.includes("*") ? "" : head)) {
      const m = re.exec(file);
      if (m !== null) out.push([m[1], `${dir}/${file}`]);
      if (out.length >= MAX_WILDCARD_TARGETS) break;
    }
    if (out.length > 0) return out;
  }
  return [];
}

/** The source spellings of an export target, build output rewritten to `src/`. */
function sourcePatternsOf(rel: string): string[] {
  const build = /^(?:dist|build|lib|out)\/(.+)\.(?:js|mjs|cjs|d\.ts)$/.exec(rel);
  if (build === null) return [rel];
  return [`src/${build[1]}.ts`, `src/${build[1]}.tsx`, `src/${build[1]}/index.ts`, rel];
}

/** Every file under `dir/top`, package-relative, bounded. */
function filesUnder(repoRoot: string, dir: string, top: string): string[] {
  const out: string[] = [];
  const walk = (prefix: string, depth: number): void => {
    if (out.length >= MAX_WILDCARD_TARGETS || depth > MAX_GLOB_DEPTH) return;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = readdirSync(join(repoRoot, dir, prefix), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isFile()) out.push(path);
      else if (entry.isDirectory()) walk(path, depth + 1);
      if (out.length >= MAX_WILDCARD_TARGETS) return;
    }
  };
  walk(top, 0);
  return out;
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
