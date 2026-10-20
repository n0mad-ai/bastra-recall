/**
 * The coverage map: which tests executed which files (#629, experimental).
 *
 * WHAT IT ANSWERS. The graph names the files that import or call a changed
 * symbol. It cannot name a test that reaches the symbol at runtime only — a
 * spawned daemon, the CLI, an HTTP round trip, a shared fixture. On the 44
 * registered delivered-run scenarios (#628) the file the change really broke
 * was a test in nearly every case, and the graph had an edge for it in 15 of
 * 37 blocks. Executed-code coverage sees the runtime road by construction.
 *
 * WHERE THE DATA COMES FROM. Nobody runs a suite to build the map. When the
 * switch is on (`coverageMap.enabled`, off by default — the hook is rewriting
 * someone else's command, and that must never happen unasked), the Bash
 * PreToolUse lane prefixes a recognised test command with `NODE_V8_COVERAGE`
 * pointing into `<repo>/.bastra-coverage/raw/`. Node writes one JSON per
 * process on exit, children included. The lab on `packages/core` (2026-10-20,
 * quiet machine, two runs each): 10.5–10.8 s plain, 14.7–15.4 s with
 * coverage, 171 MB of raw output per run, folded in about one second into a
 * 250 KB map.
 *
 * WHEN IT FOLDS. At the same moments the graph refreshes — Stop hook, git
 * event, watcher, startup — `scheduleCoverageFold` runs one fold per
 * repository, debounced and single-flight, and deletes every raw file it has
 * read. Nothing waits for it.
 *
 * WHAT IT STORES. Paths and function names, never source text:
 *
 *   { version: 1, foldedAt, runs, tests: { "<test>": { "<file>": ["fn", …] } } }
 *
 * Function grain comes free from the raw format (V8 lists every function with
 * its call count), so a test is ranked by how many of the CHANGED functions it
 * ran, not merely whether it loaded the file — at file grain the map named
 * about forty tests per change on the #628 population, which is the static
 * closure's answer and no better.
 *
 * WHAT IT CANNOT DO. A process that loads no test file of its own — a daemon
 * a test spawned — carries no mark of which test started it, and its coverage
 * is dropped rather than guessed. `.js` scripts with a `.map` beside them are
 * mapped back to their first in-repo source at FILE grain only.
 */

import { spawnSync } from "node:child_process";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeAttr } from "../escape-attr.js";

export const COVERAGE_DIR_NAME = ".bastra-coverage";
export const COVERAGE_MAP_FILE_NAME = "coverage-map.json";
const RAW_DIR_NAME = "raw";

/** The map is read in a hook; a file past this is treated as absent. */
const MAX_MAP_BYTES = 16 * 1024 * 1024;
/** Raw output nobody folded — the lane stops collecting rather than filling the disk. */
export const MAX_RAW_BYTES = 1024 * 1024 * 1024;
/** A raw file younger than this may still be being written. */
const RAW_SETTLE_MS = 2_000;
/** A raw file that still fails to parse after this long is garbage and goes. */
const RAW_GIVE_UP_MS = 10 * 60_000;
/** How many tests one line names before the rest becomes a count. */
export const MAX_COVERAGE_TESTS = 5;
/** Quiet period before a fold, bursty triggers coalesce into one. */
const FOLD_DEBOUNCE_MS = 3_000;

export function coverageDirOf(repoRoot: string): string {
  return join(repoRoot, COVERAGE_DIR_NAME);
}
export function coverageRawDirOf(repoRoot: string): string {
  return join(coverageDirOf(repoRoot), RAW_DIR_NAME);
}
export function coverageMapFileOf(repoRoot: string): string {
  return join(coverageDirOf(repoRoot), COVERAGE_MAP_FILE_NAME);
}

/**
 * What the impact and boundary blocks count as a test, `__tests__` helpers
 * included. The fold uses a narrower rule on purpose (`foldProcess`): it
 * attributes a process only to files named `*.test.*` / `*.spec.*`, since a
 * helper under `__tests__` is loaded by many tests and is none of them.
 */
export function isTestFile(f: string): boolean {
  return f.includes("__tests__") || /\.(test|spec)\./.test(f);
}

// ─── Collecting ──────────────────────────────────────────────────

/**
 * Commands worth collecting from — a list, not a parser. Anything else runs
 * untouched; a missed test runner costs one map entry, a false positive
 * rewrites a command that was not a test run.
 */
const HEAD = String.raw`(?:^|[;&|(\n]\s*)`;
const TEST_COMMANDS: readonly RegExp[] = [
  new RegExp(HEAD + String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w-]+)?(?=\s|$)`),
  new RegExp(HEAD + String.raw`(?:npx\s+)?(?:vitest|jest)(?=\s|$)`),
  new RegExp(HEAD + String.raw`(?:node|tsx)\b[^|&;\n]*\s--test(?=\s|$)`),
];

export function isTestCommand(command: string): boolean {
  return TEST_COMMANDS.some((re) => re.test(command));
}

/**
 * The command with the collector switched on. A plain prefix would bind the
 * variable to the first word only (`cd pkg && npm test` would cover `cd`), so
 * it is exported for the shell line as a whole; Claude Code runs each call in
 * its own shell, so nothing outlives the call. A command that already sets
 * the variable is the user's business and is left alone.
 */
export function withCoverageEnv(command: string, rawDir: string): string {
  if (command.includes("NODE_V8_COVERAGE")) return command;
  return `export NODE_V8_COVERAGE='${rawDir.replace(/'/g, "'\\''")}'; ${command}`;
}

/**
 * Make the directory and keep it out of git with a self-ignoring `.gitignore`
 * — the same contract as `node_modules/.cache`, and one that needs no entry
 * in the project's files or in `.git/info/exclude`.
 */
export async function ensureCoverageDir(repoRoot: string): Promise<void> {
  const dirs = await coverageDirs(repoRoot, true);
  if (dirs === null) throw new Error(`coverage map: ${coverageDirOf(repoRoot)} is not a plain directory`);
  const ignore = join(dirs.dir, ".gitignore");
  let fh;
  try {
    fh = await open(ignore, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
    throw err;
  }
  try {
    await fh.writeFile("*\n", "utf8");
  } finally {
    await fh.close();
  }
}

/** `O_NOFOLLOW` where the platform has it; opening a symlink then fails with ELOOP. */
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * The directories this module writes to and deletes from must be what it
 * made them: a symlink planted at `.bastra-coverage` or `raw` would turn the
 * fold's delete and the map's write into operations elsewhere.
 *
 * NO CHECK-THEN-USE ON FILES. A raw file is opened with `O_NOFOLLOW`, judged
 * on the handle (`fstat`: a regular file, settled) and read through the same
 * handle; a symlink at its path fails the open. It is deleted with `unlink`,
 * which never follows a link. The `.gitignore` and the map's temp file are
 * created with `O_EXCL | O_NOFOLLOW`, and `rename` replaces a path, not what
 * a link at it points to.
 *
 * THE DIRECTORIES THEMSELVES are created one level at a time: each level is
 * `lstat`ed, made with a non-recursive `mkdir` if absent, and refused if it is
 * a symlink. They are then compared by real path to the path they are
 * expected to have under the repository's real root; a
 * symlink in the chain makes the two differ. That is a check before use —
 * Node has no way to read a directory through a handle — and the window
 * between it and the file operations is the residual race. It is harmless
 * here: the directory is the user's own, inside their checkout, and
 * everything that follows refuses to follow a link on the final component.
 */
/**
 * One directory level, no link followed: absent → a non-recursive `mkdir` of
 * exactly this level; present → only a real directory, never a symlink.
 */
async function ensurePlainDir(path: string): Promise<boolean> {
  let st = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (!st) {
    await mkdir(path).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
    st = await lstat(path);
  }
  return st.isDirectory() && !st.isSymbolicLink();
}

async function coverageDirs(repoRoot: string, create: boolean): Promise<{ dir: string; raw: string } | null> {
  const dir = coverageDirOf(repoRoot);
  const raw = coverageRawDirOf(repoRoot);
  try {
    if (create) {
      await mkdir(repoRoot, { recursive: true }); // the checkout itself may legitimately be a link
      for (const level of [dir, raw]) {
        if (!(await ensurePlainDir(level))) {
          process.stderr.write(`[bastra-recall] coverage map: ${dir} is not a plain directory — left alone\n`);
          return null;
        }
      }
    }
    const rootReal = await realpath(repoRoot);
    const expectedRaw = join(rootReal, COVERAGE_DIR_NAME, RAW_DIR_NAME);
    if ((await realpath(raw)) !== expectedRaw || (await realpath(dir)) !== dirname(expectedRaw)) {
      process.stderr.write(`[bastra-recall] coverage map: ${dir} is not a plain directory — left alone\n`);
      return null;
    }
    return { dir, raw };
  } catch {
    return null;
  }
}

/** One raw file through a `O_NOFOLLOW` handle: parsed, still settling, or unreadable (with its age). */
async function readRawFile(
  path: string,
  now: number,
): Promise<{ kind: "doc"; doc: { result?: RawScript[] } } | { kind: "settling" } | { kind: "unreadable"; ageMs: number } | { kind: "skip" }> {
  let fh;
  try {
    fh = await open(path, fsConstants.O_RDONLY | NOFOLLOW);
  } catch {
    return { kind: "skip" };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { kind: "skip" };
    if (now - st.mtimeMs < RAW_SETTLE_MS) return { kind: "settling" };
    try {
      return { kind: "doc", doc: JSON.parse(await fh.readFile("utf8")) as { result?: RawScript[] } };
    } catch {
      return { kind: "unreadable", ageMs: now - st.mtimeMs };
    }
  } finally {
    await fh.close();
  }
}

/** Bytes of raw output waiting in the directory; 0 when there is none. */
export async function rawBytesOf(repoRoot: string): Promise<number> {
  let total = 0;
  try {
    const dir = coverageRawDirOf(repoRoot);
    for (const name of await readdir(dir)) {
      try {
        total += (await stat(join(dir, name))).size;
      } catch {
        /* removed under us */
      }
    }
  } catch {
    return 0;
  }
  return total;
}

// ─── The map ─────────────────────────────────────────────────────

/**
 * The map is read from inside the repository and its lines reach the agent's
 * context, so it is untrusted input like any file in a checkout (#1232):
 * every key must be a plain repo-relative path, every value a list of plain
 * names, the file must carry the daemon's own marker (which proves nothing on
 * its own — anyone can write it), and nothing under `.bastra-coverage` may be
 * tracked by git — a map, a directory or a symlink that arrived with a clone
 * is not one this daemon wrote. `.bastra-coverage` must be a real directory
 * at its own place under the repository's real root, and the map a regular
 * file opened without following a link. Anything else and the map is treated
 * as absent.
 */
export const COVERAGE_MAP_WRITER = "bastra-recall";
const MAX_KEY_LENGTH = 256;
const MAX_NAME_LENGTH = 256;
/** Control characters and the four that open a tag, a quote or a fence. */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f<>"`]/;
/**
 * A path key, character by character: word characters, `@ + . / -`. No
 * space, so a key cannot carry a sentence; no shell or markup punctuation.
 * A file whose path falls outside this is left out of the map by the fold.
 */
const SAFE_PATH = /^[\w@+./-]+$/;

export function isSafeRepoPath(key: string): boolean {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  if (!SAFE_PATH.test(key)) return false;
  if (isAbsolute(key) || key.startsWith("/")) return false;
  return key.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function isSafeName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= MAX_NAME_LENGTH && !UNSAFE_CHARS.test(name);
}

export interface CoverageMap {
  version: 1;
  /** Who wrote it — {@link COVERAGE_MAP_WRITER}; a map without it is not read. */
  writer: string;
  /** ISO time of the last fold. */
  foldedAt: string;
  /** Raw files folded in over the map's life. */
  runs: number;
  /** Repo-relative test file → repo-relative source file → executed function names, sorted. */
  tests: Record<string, Record<string, string[]>>;
}

function emptyMap(): CoverageMap {
  return { version: 1, writer: COVERAGE_MAP_WRITER, foldedAt: new Date(0).toISOString(), runs: 0, tests: {} };
}

/** The map on disk, or null when there is none, it is unreadable, invalid or git-tracked. */
export async function readCoverageMap(repoRoot: string): Promise<CoverageMap | null> {
  const fd = openMapSync(repoRoot);
  if (fd === null) return null;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_MAP_BYTES || trackedByGit(repoRoot)) return null;
    return parseMap(readFileSync(fd, "utf8"));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * The map's file descriptor, or null. `.bastra-coverage` must be a real
 * directory (`lstat`, never a symlink) whose real path is exactly its place
 * under the repository's real root — a link anywhere between the two makes
 * them differ — and the map itself is opened with `O_NOFOLLOW`, so a symlink
 * at its path fails the open. The caller still checks the handle is a
 * regular file.
 */
function openMapSync(repoRoot: string): number | null {
  try {
    const dir = coverageDirOf(repoRoot);
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    if (realpathSync(dir) !== join(realpathSync(repoRoot), COVERAGE_DIR_NAME)) return null;
    return openSync(coverageMapFileOf(repoRoot), fsConstants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
}

/** Strict: the shape above, every key a safe repo path, every value safe names. */
export function parseMap(text: string | null): CoverageMap | null {
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as Partial<CoverageMap>;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (raw.version !== 1 || raw.writer !== COVERAGE_MAP_WRITER) return null;
    if (typeof raw.tests !== "object" || raw.tests === null || Array.isArray(raw.tests)) return null;
    const tests: Record<string, Record<string, string[]>> = {};
    for (const [test, files] of Object.entries(raw.tests)) {
      if (!isSafeRepoPath(test) || typeof files !== "object" || files === null || Array.isArray(files)) return null;
      const entry: Record<string, string[]> = {};
      for (const [file, names] of Object.entries(files as Record<string, unknown>)) {
        if (!isSafeRepoPath(file) || !Array.isArray(names) || !names.every(isSafeName)) return null;
        entry[file] = names;
      }
      tests[test] = entry;
    }
    return {
      version: 1,
      writer: COVERAGE_MAP_WRITER,
      foldedAt: typeof raw.foldedAt === "string" && !UNSAFE_CHARS.test(raw.foldedAt) ? raw.foldedAt : new Date(0).toISOString(),
      runs: typeof raw.runs === "number" && Number.isFinite(raw.runs) && raw.runs >= 0 ? raw.runs : 0,
      tests,
    };
  } catch {
    return null;
  }
}

/**
 * Does git track anything at `.bastra-coverage` — the directory's contents,
 * or the path itself as a symlink? A checkout that brought one along is the
 * one way an outsider's map reaches the reader; the daemon's own directory
 * ignores itself, so git lists nothing there. Asking for the map file alone
 * was not enough: behind a committed symlink git does not match the path and
 * the map passed as untracked. One short `git ls-files`; the sync reader
 * caches it by the map's mtime. No git, or no repository: nothing is tracked.
 */
export function trackedByGit(repoRoot: string): boolean {
  try {
    const r = spawnSync("git", ["-C", repoRoot, "ls-files", "-z", "--", COVERAGE_DIR_NAME], {
      stdio: ["ignore", "pipe", "ignore"],
      // Runs in the Write/Edit lane before its budget check: short.
      timeout: 1_000,
    });
    return r.stdout !== null && r.stdout.length > 0;
  } catch {
    return false;
  }
}

/** Per repository, so switching between repositories does not re-parse; a few at most. */
const snapshots = new Map<string, { mtimeMs: number; size: number; map: CoverageMap | null }>();
const MAX_SNAPSHOTS = 8;

/**
 * The map for the hot paths, synchronously, like the enabled-repos snapshot:
 * one `fstat` per call, re-parsed only when the file moved. The Write/Edit
 * lane runs on every write and cannot afford a parse — or a `git` spawn —
 * each time.
 */
export function readCoverageMapSync(repoRoot: string): CoverageMap | null {
  const path = coverageMapFileOf(repoRoot);
  const fd = openMapSync(repoRoot);
  if (fd === null) {
    snapshots.delete(path);
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const hit = snapshots.get(path);
    if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.map;
    const map =
      st.size > MAX_MAP_BYTES || trackedByGit(repoRoot) ? null : parseMap(readFileSync(fd, "utf8"));
    snapshots.delete(path);
    if (snapshots.size >= MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
    snapshots.set(path, { mtimeMs: st.mtimeMs, size: st.size, map });
    return map;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

// ─── Folding ─────────────────────────────────────────────────────

interface RawScript {
  url?: string;
  functions?: Array<{ functionName?: string; ranges?: Array<{ count?: number }> }>;
}

export interface FoldResult {
  /** Raw files folded in and deleted. */
  folded: number;
  /** Raw files left for the next fold (still settling, or unreadable but young). */
  deferred: number;
  /** Processes that loaded no test file and were dropped. */
  unattributed: number;
  /** Tests in the map after the fold. */
  tests: number;
}

/**
 * Raw V8 output → the map, merged into what is already there, raw deleted.
 * Never throws; a fold that cannot finish leaves the raw files for the next.
 */
export async function foldCoverage(repoRoot: string, now = Date.now()): Promise<FoldResult> {
  const result: FoldResult = { folded: 0, deferred: 0, unattributed: 0, tests: 0 };
  const dirs = await coverageDirs(repoRoot, false);
  if (dirs === null) return result;
  const rawDir = dirs.raw;
  let names: string[];
  try {
    names = (await readdir(rawDir)).filter((n) => n.startsWith("coverage-") && n.endsWith(".json"));
  } catch {
    return result;
  }
  if (names.length === 0) return result;

  const map = (await readCoverageMap(repoRoot)) ?? emptyMap();
  const sourceOf = sourceResolver(repoRoot);
  const done: string[] = [];
  for (const name of names) {
    const path = join(rawDir, name);
    const read = await readRawFile(path, now);
    if (read.kind === "skip") {
      result.deferred++;
      continue;
    }
    if (read.kind === "settling") {
      result.deferred++;
      continue;
    }
    if (read.kind === "unreadable") {
      if (read.ageMs > RAW_GIVE_UP_MS) done.push(path);
      else result.deferred++;
      continue;
    }
    if (foldProcess(read.doc, repoRoot, sourceOf, map)) result.folded++;
    else result.unattributed++;
    done.push(path);
  }

  if (result.folded > 0) {
    map.runs += result.folded;
    map.foldedAt = new Date(now).toISOString();
    try {
      await writeMap(repoRoot, map);
    } catch {
      // Leave the raw files; the next fold reads them again.
      return { ...result, deferred: result.deferred + done.length, folded: 0, tests: Object.keys(map.tests).length };
    }
  }
  for (const path of done) {
    try {
      await unlink(path);
    } catch {
      /* already gone */
    }
  }
  result.tests = Object.keys(map.tests).length;
  return result;
}

/** One process's coverage into the map. False when no test file was loaded. */
function foldProcess(
  doc: { result?: RawScript[] },
  repoRoot: string,
  sourceOf: (abs: string) => string,
  map: CoverageMap,
): boolean {
  const perFile = new Map<string, Set<string>>();
  for (const script of doc.result ?? []) {
    if (typeof script.url !== "string" || !script.url.startsWith("file://")) continue;
    let abs: string;
    try {
      abs = fileURLToPath(script.url);
    } catch {
      continue;
    }
    if (abs.includes("/node_modules/")) continue;
    const rel = relative(repoRoot, sourceOf(abs));
    // A path the reader would reject is left out, or one odd file name would
    // void the whole map on every read.
    if (rel.startsWith("..") || isAbsolute(rel) || !isSafeRepoPath(rel)) continue;
    let fns = perFile.get(rel);
    if (fns === undefined) {
      fns = new Set();
      perFile.set(rel, fns);
    }
    for (const fn of script.functions ?? []) {
      if (typeof fn.functionName === "string" && fn.functionName !== "" && (fn.ranges?.[0]?.count ?? 0) > 0) {
        fns.add(fn.functionName);
      }
    }
  }
  const tests = [...perFile.keys()].filter((f) => /\.(test|spec)\./.test(f));
  if (tests.length === 0) return false;
  for (const test of tests) {
    const entry = (map.tests[test] ??= {});
    for (const [file, fns] of perFile) {
      if (file === test) continue;
      entry[file] = [...new Set([...(entry[file] ?? []), ...fns])].sort();
    }
  }
  return true;
}

/**
 * `dist/x.js` → `src/x.ts` through the `.map` beside it, when there is one:
 * the first source that lies inside the repository. File grain on purpose —
 * mapping function offsets through the mappings would be the expensive half
 * of a source-map library for a name V8 already reports.
 */
function sourceResolver(repoRoot: string): (abs: string) => string {
  const cache = new Map<string, string>();
  return (abs) => {
    if (!/\.(js|mjs|cjs)$/.test(abs)) return abs;
    const hit = cache.get(abs);
    if (hit !== undefined) return hit;
    let out = abs;
    try {
      const mapPath = `${abs}.map`;
      const m = JSON.parse(readFileSync(mapPath, "utf8")) as { sources?: string[]; sourceRoot?: string };
      const src = (m.sources ?? [])
        .map((s) => resolve(dirname(mapPath), m.sourceRoot ?? "", s))
        .find((s) => !relative(repoRoot, s).startsWith(".."));
      if (src !== undefined) out = src;
    } catch {
      /* no map, or not one we can read: the .js path stands */
    }
    cache.set(abs, out);
    return out;
  };
}

async function writeMap(repoRoot: string, map: CoverageMap): Promise<void> {
  const dirs = await coverageDirs(repoRoot, true);
  if (dirs === null) throw new Error("coverage map: directory not safe");
  const file = coverageMapFileOf(repoRoot);
  const tmp = `${file}.${process.pid}.tmp`;
  const fh = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW);
  // A temp file left behind (disk full mid-write, a failed rename) would make
  // every later fold fail on O_EXCL and freeze the map while raw output grows.
  let moved = false;
  try {
    try {
      await fh.writeFile(JSON.stringify(map), "utf8");
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
    moved = true;
  } finally {
    if (!moved) await unlink(tmp).catch(() => {});
  }
}

// ─── Scheduling ──────────────────────────────────────────────────

const folds = new Map<string, { timer: NodeJS.Timeout | null; running: boolean; again: boolean }>();

/**
 * One fold per repository after a quiet period; a trigger during a fold
 * books exactly one more. The caller never waits — the refresher's own rule.
 */
export function scheduleCoverageFold(
  repoRoot: string,
  fold: (repoRoot: string) => Promise<unknown> = foldCoverage,
  debounceMs = FOLD_DEBOUNCE_MS,
): void {
  let entry = folds.get(repoRoot);
  if (entry === undefined) {
    entry = { timer: null, running: false, again: false };
    folds.set(repoRoot, entry);
  }
  if (entry.running) {
    entry.again = true;
    return;
  }
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    entry.running = true;
    void fold(repoRoot)
      .catch(() => {})
      .finally(() => {
        entry.running = false;
        if (entry.again) {
          entry.again = false;
          scheduleCoverageFold(repoRoot, fold, debounceMs);
        }
      });
  }, debounceMs);
  entry.timer.unref?.();
}

// ─── Reading in the hook ─────────────────────────────────────────

export interface RankedTest {
  test: string;
  /** Changed functions this test executed. */
  functions: number;
  /** Changed files this test executed. */
  files: number;
  /** Functions of the changed files this test executed, changed or not — how much of them it depends on. */
  exercised: number;
}

/**
 * The tests that ran the changed files, strongest first: by changed functions
 * executed, then by changed files, then by how much of the changed files the
 * test exercised at all, then by name. When the changed functions are known
 * and at least one test ran one of them, tests that merely loaded the file
 * are dropped — that is the file-grain answer the map exists to improve on.
 *
 * The third key is a tiebreak for the common case of ONE changed function
 * that dozens of tests reach: on the lab map, 29 of `packages/core`'s tests
 * ran `SearchIndex`, and the seven that the registered scenario S33 says the
 * change broke sat at positions 11–24 by name. By functions of `search.ts`
 * executed, four of them are in the top six. One case, chosen after seeing
 * it — a diagnostic, not a result.
 */
export function rankTests(map: CoverageMap, changed: ReadonlyMap<string, readonly string[]>): RankedTest[] {
  const ranked: RankedTest[] = [];
  for (const [test, files] of Object.entries(map.tests)) {
    let fnHits = 0;
    let fileHits = 0;
    let exercised = 0;
    for (const [file, names] of changed) {
      const ran = files[file];
      if (ran === undefined) continue;
      fileHits++;
      exercised += ran.length;
      for (const n of names) if (ran.includes(n)) fnHits++;
    }
    if (fileHits > 0) ranked.push({ test, functions: fnHits, files: fileHits, exercised });
  }
  const sharp = ranked.filter((r) => r.functions > 0);
  const kept = sharp.length > 0 ? sharp : ranked;
  return kept.sort(
    (a, b) =>
      b.functions - a.functions ||
      b.files - a.files ||
      b.exercised - a.exercised ||
      a.test.localeCompare(b.test),
  );
}

/**
 * The one line a block gets, or null: tests that ran the changed files,
 * minus the ones the block already names, at most {@link MAX_COVERAGE_TESTS}.
 * A statement, like every other line of the block.
 */
export function coverageTestsLine(
  map: CoverageMap | null,
  changed: ReadonlyMap<string, readonly string[]>,
  alreadyListed: ReadonlySet<string>,
  now = Date.now(),
): string | null {
  if (map === null) return null;
  const ranked = rankTests(map, changed).filter((r) => !alreadyListed.has(r.test));
  if (ranked.length === 0) return null;
  const shown = ranked.slice(0, MAX_COVERAGE_TESTS);
  const rest = ranked.length - shown.length;
  const grain = shown[0]!.functions > 0 ? "the changed functions" : "these files";
  return (
    `Tests that ran ${grain} (coverage map, ${ageOf(map.foldedAt, now)}): ` +
    shown.map((r) => escapeAttr(r.test)).join(", ") +
    (rest > 0 ? `, and ${rest} more` : "") +
    "."
  );
}

/** "2 h old", "3 d old" — enough to tell a fresh map from a forgotten one. */
export function ageOf(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "age unknown";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min old`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h old`;
  return `${Math.round(h / 24)} d old`;
}

/** What the CLI shows: present or not, how many tests, how old. */
export async function coverageMapStatus(repoRoot: string, now = Date.now()): Promise<string> {
  const map = await readCoverageMap(repoRoot);
  const raw = await rawBytesOf(repoRoot);
  const pending = raw > 0 ? `, ${(raw / 1024 / 1024).toFixed(0)} MB of raw output waiting for the next fold` : "";
  if (map === null) return `coverage map: none yet${pending}`;
  const tests = Object.keys(map.tests).length;
  return `coverage map: ${tests} test${tests === 1 ? "" : "s"}, ${map.runs} process${map.runs === 1 ? "" : "es"} folded, ${ageOf(map.foldedAt, now)}${pending}`;
}
