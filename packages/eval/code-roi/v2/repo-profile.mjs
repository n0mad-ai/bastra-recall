/**
 * What the miner needs to know about a repository, DERIVED rather than
 * hard-coded (#582, registration v5).
 *
 * `mine.mjs` was written for exactly one repository and said so in four
 * places: the workspace scope `@bastra-recall`, the assumption that every
 * workspace package lives under `packages/`, the assumption that each one has
 * its own `tsconfig.json`, and the "build core first" step. bastra-recall's
 * own history ran out at 7 usable scenarios with ZERO cross-package breaks —
 * the one thing #582 was built for — so the sample has to come from another
 * repository, and every one of those four assumptions is wrong somewhere.
 *
 * Measured on the two repositories this is used for:
 *
 *   bastra-recall   npm workspaces, scope @bastra-recall, 5 packages each with
 *                   its own tsconfig; daemon imports core through core's DIST,
 *                   so core must be built before anything else typechecks.
 *   bastra-io       pnpm workspace (apps/*, packages/*, tools/*), scope
 *                   @bastra, ONE tsconfig in apps/bastra-io; packages are
 *                   consumed as raw TS source (`main: ./src/index.ts`), so
 *                   there is nothing to build and a single typecheck covers
 *                   the app plus every package source it reaches.
 *
 * Everything here is read off the repository's own manifests. Nothing is
 * configured per repository, because a configuration file is a place for the
 * profile to drift away from what the repository actually does.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectRunner, isTestFile } from "./test-truth.mjs";

/** Upper bound on workspace packages examined. */
const MAX_PACKAGES = 200;

/**
 * @typedef {object} RepoProfile
 * @property {string} root            absolute path of the repository
 * @property {string[]} packageDirs   repo-relative dirs of the workspace packages
 * @property {string[]} scopes        npm scopes the workspace publishes under, e.g. ["@bastra"]
 * @property {Map<string,string>} packageNames  repo-relative dir -> package name
 * @property {string[]} tsconfigs     repo-relative tsconfig paths to typecheck
 * @property {string[]} buildFirst    repo-relative dirs that must be built before typechecking
 * @property {string[]} sourceGlobs   where a CHANGED file must live to be a scenario
 * @property {string} truth           "types" (tsc) or "tests" (the repo's own suite)
 * @property {RegExp} sourceExt       extensions a changed file may carry
 * @property {{kind: string, reporter: string, script: string}|null} testRunner
 */

/** Read one JSON manifest, or null. */
function manifest(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The workspace globs a repository declares: npm/yarn `workspaces` in
 * package.json, or pnpm's `pnpm-workspace.yaml`. The YAML is read with a line
 * matcher rather than a parser — the file is a list of globs and pulling in a
 * YAML dependency for it would be the larger commitment.
 */
function workspaceGlobs(root) {
  const pkg = manifest(join(root, "package.json"));
  const fromPkg = Array.isArray(pkg?.workspaces)
    ? pkg.workspaces
    : Array.isArray(pkg?.workspaces?.packages)
      ? pkg.workspaces.packages
      : [];
  if (fromPkg.length > 0) return fromPkg;

  const yaml = join(root, "pnpm-workspace.yaml");
  if (!existsSync(yaml)) return [];
  const globs = [];
  let inPackages = false;
  for (const raw of readFileSync(yaml, "utf8").split("\n")) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const item = /^\s*-\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
      if (item !== null) globs.push(item[1]);
      else if (line.trim().length > 0 && !line.startsWith(" ")) inPackages = false;
    }
  }
  return globs;
}

/** The directories one glob names: a literal path, or one trailing `/*`. */
function dirsOf(root, glob) {
  const clean = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!clean.includes("*")) return existsSync(join(root, clean)) ? [clean] : [];
  if (!clean.endsWith("/*") || clean.slice(0, -2).includes("*")) return [];
  const parent = clean.slice(0, -2);
  try {
    return readdirSync(join(root, parent))
      .filter((e) => !e.startsWith(".") && existsSync(join(root, parent, e, "package.json")))
      .map((e) => `${parent}/${e}`);
  } catch {
    return [];
  }
}

/**
 * Build the profile for `root`.
 *
 * `buildFirst` is the subtle one and it is derived, not listed: a package whose
 * `main` points into a build directory is consumed through its build output,
 * so that output has to exist before anything that imports it typechecks. A
 * package whose `main` points at `src/` is consumed as source and needs
 * nothing. That single rule is the difference between the two repositories.
 */
export function repoProfile(root, { truth = "types" } = {}) {
  const packageDirs = [];
  for (const glob of workspaceGlobs(root)) {
    for (const dir of dirsOf(root, glob)) {
      if (packageDirs.length >= MAX_PACKAGES) break;
      if (!packageDirs.includes(dir)) packageDirs.push(dir);
    }
  }

  const packageNames = new Map();
  const scopes = new Set();
  const buildFirst = [];
  const tsconfigs = [];
  for (const dir of packageDirs) {
    const pkg = manifest(join(root, dir, "package.json"));
    if (pkg === null || typeof pkg.name !== "string") continue;
    packageNames.set(dir, pkg.name);
    if (pkg.name.startsWith("@")) scopes.add(pkg.name.split("/")[0]);
    const entry = typeof pkg.main === "string" ? pkg.main : (pkg.module ?? pkg.types);
    if (typeof entry === "string" && /^\.?\/?(dist|build|lib|out)\//.test(entry)) {
      buildFirst.push(dir);
    }
    if (existsSync(join(root, dir, "tsconfig.json"))) tsconfigs.push(`${dir}/tsconfig.json`);
  }

  // A repository whose packages carry no tsconfig of their own is typechecked
  // through whatever tsconfig DOES exist — bastra-io's single app config
  // reaches every package source it imports, which is the whole point there.
  if (tsconfigs.length === 0 && existsSync(join(root, "tsconfig.json"))) tsconfigs.push("tsconfig.json");

  return {
    root,
    packageDirs,
    scopes: [...scopes],
    packageNames,
    tsconfigs,
    buildFirst,
    // A scenario's changed file must be production source inside a workspace
    // package — never a test, never a config, never generated output. A
    // repository without workspaces (the common shape outside a monorepo) has
    // no package dirs to name, so its source roots are derived instead.
    sourceGlobs: packageDirs.length > 0 ? packageDirs.map((d) => `${d}/`) : sourceRoots(root),
    truth,
    // Test-based truth is what makes a JavaScript repository measurable at
    // all; the type-based truth stays TS-only, exactly as the v3/v4 archives
    // were mined, so nothing about those runs moves.
    sourceExt: truth === "tests" ? /\.[cm]?[jt]sx?$/ : /\.tsx?$/,
    testRunner: truth === "tests" ? detectRunner(root) : null,
  };
}

/** Top-level directories that hold source, for a repository without workspaces. */
function sourceRoots(root) {
  const skip = new Set(["node_modules", "docs", "doc", "dist", "build", "out", "coverage", "public", "assets"]);
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !skip.has(e.name) && !isTestFile(`${e.name}/`))
      .map((e) => `${e.name}/`)
      .sort();
  } catch {
    return [];
  }
}

/** True when `file` is a changed file a scenario may be built on. */
export function isScenarioFile(profile, file) {
  const ext = profile.sourceExt ?? /\.tsx?$/;
  if (!ext.test(file) || /\.d\.ts$/.test(file)) return false;
  // The type-based path keeps the exact predicate the v3 and v4 archives were
  // mined with. The wider one (a `tests/` directory anywhere) belongs to the
  // test-based path, where a file under `tests/` is the evidence, not the
  // subject, and must never become a scenario's changed file.
  const isTest =
    profile.truth === "tests"
      ? isTestFile(file)
      : /(^|\/)__tests__\//.test(file) || /\.(test|spec)\.tsx?$/.test(file);
  if (isTest) return false;
  if (/(^|\/)(dist|build|out|node_modules)\//.test(file)) return false;
  return profile.sourceGlobs.some((g) => file.startsWith(g));
}
