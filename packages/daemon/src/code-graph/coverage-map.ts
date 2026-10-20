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

import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** One rule for what counts as a test, shared with the impact and boundary blocks. */
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
  const dir = coverageDirOf(repoRoot);
  await mkdir(join(dir, RAW_DIR_NAME), { recursive: true });
  const ignore = join(dir, ".gitignore");
  try {
    await stat(ignore);
  } catch {
    await writeFile(ignore, "*\n", "utf8");
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

export interface CoverageMap {
  version: 1;
  /** ISO time of the last fold. */
  foldedAt: string;
  /** Raw files folded in over the map's life. */
  runs: number;
  /** Repo-relative test file → repo-relative source file → executed function names, sorted. */
  tests: Record<string, Record<string, string[]>>;
}

function emptyMap(): CoverageMap {
  return { version: 1, foldedAt: new Date(0).toISOString(), runs: 0, tests: {} };
}

/** The map on disk, or null when there is none or it is unreadable. */
export async function readCoverageMap(repoRoot: string): Promise<CoverageMap | null> {
  try {
    const buf = await readFile(coverageMapFileOf(repoRoot));
    return parseMap(buf.byteLength > MAX_MAP_BYTES ? null : buf.toString("utf8"));
  } catch {
    return null;
  }
}

function parseMap(text: string | null): CoverageMap | null {
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as Partial<CoverageMap>;
    if (raw.version !== 1 || typeof raw.tests !== "object" || raw.tests === null) return null;
    return {
      version: 1,
      foldedAt: typeof raw.foldedAt === "string" ? raw.foldedAt : new Date(0).toISOString(),
      runs: typeof raw.runs === "number" ? raw.runs : 0,
      tests: raw.tests,
    };
  } catch {
    return null;
  }
}

let snapshot: { path: string; mtimeMs: number; size: number; map: CoverageMap | null } | null = null;

/**
 * The map for the hot paths, synchronously, like the enabled-repos snapshot:
 * one `fstat` per call, re-parsed only when the file moved. The Write/Edit
 * lane runs on every write and cannot afford a parse each time.
 */
export function readCoverageMapSync(repoRoot: string): CoverageMap | null {
  const path = coverageMapFileOf(repoRoot);
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    if (snapshot?.path === path) snapshot = null;
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (snapshot?.path === path && snapshot.mtimeMs === st.mtimeMs && snapshot.size === st.size) {
      return snapshot.map;
    }
    const map = st.size > MAX_MAP_BYTES ? null : parseMap(readFileSync(fd, "utf8"));
    snapshot = { path, mtimeMs: st.mtimeMs, size: st.size, map };
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
  const rawDir = coverageRawDirOf(repoRoot);
  const result: FoldResult = { folded: 0, deferred: 0, unattributed: 0, tests: 0 };
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
    let doc: { result?: RawScript[] };
    try {
      const st = await stat(path);
      if (now - st.mtimeMs < RAW_SETTLE_MS) {
        result.deferred++;
        continue;
      }
      doc = JSON.parse(await readFile(path, "utf8")) as { result?: RawScript[] };
    } catch {
      let age = 0;
      try {
        age = now - (await stat(path)).mtimeMs;
      } catch {
        continue;
      }
      if (age > RAW_GIVE_UP_MS) done.push(path);
      else result.deferred++;
      continue;
    }
    if (foldProcess(doc, repoRoot, sourceOf, map)) result.folded++;
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
      await rm(path);
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
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
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
  const file = coverageMapFileOf(repoRoot);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(map), "utf8");
  await rename(tmp, file);
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
    shown.map((r) => r.test).join(", ") +
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
