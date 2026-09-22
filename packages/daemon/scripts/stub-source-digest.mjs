/**
 * The digest of the sources a stub binary must have been compiled from (#546).
 *
 * `bastra-hook` is a `deno compile` binary. Once compiled it has no sources to
 * compare against, so the question "is this binary current?" can only be
 * answered if the binary carries the answer itself — the same conclusion #528
 * reached for `dist`, where an mtime proved nothing about WHICH sources
 * produced the output.
 *
 * Here the stamp is a content digest rather than a git revision, because the
 * question is narrower and the answer has to be exact:
 *
 *  · a git revision goes stale on every commit, including the hundreds that
 *    cannot possibly affect the stub — the guard would cry stale all day and
 *    be turned off;
 *  · a dirty-tree flag is the same problem in miniature: an edit anywhere in
 *    the repo would condemn a binary that is byte-for-byte correct;
 *  · a content digest changes when, and only when, one of the files that go
 *    into the binary changes — committed or not, which is exactly the case
 *    that bit us. The binary installed on the dev host was from 29.08. and had
 *    run for two weeks against sources that had moved on through #305, #543
 *    and #545.
 *
 * The closure is the stub entry plus every local module it imports,
 * transitively. Two deliberate exclusions:
 *
 *  · `stub/build-info.ts` — it IS the stamp, so including it would make the
 *    digest depend on itself;
 *  · `../../statusline/dist/index.mjs` — a build artifact of another package,
 *    lazily imported by the `statusline` subcommand only. It is not part of
 *    the hook-lane contract this guard measures, and it is not committed, so
 *    a fresh checkout could not compute a digest that included it.
 *
 * That second exclusion left a gap, and `statuslineBundleDigest()` below closes
 * it without reopening the boundary — see the comment there (#547).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root: this file lives in <packageRoot>/scripts/. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The stub entry point — the one file `deno compile` is pointed at. */
export const STUB_ENTRY = resolve(PACKAGE_ROOT, "stub", "bastra-hook.ts");

/** The generated stamp module. Excluded from the digest it carries. */
export const STUB_BUILD_INFO = resolve(PACKAGE_ROOT, "stub", "build-info.ts");

/** The statusline bundle the `statusline` subcommand imports, which
 *  `deno compile` embeds in the same binary (stub/bastra-hook.ts). */
export const STATUSLINE_BUNDLE = resolve(PACKAGE_ROOT, "..", "statusline", "dist", "index.mjs");

/**
 * sha256 over the statusline bundle that ships INSIDE the stub binary, or
 * null when there is no bundle here to hash (#547).
 *
 * A second digest rather than a widening of the one above, because the two
 * answer different questions and must be able to disagree: the stub's source
 * closure says whether the hook lanes are current, and this says whether the
 * statusline the same binary carries is. A binary can be right about the first
 * and wrong about the second — that is the whole of #547 — and one combined
 * number could not tell anyone which half moved.
 *
 * It hashes the BUILT bundle, not `packages/statusline/src/**`, although the
 * sources are the committed, deterministic input and would be the tidier
 * thing to hash. `build:stub` does not build the statusline; it compiles
 * whatever `dist/index.mjs` happens to be there. Stamping the source digest
 * would therefore certify sources the binary may not contain — a fresh stub
 * built over a stale `dist` would report itself current, which is exactly the
 * false "ok" this issue exists to remove. The bytes that go into the binary
 * are the only thing that cannot lie about what is in the binary.
 *
 * The consequence, stated so nobody has to re-derive it: the reference value
 * now depends on a build artifact. Where `dist` has never been built there is
 * nothing to compare against, so this returns null and the check says it
 * cannot decide — the same honest non-answer `localStubSourceDigest()` gives
 * an npm or Homebrew install, never a guess in either direction.
 */
export function statuslineBundleDigest() {
  try {
    return createHash("sha256").update(readFileSync(STATUSLINE_BUNDLE)).digest("hex");
  } catch {
    return null;
  }
}

/** Every `import ... from "…"` / `import("…")` specifier in a source file. */
function specifiersOf(source) {
  const found = [];
  const re = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(source)) !== null) found.push(m[1] ?? m[2]);
  return found;
}

/**
 * The stub's source closure, as absolute paths, sorted — so the digest does
 * not depend on traversal order or on the filesystem's directory order.
 */
export function stubSourceFiles() {
  const seen = new Set();
  const queue = [STUB_ENTRY];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      // A specifier that does not resolve to a readable file is not ours to
      // fail over here — `deno compile` is the authority on that, and it runs
      // right after. Leaving it out keeps the digest computable on a checkout
      // that cannot build.
      continue;
    }
    seen.add(file);
    for (const spec of specifiersOf(source)) {
      if (!spec.startsWith(".")) continue; // node:, npm:, bare — not our sources
      const abs = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      if (abs === STUB_BUILD_INFO) continue; // the stamp cannot contain itself
      if (relative(PACKAGE_ROOT, abs).startsWith("..")) continue; // outside the package
      queue.push(abs);
    }
  }
  return [...seen].sort();
}

/**
 * sha256 over the closure: each file as `<path relative to the package root>\n
 * <bytes>\n`. The path is part of the hash so a file that MOVES changes the
 * digest, and always with `/` separators so macOS and Linux agree.
 */
export function stubSourceDigest({ read } = {}) {
  const hash = createHash("sha256");
  for (const file of stubSourceFiles()) {
    hash.update(relative(PACKAGE_ROOT, file).split(sep).join("/"));
    hash.update("\n");
    // `read` is the seam the guard uses to ask "would this digest move if that
    // file changed?" for every file in the closure, without editing the
    // checkout to find out. It returns undefined for the files it leaves alone.
    hash.update(read?.(file) ?? readFileSync(file));
    hash.update("\n");
  }
  return hash.digest("hex");
}

/**
 * Did the stub's own sources differ from HEAD at build time? (#546)
 *
 * Scoped to the closure, not to the repo. The first version asked
 * `git status --porcelain` about the whole tree, and on the dev host that
 * answered `true` for a binary built from a clean, pushed checkout — two
 * untracked scratch files (`.codex-handover*.md`) were lying around, and a
 * markdown note cannot reach a compiled hook stub. A flag that reads `true`
 * for every developer who ever leaves a scratch file behind says the same
 * thing always, and a field that always says the same thing is evidence of
 * nothing: nobody could then spot a binary that really was built from
 * uncommitted code.
 *
 * Untracked still counts, for the reason `write-build-revision.mjs` gives —
 * but only inside the closure: a file is in this list because the stub
 * actually imports it, and an uncommitted import is exactly the build whose
 * provenance nobody can reconstruct later.
 *
 * Scoping it this way also removes a self-reference by construction:
 * `stub/build-info.ts` is not in the closure, so the stamp can never be the
 * thing that marks its own build dirty — whatever order the build runs in.
 *
 * No git at all (a published tarball, a copied tree) is not dirty, it is
 * unknown: `revision` is null there, and that pair is the honest answer.
 */
export function stubSourcesDirty() {
  try {
    const out = execFileSync(
      "git",
      ["-C", PACKAGE_ROOT, "status", "--porcelain", "--", ...stubSourceFiles()],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 },
    );
    return out.trim() !== "";
  } catch {
    return false;
  }
}
