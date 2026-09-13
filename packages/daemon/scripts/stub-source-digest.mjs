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
 */
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
